#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const DESTINATION = 'org.freedesktop.systemd1';
const MANAGER_PATH = '/org/freedesktop/systemd1';
const MANAGER_INTERFACE = 'org.freedesktop.systemd1.Manager';
const SERVICE_INTERFACE = 'org.freedesktop.systemd1.Service';

function fail(message) {
  throw new Error(message);
}

function readTypedJson(output, expectedType, description) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail(`systemd returned malformed structured data for ${description}`);
  }
  if (!parsed || parsed.type !== expectedType || !Object.hasOwn(parsed, 'data')) {
    fail(`systemd returned an unexpected type for ${description}`);
  }
  return parsed.data;
}

function readMethodObjectPath(output, description) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail(`systemd returned malformed structured data for ${description}`);
  }
  if (!parsed || parsed.type !== 'o' || !Array.isArray(parsed.data)) {
    fail(`systemd returned an unexpected signature for ${description}`);
  }
  if (parsed.data.length !== 1) {
    fail(`systemd returned an unexpected argument count for ${description}`);
  }
  const [objectPath] = parsed.data;
  const unitPathPrefix = '/org/freedesktop/systemd1/unit/';
  if (typeof objectPath !== 'string' || !objectPath.startsWith(unitPathPrefix) ||
      !/^[A-Za-z0-9_]+$/.test(objectPath.slice(unitPathPrefix.length))) {
    fail(`systemd returned an invalid unit object path for ${description}`);
  }
  return objectPath;
}

function validateExecProperty(value, expectedPath, expectedArgs, description) {
  if (!Array.isArray(value) || value.length !== 1) {
    fail(`${description} must contain exactly one command`);
  }
  const entry = value[0];
  if (!Array.isArray(entry) || entry.length !== 10) {
    fail(`systemd returned an unexpected serialized command for ${description}`);
  }
  const [path, argv, ignoreErrors] = entry;
  if (path !== expectedPath || !Array.isArray(argv) ||
      argv.length !== expectedArgs.length || argv.some((arg, index) => arg !== expectedArgs[index])) {
    fail(`${description} executable or argument vector does not match the deployment runtime`);
  }
  if (ignoreErrors !== false) {
    fail(`${description} must have ignore_errors=no`);
  }
}

export function validateUnitData(properties, expected) {
  const workingDirectory = readTypedJson(properties.WorkingDirectory, 's', 'WorkingDirectory');
  const execStart = readTypedJson(properties.ExecStart, 'a(sasbttttuii)', 'ExecStart');
  const execStartPre = readTypedJson(properties.ExecStartPre, 'a(sasbttttuii)', 'ExecStartPre');
  const serviceType = readTypedJson(properties.Type, 's', 'Type');
  const restart = readTypedJson(properties.Restart, 's', 'Restart');
  const killMode = readTypedJson(properties.KillMode, 's', 'KillMode');
  const timeoutStopUSec = readTypedJson(properties.TimeoutStopUSec, 't', 'TimeoutStopUSec');
  const sendSIGKILL = readTypedJson(properties.SendSIGKILL, 'b', 'SendSIGKILL');
  const killSignal = readTypedJson(properties.KillSignal, 'i', 'KillSignal');
  const finalKillSignal = readTypedJson(properties.FinalKillSignal, 'i', 'FinalKillSignal');
  const timeoutStopFailureMode = readTypedJson(properties.TimeoutStopFailureMode, 's', 'TimeoutStopFailureMode');
  const environment = readTypedJson(properties.Environment, 'as', 'Environment');
  const environmentFiles = readTypedJson(properties.EnvironmentFiles, 'a(sb)', 'EnvironmentFiles');
  const unsetEnvironment = readTypedJson(properties.UnsetEnvironment, 'as', 'UnsetEnvironment');
  const auxiliaryCommands = [
    'ExecCondition', 'ExecStartPost', 'ExecReload', 'ExecReloadPost', 'ExecStop', 'ExecStopPost',
  ].map((name) => [name, readTypedJson(properties[name], 'a(sasbttttuii)', name)]);

  if (workingDirectory !== expected.runtimeDirectory) {
    fail('loaded systemd WorkingDirectory does not match RUNTIME_DIR');
  }
  validateExecProperty(execStart, expected.nodePath, [
    expected.nodePath,
    `${expected.runtimeDirectory}/scripts/runtime-env.mjs`,
    'start',
    expected.envFile,
    `${expected.runtimeDirectory}/.runtime-env.sha256`,
    expected.runtimeDirectory,
    '127.0.0.1',
    expected.port,
  ], 'ExecStart');
  validateExecProperty(execStartPre, expected.nodePath, [
    expected.nodePath,
    `${expected.runtimeDirectory}/scripts/runtime-env.mjs`,
    'verify',
    expected.envFile,
    `${expected.runtimeDirectory}/.runtime-env.sha256`,
  ], 'ExecStartPre');
  if (serviceType !== 'simple') {
    fail('loaded systemd Type must be simple');
  }
  if (restart !== 'on-failure') {
    fail('loaded systemd Restart policy must be on-failure');
  }
  if (killMode !== 'control-group') {
    fail('loaded systemd KillMode must be control-group so stop terminates all runtime processes');
  }
  if (timeoutStopUSec !== 30_000_000) {
    fail('loaded systemd TimeoutStopSec must be exactly 30 seconds to bound graceful shutdown');
  }
  if (sendSIGKILL !== true || killSignal !== 15 || finalKillSignal !== 9 || timeoutStopFailureMode !== 'terminate') {
    fail('loaded systemd shutdown must use SIGTERM, bounded SIGKILL escalation, and TimeoutStopFailureMode=terminate');
  }
  for (const [name, commands] of auxiliaryCommands) {
    if (!Array.isArray(commands) || commands.length !== 0) {
      fail(`loaded systemd ${name} must be empty; the verified start/stop commands are fixed`);
    }
  }
  if (!Array.isArray(environment) || environment.length !== 0) {
    fail('loaded systemd Environment must be empty; application values use the shared runtime loader');
  }
  if (!Array.isArray(environmentFiles) || environmentFiles.length !== 0) {
    fail('loaded systemd EnvironmentFiles must be empty; application values use the shared runtime loader');
  }
  if (!Array.isArray(unsetEnvironment) || unsetEnvironment.length !== 1 || unsetEnvironment[0] !== 'NODE_OPTIONS') {
    fail('loaded systemd UnsetEnvironment must remove inherited NODE_OPTIONS before starting Node.js');
  }
}

