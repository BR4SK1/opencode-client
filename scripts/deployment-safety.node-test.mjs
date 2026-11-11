import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertNoMountTargetsUnder, inspectRuntimeTree, removeRuntimeTree } from './runtime-tree-safety.mjs';
import { assertServiceQuiescent } from './systemd-service-quiescence.mjs';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-deployment-safety-test.'));
after(async () => rm(tempRoot, { recursive: true, force: true }));

function transaction(args) {
  return spawnSync(process.execPath, [path.join(scriptsDirectory, 'deploy-transaction.mjs'), ...args], { encoding: 'utf8' });
}

test('transaction marker is durable, transaction-specific, and removed only by its identity', async () => {
  const home = path.join(tempRoot, 'marker-home');
  const runtime = path.join(home, 'opencode-client-runtime');
  const stage = path.join(home, '.opencode-client-stage.fixture');
  const id = 'a'.repeat(32);
  const revision = 'b'.repeat(40);
  const marker = path.join(home, '.opencode-client-deploy.transaction.json');
  await mkdir(home, { recursive: true });

  const created = transaction(['create', marker, id, runtime, stage, path.join(home, `.opencode-client-previous.${id}`), revision, 'true', 'true']);
  assert.equal(created.status, 0, created.stderr);
  const prepared = JSON.parse((await readFile(marker, 'utf8')));
  assert.equal(prepared.phase, 'prepared');
  assert.equal(prepared.id, id);
  assert.equal(prepared.backupDir, path.join(home, `.opencode-client-previous.${id}`));

  const wrongId = transaction(['update', marker, 'c'.repeat(32), 'quiescent']);
  assert.notEqual(wrongId.status, 0);
  const updated = transaction(['update', marker, id, 'quiescent', 'd'.repeat(64), 'e'.repeat(64)]);
  assert.equal(updated.status, 0, updated.stderr);
  const inspected = transaction(['inspect', marker]);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).phase, 'quiescent');
  assert.equal(transaction(['remove', marker, id]).status, 0);
  await assert.rejects(readFile(marker));
});

test('runtime inventory rejects changes and symlink-safe removal does not follow targets', async () => {
  const home = path.join(tempRoot, 'tree-home');
  const runtime = path.join(home, 'opencode-client-runtime');
  const outside = path.join(home, 'outside.txt');
  await mkdir(path.join(runtime, 'node_modules'), { recursive: true });
  await writeFile(path.join(runtime, 'source.js'), 'owned runtime content');
  await writeFile(outside, 'unrelated data');
  await symlink(outside, path.join(runtime, 'node_modules', 'external-link'));

  const original = await inspectRuntimeTree(runtime, process.getuid());
  await writeFile(path.join(runtime, 'source.js'), 'changed after transaction inventory');
  await assert.rejects(removeRuntimeTree(runtime, process.getuid(), original), /no longer matches/);
  assert.equal(await readFile(outside, 'utf8'), 'unrelated data');

  const updated = await inspectRuntimeTree(runtime, process.getuid());
  await removeRuntimeTree(runtime, process.getuid(), updated);
  assert.equal(await readFile(outside, 'utf8'), 'unrelated data');
});

test('runtime inventory rejects entries that do not belong to the service uid', async () => {
  const runtime = path.join(tempRoot, 'foreign-owner-runtime');
  await mkdir(runtime, { recursive: true });
  await writeFile(path.join(runtime, 'owned.js'), 'content');
  await assert.rejects(inspectRuntimeTree(runtime, process.getuid() + 1), /not owned by service uid/);
});

test('runtime deletion guard rejects any nested mount target', () => {
  const root = '/home/example/runtime';
  assert.doesNotThrow(() => assertNoMountTargetsUnder(root, ['/sys/fs/cgroup', '/home/example']));
  assert.throws(() => assertNoMountTargetsUnder(root, ['/home/example/runtime/cache']), /mount point/);
  assert.throws(() => assertNoMountTargetsUnder(root, [root]), /mount point/);
});

