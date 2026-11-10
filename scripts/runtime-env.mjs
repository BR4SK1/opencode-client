#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CONTROLLED_KEYS = new Set(['HOME', 'NODE_ENV', 'NODE_OPTIONS', 'PATH']);
const SERVICE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

function fail(message) {
  throw new Error(message);
}

export function parseEnvBuffer(buffer) {
  const text = buffer.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(buffer)) {
    fail('ENV_FILE must be valid UTF-8');
  }
  if (text.includes('\0')) {
    fail('ENV_FILE must not contain NUL bytes');
  }

  const values = Object.create(null);
  const lines = text.split(/\r?\n/);
  for (const [index, originalLine] of lines.entries()) {
    const line = originalLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!assignment) {
      fail(`ENV_FILE has an invalid assignment on line ${index + 1}`);
    }

    const [, key, rawValue] = assignment;
    if (CONTROLLED_KEYS.has(key)) {
      fail(`ENV_FILE must not set deployment-controlled variable ${key}`);
    }
    if (Object.hasOwn(values, key)) {
      fail(`ENV_FILE defines ${key} more than once`);
    }

    let value = rawValue.trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      if (value.length < 2 || value.at(-1) !== quote || value.slice(1, -1).includes(quote)) {
        fail(`ENV_FILE has an unsupported quoted value for ${key} on line ${index + 1}`);
      }
      value = value.slice(1, -1);
    } else if (value.includes('"') || value.includes("'")) {
      fail(`ENV_FILE has an unsupported quote in ${key} on line ${index + 1}`);
    }

    values[key] = value;
  }
  return values;
}

async function readConfig(envFile, checksumFile) {
  let bytes;
  try {
    bytes = await readFile(envFile);
  } catch {
    fail('could not read ENV_FILE');
  }
  const values = parseEnvBuffer(bytes);

  if (checksumFile) {
    let expected;
    try {
      expected = (await readFile(checksumFile, 'utf8')).trim();
    } catch {
      fail('runtime environment checksum metadata is missing or unreadable');
    }
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      fail('runtime environment checksum metadata is invalid');
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) {
      fail('ENV_FILE differs from the configuration used to build this runtime');
    }
  }
  return values;
}

function appEnvironment(values, home) {
  return {
    HOME: home,
    NODE_ENV: 'production',
    PATH: SERVICE_PATH,
    ...values,
  };
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let childSignal = null;
    const forward = (signal) => {
      childSignal = signal;
      if (child.pid) child.kill(signal);
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) process.on(signal, forward);

    child.once('error', () => {
      for (const signal of signals) process.off(signal, forward);
      reject(new Error(`could not execute ${path.basename(command)}`));
    });
    child.once('close', (code, signal) => {
      for (const caught of signals) process.off(caught, forward);
      if (code !== null) {
        resolve(code);
      } else if (signal || childSignal) {
        resolve(128 + (signalNumber(signal ?? childSignal) || 1));
      } else {
        resolve(1);
      }
    });
  });
}

function signalNumber(signal) {
  return { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal] ?? 0;
}

async function main(argv) {
  const [mode, ...args] = argv;
  if (mode === 'validate') {
    if (args.length !== 1) fail('usage: runtime-env.mjs validate <env-file>');
    await readConfig(args[0]);
    return 0;
  }

  if (mode === 'verify') {
    if (args.length !== 2) fail('usage: runtime-env.mjs verify <env-file> <checksum-file>');
    await readConfig(args[0], args[1]);
    return 0;
  }

  if (mode === 'tool' || mode === 'build') {
    let envFile;
    let workingDirectory;
    let commandIndex;
    if (mode === 'build') {
      if (args.length < 4 || args[2] !== '--') {
        fail('usage: runtime-env.mjs build <env-file> <working-directory> -- <command> [args...]');
      }
      [envFile, workingDirectory] = args;
      commandIndex = 3;
    } else {
      if (args.length < 3 || args[1] !== '--') {
        fail('usage: runtime-env.mjs tool <working-directory> -- <command> [args...]');
      }
      [workingDirectory] = args;
      commandIndex = 2;
    }
    const command = args[commandIndex];
    const commandArgs = args.slice(commandIndex + 1);
    if (!path.isAbsolute(command)) fail('build tool command must be an absolute path');
    const values = mode === 'build' ? await readConfig(envFile) : Object.create(null);
    return run(command, commandArgs, {
      cwd: workingDirectory,
      env: appEnvironment(values, path.dirname(workingDirectory)),
      stdio: 'inherit',
    });
  }

  if (mode === 'start') {
    if (args.length !== 5) {
      fail('usage: runtime-env.mjs start <env-file> <checksum-file> <runtime-directory> <hostname> <port>');
    }
    const [envFile, checksumFile, runtimeDirectory, hostname, port] = args;
    if (hostname !== '127.0.0.1' || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) {
      fail('runtime host or port is invalid');
    }
    const values = await readConfig(envFile, checksumFile);
    const nextExecutable = path.join(runtimeDirectory, 'node_modules/next/dist/bin/next');
    const result = await run(process.execPath, [nextExecutable, 'start', '--hostname', hostname, '--port', port], {
      cwd: runtimeDirectory,
      env: appEnvironment(values, path.dirname(runtimeDirectory)),
      stdio: 'inherit',
    });
    return result;
  }

  fail('usage: runtime-env.mjs <validate|verify|tool|build|start> ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error) => {
      const message = error instanceof Error ? error.message : 'runtime environment setup failed';
      process.stderr.write(`runtime-env: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
