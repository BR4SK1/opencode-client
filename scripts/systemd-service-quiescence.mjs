#!/usr/bin/env node
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DESTINATION = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const MANAGER_INTERFACE = 'org.freedesktop.systemd1.Manager';
const UNIT_INTERFACE = 'org.freedesktop.systemd1.Unit';
const SERVICE_INTERFACE = 'org.freedesktop.systemd1.Service';
const CGROUP_ROOT = '/sys/fs/cgroup';

function fail(message) {
  throw new Error(message);
}

function parseTypedJson(output, expectedType, description) {
  let value;
  try {
    value = JSON.parse(output);
  } catch {
    fail(`systemd returned malformed data for ${description}`);
  }
  if (!value || value.type !== expectedType || !Object.hasOwn(value, 'data')) {
    fail(`systemd returned an unexpected type for ${description}`);
  }
  return value.data;
}

function callBusctl(args, description) {
  const result = spawnSync('busctl', ['--user', '--json=short', ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) fail(`could not read systemd ${description}`);
  return result.stdout.trim();
}

function getObjectPath(serviceName) {
  const output = callBusctl([
    'call', DESTINATION, MANAGER_PATH, MANAGER_INTERFACE, 'LoadUnit', 's', serviceName,
  ], `unit object for ${serviceName}`);
  let response;
  try {
    response = JSON.parse(output);
  } catch {
    fail('systemd returned malformed unit object data');
  }
  if (!response || response.type !== 'o' || !Array.isArray(response.data) || response.data.length !== 1 ||
      typeof response.data[0] !== 'string' || !/^\/org\/freedesktop\/systemd1\/unit\/[A-Za-z0-9_]+$/.test(response.data[0])) {
    fail('systemd returned an invalid unit object path');
  }
  return response.data[0];
}

function getProperty(objectPath, name, type) {
  const interfaceName = ['ActiveState', 'SubState', 'Job'].includes(name) ? UNIT_INTERFACE : SERVICE_INTERFACE;
  return parseTypedJson(callBusctl([
    'get-property', DESTINATION, objectPath, interfaceName, name,
  ], name), type, name);
}

function listJobs() {
  const argumentsList = parseTypedJson(callBusctl([
    'call', DESTINATION, MANAGER_PATH, MANAGER_INTERFACE, 'ListJobs',
  ], 'pending jobs'), 'a(usssoo)', 'pending jobs');
  if (!Array.isArray(argumentsList) || argumentsList.length !== 1 || !Array.isArray(argumentsList[0])) {
    fail('systemd returned malformed ListJobs method arguments');
  }
  return argumentsList[0];
}

function decodeMountPath(value) {
  return value.replace(/\\(040|011|012|134)/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function validateNoPendingJob(snapshot, jobs) {
  if (!Array.isArray(snapshot.job) || snapshot.job.length !== 2 || snapshot.job[0] !== 0 || snapshot.job[1] !== '/') {
    fail('service has a pending systemd job');
  }
  if (!Array.isArray(jobs)) fail('systemd returned a malformed pending-job list');
  for (const job of jobs) {
    if (!Array.isArray(job) || job.length !== 6 || !Number.isInteger(job[0]) ||
        typeof job[1] !== 'string' || typeof job[2] !== 'string' || typeof job[3] !== 'string' ||
        typeof job[4] !== 'string' || typeof job[5] !== 'string') {
      fail('systemd returned a malformed pending-job entry');
    }
    if (job[1] === snapshot.serviceName) fail('systemd has a pending job for the service');
  }
}

async function scanCgroup(controlGroup, cgroupRoot) {
  if (typeof controlGroup !== 'string') fail('systemd returned an invalid ControlGroup value');
  if (controlGroup === '') return { root: null, target: null, pids: [] };
  const root = await realpath(cgroupRoot);
  await readFile(path.join(root, 'cgroup.controllers'), 'utf8').catch(() => fail('cannot verify a unified cgroup v2 hierarchy'));
  if (!controlGroup.startsWith('/') ||
      controlGroup.split('/').some((part) => part === '.' || part === '..')) {
    fail('systemd returned an unsafe ControlGroup path');
  }
  const target = path.resolve(root, `.${controlGroup}`);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) fail('ControlGroup resolves outside the cgroup root');

  let targetReal;
  try {
    targetReal = await realpath(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return { root, target, pids: [] };
    fail('cannot resolve the service cgroup');
  }
  if (targetReal !== target) fail('service cgroup resolves through an unexpected symlink');

  const mountInfo = await readFile('/proc/self/mountinfo', 'utf8').catch(() => fail('cannot verify cgroup mount boundaries'));
  const mountTargets = mountInfo.split('\n').filter(Boolean).map((line) => {
    const fields = line.split(' ');
    if (fields.length < 5) fail('malformed mount information');
    return decodeMountPath(fields[4]);
  });
  if (mountTargets.some((mount) => mount === target || mount.startsWith(`${target}${path.sep}`))) {
    fail('service cgroup is covered by a nested mount');
  }

  const pids = [];
  async function visit(directory) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('service cgroup contains an unexpected non-directory');
    const processList = await readFile(path.join(directory, 'cgroup.procs'), 'utf8')
      .catch(() => fail('cannot read service cgroup process list'));
    for (const pid of processList.trim().split(/\s+/).filter(Boolean)) {
      if (!/^\d+$/.test(pid)) fail('service cgroup process list is malformed');
      pids.push(pid);
    }
    for (const name of await readdir(directory)) {
      const child = path.join(directory, name);
      const childStat = await lstat(child);
      if (childStat.isDirectory() && !childStat.isSymbolicLink()) await visit(child);
    }
  }
  await visit(targetReal);
  return { root, target, pids };
}

export async function assertServiceQuiescent(snapshot, jobs, cgroupRoot = CGROUP_ROOT) {
  if (!['inactive', 'failed'].includes(snapshot.activeState)) {
    fail(`service state is not quiescent (${snapshot.activeState}/${snapshot.subState})`);
  }
  validateNoPendingJob(snapshot, jobs);
  if (snapshot.mainPid !== 0) fail('systemd still reports a main process');
  const scan = await scanCgroup(snapshot.controlGroup, cgroupRoot);
  if (scan.pids.length !== 0) fail(`service cgroup still contains ${scan.pids.length} process(es)`);
  return scan;
}

async function snapshot(serviceName) {
  const objectPath = getObjectPath(serviceName);
  return {
    serviceName,
    activeState: getProperty(objectPath, 'ActiveState', 's'),
    subState: getProperty(objectPath, 'SubState', 's'),
    job: getProperty(objectPath, 'Job', '(uo)'),
    controlGroup: getProperty(objectPath, 'ControlGroup', 's'),
    mainPid: getProperty(objectPath, 'MainPID', 'u'),
  };
}

export async function verifyServiceQuiescent(serviceName) {
  const first = await snapshot(serviceName);
  await assertServiceQuiescent(first, listJobs());
  const second = await snapshot(serviceName);
  await assertServiceQuiescent(second, listJobs());
  if (first.activeState !== second.activeState || first.subState !== second.subState ||
      first.job[0] !== second.job[0] || first.job[1] !== second.job[1] ||
      first.controlGroup !== second.controlGroup || first.mainPid !== second.mainPid) {
    fail('systemd service state changed during quiescence verification');
  }
  return second;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [serviceName] = process.argv.slice(2);
  if (!serviceName) {
    process.stderr.write('deploy: usage: systemd-service-quiescence.mjs <service-name>\n');
    process.exitCode = 2;
  } else {
    verifyServiceQuiescent(serviceName).then(
      (state) => process.stdout.write(`quiescent ${state.activeState} ${state.controlGroup}\n`),
      (error) => {
        const message = error instanceof Error ? error.message : 'service quiescence could not be verified';
        process.stderr.write(`deploy: ${message}\n`);
        process.exitCode = 1;
      },
    );
  }
}