test('the real quiescence CLI uses authentic systemd interfaces and accepts a released cgroup', async () => {
  const binDirectory = path.join(tempRoot, 'systemd-transport', 'bin');
  const busctlPath = path.join(binDirectory, 'busctl');
  const callsLog = path.join(tempRoot, 'systemd-transport', 'calls.jsonl');
  await mkdir(binDirectory, { recursive: true });
  await writeFile(busctlPath, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== '--user' || args[1] !== '--json=short') process.exit(90);
const [operation, destination, objectPath, interfaceName, member] = args.slice(2);
const log = (value) => fs.appendFileSync(process.env.MOCK_BUS_LOG, JSON.stringify(value) + '\\n');
if (operation === 'call' && destination === 'org.freedesktop.systemd1' &&
    objectPath === '/org/freedesktop/systemd1' && interfaceName === 'org.freedesktop.systemd1.Manager' && member === 'LoadUnit') {
  log({ operation, interfaceName, member });
  process.stdout.write(JSON.stringify({ type: 'o', data: ['/org/freedesktop/systemd1/unit/opencode_2dclient_2eservice'] }) + '\\n');
} else if (operation === 'call' && destination === 'org.freedesktop.systemd1' &&
    objectPath === '/org/freedesktop/systemd1' && interfaceName === 'org.freedesktop.systemd1.Manager' && member === 'ListJobs') {
  log({ operation, interfaceName, member });
  const data = process.env.MOCK_JOBS_REPLY
    ? JSON.parse(process.env.MOCK_JOBS_REPLY)
    : [JSON.parse(process.env.MOCK_JOBS || '[]')];
  process.stdout.write(JSON.stringify({ type: 'a(usssoo)', data }) + '\\n');
} else if (operation === 'get-property' && destination === 'org.freedesktop.systemd1' &&
    objectPath === '/org/freedesktop/systemd1/unit/opencode_2dclient_2eservice') {
  log({ operation, interfaceName, member });
  const unitProps = new Set(['ActiveState', 'SubState', 'Job']);
  const expectedInterface = unitProps.has(member)
    ? 'org.freedesktop.systemd1.Unit'
    : 'org.freedesktop.systemd1.Service';
  if (interfaceName !== expectedInterface) {
    process.stderr.write('wrong property interface for ' + member + ': ' + interfaceName + '\\n');
    process.exit(91);
  }
  const props = {
    ActiveState: ['s', process.env.MOCK_ACTIVE_STATE || 'failed'],
    SubState: ['s', process.env.MOCK_SUB_STATE || 'failed'],
    Job: ['(uo)', JSON.parse(process.env.MOCK_UNIT_JOB || '[0,"/"]')],
    ControlGroup: ['s', process.env.MOCK_CONTROL_GROUP ?? ''],
    MainPID: ['u', Number(process.env.MOCK_MAIN_PID || '0')],
  };
  const property = props[member];
  if (!property) process.exit(92);
  process.stdout.write(JSON.stringify({ type: property[0], data: property[1] }) + '\\n');
} else {
  process.stderr.write('unexpected busctl command: ' + args.join(' ') + '\\n');
  process.exit(93);
}
`);
  await chmod(busctlPath, 0o755);

  const runCli = (extraEnv = {}) => spawnSync(process.execPath, [
    path.join(scriptsDirectory, 'systemd-service-quiescence.mjs'), 'opencode-client.service',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      MOCK_BUS_LOG: callsLog,
      ...extraEnv,
    },
  });

  const result = runCli();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^quiescent failed \n$/);
  const calls = (await readFile(callsLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(calls.some((call) => call.member === 'ListJobs' && call.interfaceName === 'org.freedesktop.systemd1.Manager'));
  for (const property of ['ActiveState', 'SubState', 'Job']) {
    assert.ok(calls.filter((call) => call.member === property).every((call) => call.interfaceName === 'org.freedesktop.systemd1.Unit'));
  }
  for (const property of ['ControlGroup', 'MainPID']) {
    assert.ok(calls.filter((call) => call.member === property).every((call) => call.interfaceName === 'org.freedesktop.systemd1.Service'));
  }

  const pending = runCli({
    MOCK_JOBS: JSON.stringify([[1, 'opencode-client.service', 'stop', 'running', '/job/1', '/unit']]),
  });
  assert.notEqual(pending.status, 0);
  assert.match(pending.stderr, /pending job/);

  const malformed = runCli({ MOCK_JOBS_REPLY: '[]' });
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /malformed ListJobs method arguments/);

  const activeReleased = runCli({ MOCK_ACTIVE_STATE: 'active', MOCK_SUB_STATE: 'running' });
  assert.notEqual(activeReleased.status, 0);
  assert.match(activeReleased.stderr, /service state is not quiescent/);
});

test('failed systemd units are safe only when no job, main PID, or cgroup process remains', async () => {
  const cgroupRoot = path.join(tempRoot, 'cgroup');
  const serviceCgroup = path.join(cgroupRoot, 'user.slice', 'opencode-client.service');
  await mkdir(serviceCgroup, { recursive: true });
  await writeFile(path.join(cgroupRoot, 'cgroup.controllers'), 'cpu memory pids\n');
  await writeFile(path.join(serviceCgroup, 'cgroup.procs'), '\n');
  const state = {
    serviceName: 'opencode-client.service',
    activeState: 'failed',
    subState: 'failed',
    job: [0, '/'],
    controlGroup: '/user.slice/opencode-client.service',
    mainPid: 0,
  };

  await assertServiceQuiescent(state, [], cgroupRoot);
  await writeFile(path.join(serviceCgroup, 'cgroup.procs'), '31002\n');
  await assert.rejects(assertServiceQuiescent(state, [], cgroupRoot), /cgroup still contains/);
  await writeFile(path.join(serviceCgroup, 'cgroup.procs'), '\n');
  await mkdir(path.join(serviceCgroup, 'child.slice'), { recursive: true });
  await writeFile(path.join(serviceCgroup, 'child.slice', 'cgroup.procs'), '31003\n');
  await assert.rejects(assertServiceQuiescent(state, [], cgroupRoot), /cgroup still contains/);
  await writeFile(path.join(serviceCgroup, 'child.slice', 'cgroup.procs'), '\n');
  await assert.rejects(assertServiceQuiescent(state, [[1, 'opencode-client.service', 'start', 'running', '/job/1', '/unit']], cgroupRoot), /pending job/);
  await assert.rejects(assertServiceQuiescent({ ...state, job: [1, '/job/1'] }, [], cgroupRoot), /pending systemd job/);
  await assert.rejects(assertServiceQuiescent({ ...state, mainPid: 31004 }, [], cgroupRoot), /main process/);
});