function callBusctl(args, description) {
  const result = spawnSync('busctl', ['--user', '--json=short', ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    fail(`could not read loaded systemd ${description} using the user bus`);
  }
  return result.stdout.trim();
}

function getUnitObjectPath(serviceName) {
  const output = callBusctl([
    'call', DESTINATION, MANAGER_PATH, MANAGER_INTERFACE, 'LoadUnit', 's', serviceName,
  ], `unit object for ${serviceName}`);
  return readMethodObjectPath(output, `LoadUnit method return for ${serviceName}`);
}

function getProperty(objectPath, interfaceName, property) {
  return callBusctl([
    'get-property', DESTINATION, objectPath, interfaceName, property,
  ], property);
}

export function inspectAndValidate(serviceName, expected) {
  const objectPath = getUnitObjectPath(serviceName);
  const properties = {
    WorkingDirectory: getProperty(objectPath, SERVICE_INTERFACE, 'WorkingDirectory'),
    ExecStart: getProperty(objectPath, SERVICE_INTERFACE, 'ExecStart'),
    ExecStartPre: getProperty(objectPath, SERVICE_INTERFACE, 'ExecStartPre'),
    Type: getProperty(objectPath, SERVICE_INTERFACE, 'Type'),
    Restart: getProperty(objectPath, SERVICE_INTERFACE, 'Restart'),
    KillMode: getProperty(objectPath, SERVICE_INTERFACE, 'KillMode'),
    TimeoutStopUSec: getProperty(objectPath, SERVICE_INTERFACE, 'TimeoutStopUSec'),
    SendSIGKILL: getProperty(objectPath, SERVICE_INTERFACE, 'SendSIGKILL'),
    KillSignal: getProperty(objectPath, SERVICE_INTERFACE, 'KillSignal'),
    FinalKillSignal: getProperty(objectPath, SERVICE_INTERFACE, 'FinalKillSignal'),
    TimeoutStopFailureMode: getProperty(objectPath, SERVICE_INTERFACE, 'TimeoutStopFailureMode'),
    ExecCondition: getProperty(objectPath, SERVICE_INTERFACE, 'ExecCondition'),
    ExecStartPost: getProperty(objectPath, SERVICE_INTERFACE, 'ExecStartPost'),
    ExecReload: getProperty(objectPath, SERVICE_INTERFACE, 'ExecReload'),
    ExecReloadPost: getProperty(objectPath, SERVICE_INTERFACE, 'ExecReloadPost'),
    ExecStop: getProperty(objectPath, SERVICE_INTERFACE, 'ExecStop'),
    ExecStopPost: getProperty(objectPath, SERVICE_INTERFACE, 'ExecStopPost'),
    Environment: getProperty(objectPath, SERVICE_INTERFACE, 'Environment'),
    EnvironmentFiles: getProperty(objectPath, SERVICE_INTERFACE, 'EnvironmentFiles'),
    UnsetEnvironment: getProperty(objectPath, SERVICE_INTERFACE, 'UnsetEnvironment'),
  };
  validateUnitData(properties, expected);
}

function main(args) {
  if (args.length !== 5) {
    fail('usage: systemd-unit-preflight.mjs <service> <runtime-dir> <env-file> <service-port> <node-path>');
  }
  const [serviceName, runtimeDirectory, envFile, port, nodePath] = args;
  inspectAndValidate(serviceName, { runtimeDirectory, envFile, port, nodePath });
}

try {
  main(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : 'systemd unit preflight failed';
  process.stderr.write(`deploy: ${message}\n`);
  process.exitCode = 1;
}
