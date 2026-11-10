import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { parseEnvBuffer } from './runtime-env.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-runtime-env-test.'));
after(async () => rm(tempRoot, { recursive: true, force: true }));

const fixtureEnv = [
  '# strict shared build/runtime contract',
  'CONTRACT_TOKEN=Basic token$and=value',
  'CONTRACT_URL=https://issuer.example.invalid/tenant?a=b',
  'CONTRACT_QUOTED="literal # characters with spaces"',
  "CONTRACT_SINGLE='single quoted value'",
  'CONTRACT_EMPTY=',
  '',
].join('\n');
const expectedValues = {
  CONTRACT_TOKEN: 'Basic token$and=value',
  CONTRACT_URL: 'https://issuer.example.invalid/tenant?a=b',
  CONTRACT_QUOTED: 'literal # characters with spaces',
  CONTRACT_SINGLE: 'single quoted value',
  CONTRACT_EMPTY: '',
};

function runHelper(args, extraEnv = {}) {
  return spawnSync(process.execPath, [
    path.join(scriptDirectory, 'runtime-env.mjs'),
    ...args,
  ], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  });
}

test('shared parser preserves literal dollars, equals, quotes, spaces, comments, and empty values', () => {
  assert.deepEqual({ ...parseEnvBuffer(Buffer.from(fixtureEnv)) }, expectedValues);
});

test('parser rejects duplicate and deployment-controlled keys without echoing values', () => {
  assert.throws(() => parseEnvBuffer(Buffer.from('SECRET=safe\nSECRET=do-not-print\n')), /defines SECRET more than once/);
  assert.throws(() => parseEnvBuffer(Buffer.from('NODE_ENV=development\n')), /deployment-controlled variable NODE_ENV/);
  assert.throws(() => parseEnvBuffer(Buffer.from('TOKEN="unterminated\n')), /unsupported quoted value for TOKEN/);
});

test('dependency/lint tools run with the same controlled Node environment and no application values', async () => {
  const root = path.join(tempRoot, 'tool');
  const toolDir = path.join(root, 'work');
  await mkdir(toolDir, { recursive: true });
  const probe = path.join(root, 'probe.cjs');
  const capture = path.join(root, 'captured.json');
  await writeFile(probe, `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
      home: process.env.HOME,
      nodeEnv: process.env.NODE_ENV,
      appValue: process.env.CONTRACT_TOKEN,
      managerValue: process.env.MANAGER_ONLY,
      path: process.env.PATH,
    }));
  `);
  const result = runHelper([
    'tool', toolDir, '--', process.execPath, probe,
  ], { MANAGER_ONLY: 'must-not-leak', CONTRACT_TOKEN: 'must-not-leak' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), {
    home: root,
    nodeEnv: 'production',
    path: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  });
});

test('the build child receives actual shared-parser values, not inherited manager values', async () => {
  const root = path.join(tempRoot, 'build');
  const buildDir = path.join(root, 'work');
  await mkdir(buildDir, { recursive: true });
  const envFile = path.join(root, 'config.env');
  const probe = path.join(root, 'probe.cjs');
  const capture = path.join(root, 'captured.json');
  await writeFile(envFile, fixtureEnv);
  await writeFile(probe, `
    const fs = require('node:fs');
    const names = ${JSON.stringify(Object.keys(expectedValues))};
    const values = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
      values,
      home: process.env.HOME,
      nodeEnv: process.env.NODE_ENV,
      leakedManagerValue: process.env.MANAGER_ONLY,
      path: process.env.PATH,
    }));
  `);

  const result = runHelper([
    'build', envFile, buildDir, '--', process.execPath, probe,
  ], { MANAGER_ONLY: 'must-not-leak', CONTRACT_TOKEN: 'manager-value' });
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(captured.values, expectedValues);
  assert.equal(captured.home, root);
  assert.equal(captured.nodeEnv, 'production');
  assert.equal(captured.leakedManagerValue, undefined);
  assert.equal(captured.path, '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin');
  assert.equal(result.stdout.includes(expectedValues.CONTRACT_TOKEN), false);
  assert.equal(result.stderr.includes(expectedValues.CONTRACT_TOKEN), false);
});

test('runtime start receives the same parsed values and refuses checksum drift', async () => {
  const root = path.join(tempRoot, 'runtime');
  const runtimeDir = path.join(root, 'opencode-client-runtime');
  const envFile = path.join(root, 'config.env');
  const checksumFile = path.join(runtimeDir, '.runtime-env.sha256');
  const nextBin = path.join(runtimeDir, 'node_modules/next/dist/bin/next');
  const capture = path.join(runtimeDir, 'captured.json');
  await mkdir(path.dirname(nextBin), { recursive: true });
  await writeFile(envFile, fixtureEnv);
  const checksum = createHash('sha256').update(fixtureEnv).digest('hex');
  await writeFile(checksumFile, `${checksum}\n`);
  await writeFile(nextBin, `
    const fs = require('node:fs');
    const names = ${JSON.stringify(Object.keys(expectedValues))};
    const values = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    fs.writeFileSync('captured.json', JSON.stringify({
      values,
      home: process.env.HOME,
      nodeEnv: process.env.NODE_ENV,
      leakedManagerValue: process.env.MANAGER_ONLY,
      args: process.argv.slice(2),
    }));
  `);

  const result = runHelper([
    'start', envFile, checksumFile, runtimeDir, '127.0.0.1', '5115',
  ], { MANAGER_ONLY: 'must-not-leak', CONTRACT_TOKEN: 'manager-value' });
  assert.equal(result.status, 0, result.stderr);
  const captured = JSON.parse(await readFile(capture, 'utf8'));
  assert.deepEqual(captured.values, expectedValues);
  assert.equal(captured.home, root);
  assert.equal(captured.nodeEnv, 'production');
  assert.equal(captured.leakedManagerValue, undefined);
  assert.deepEqual(captured.args, ['start', '--hostname', '127.0.0.1', '--port', '5115']);

  await writeFile(envFile, `${fixtureEnv}CHANGED=yes\n`);
  const drift = runHelper(['start', envFile, checksumFile, runtimeDir, '127.0.0.1', '5115']);
  assert.notEqual(drift.status, 0);
  assert.match(drift.stderr, /differs from the configuration used to build this runtime/);
  assert.equal(drift.stderr.includes(expectedValues.CONTRACT_TOKEN), false);
});
