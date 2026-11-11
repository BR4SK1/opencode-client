#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { open, lstat, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const phases = new Set([
  'prepared', 'stop-requested', 'quiescent', 'previous-moved', 'new-promoted',
  'new-started', 'verified', 'rolling-back', 'rolled-back',
]);

function fail(message) {
  throw new Error(message);
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validatePath(markerPath) {
  if (!path.isAbsolute(markerPath ?? '')) fail('transaction marker path must be absolute');
  return path.resolve(markerPath);
}

function validateMarker(value, expectedId = null) {
  if (!value || value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.id ?? '') ||
      !phases.has(value.phase) || !path.isAbsolute(value.runtimeDir) ||
      !path.isAbsolute(value.stageDir) || !path.isAbsolute(value.backupDir) ||
      !/^[a-f0-9]{40,64}$/.test(value.sourceRevision ?? '') ||
      typeof value.hadRuntime !== 'boolean' || typeof value.restoreService !== 'boolean' ||
      (expectedId !== null && value.id !== expectedId)) {
    fail('transaction marker is malformed or belongs to another transaction');
  }
  if (path.dirname(value.runtimeDir) !== path.dirname(value.backupDir) ||
      path.basename(value.backupDir) !== `.opencode-client-previous.${value.id}`) {
    fail('transaction marker contains an unsafe backup path');
  }
  if (!value.hadRuntime && value.oldTreeDigest !== null) fail('transaction marker has unexpected previous-runtime metadata');
  for (const digest of [value.oldTreeDigest, value.newTreeDigest]) {
    if (digest !== null && !/^[a-f0-9]{64}$/.test(digest)) fail('transaction marker contains an invalid inventory digest');
  }
  return value;
}

async function readMarker(markerPath, expectedId = null) {
  const resolved = validatePath(markerPath);
  const stat = await lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    fail('transaction marker ownership or permissions are unsafe');
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, 'utf8'));
  } catch {
    fail('transaction marker cannot be parsed; refusing an automatic retry');
  }
  return validateMarker(parsed, expectedId);
}

async function writeAtomic(markerPath, marker) {
  const resolved = validatePath(markerPath);
  const directory = path.dirname(resolved);
  const temporaryPath = `${resolved}.tmp.${marker.id}`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, resolved);
  await fsyncDirectory(directory);
}

async function create(args) {
  const [markerPath, id, runtimeDir, stageDir, backupDir, sourceRevision, hadRuntimeText, restoreServiceText] = args;
  if (!/^[a-f0-9]{32}$/.test(id ?? '') || !path.isAbsolute(runtimeDir ?? '') ||
      !path.isAbsolute(stageDir ?? '') || !path.isAbsolute(backupDir ?? '') ||
      !/^[a-f0-9]{40,64}$/.test(sourceRevision ?? '') ||
      !['true', 'false'].includes(hadRuntimeText) || !['true', 'false'].includes(restoreServiceText)) {
    fail('invalid arguments for transaction marker creation');
  }
  const marker = validateMarker({
    version: 1,
    id,
    phase: 'prepared',
    runtimeDir,
    stageDir,
    backupDir,
    sourceRevision,
    hadRuntime: hadRuntimeText === 'true',
    restoreService: restoreServiceText === 'true',
    oldTreeDigest: null,
    newTreeDigest: null,
  });
  const resolved = validatePath(markerPath);
  const handle = await open(resolved, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(marker)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(path.dirname(resolved));
}

async function update(args) {
  const [markerPath, id, phase, oldTreeDigest = '-', newTreeDigest = '-'] = args;
  if (!phases.has(phase)) fail('invalid transaction phase');
  const marker = await readMarker(markerPath, id);
  marker.phase = phase;
  marker.oldTreeDigest = oldTreeDigest === '-' ? marker.oldTreeDigest : oldTreeDigest;
  marker.newTreeDigest = newTreeDigest === '-' ? marker.newTreeDigest : newTreeDigest;
  validateMarker(marker, id);
  await writeAtomic(markerPath, marker);
}

async function inspect(markerPath) {
  const marker = await readMarker(markerPath);
  process.stdout.write(`${JSON.stringify({
    id: marker.id,
    phase: marker.phase,
    runtimeDir: marker.runtimeDir,
    stageDir: marker.stageDir,
    backupDir: marker.backupDir,
    hadRuntime: marker.hadRuntime,
    restoreService: marker.restoreService,
  })}\n`);
}

async function remove(markerPath, id) {
  const marker = await readMarker(markerPath, id);
  const resolved = validatePath(markerPath);
  const temporaryPath = `${resolved}.tmp.${marker.id}`;
  try {
    const tempStat = await lstat(temporaryPath);
    if (!tempStat.isFile() || tempStat.isSymbolicLink() || tempStat.uid !== process.getuid() || (tempStat.mode & 0o077) !== 0) {
      fail('transaction marker temporary file ownership or permissions are unsafe');
    }
    await unlink(temporaryPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await unlink(resolved);
  await fsyncDirectory(path.dirname(resolved));
}

async function main(args) {
  const [operation, ...rest] = args;
  if (operation === 'new-id') {
    process.stdout.write(`${randomBytes(16).toString('hex')}\n`);
    return;
  }
  if (operation === 'create') return create(rest);
  if (operation === 'update') return update(rest);
  if (operation === 'inspect') return inspect(rest[0]);
  if (operation === 'remove') return remove(rest[0], rest[1]);
  fail('usage: deploy-transaction.mjs <new-id|create|update|inspect|remove> ...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : 'deployment transaction marker operation failed';
    process.stderr.write(`deploy: ${message}\n`);
    process.exitCode = 1;
  });
}
