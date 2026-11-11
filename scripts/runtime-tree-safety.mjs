#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, readlink, realpath, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

function fail(message) {
  throw new Error(message);
}

function decodeMountPath(value) {
  return value.replace(/\\(040|011|012|134)/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

async function mountTargets() {
  const contents = await readFile('/proc/self/mountinfo', 'utf8');
  return contents.split('\n').filter(Boolean).map((line) => {
    const fields = line.split(' ');
    if (fields.length < 6) fail('malformed mount information');
    return decodeMountPath(fields[4]);
  });
}

export function assertNoMountTargetsUnder(root, targets) {
  const nested = targets.find((target) => target === root || target.startsWith(`${root}${path.sep}`));
  if (nested) fail(`runtime tree contains a mount point at ${nested}`);
}

function assertNoNestedMounts(root, targets) {
  assertNoMountTargetsUnder(root, targets);
}

function statIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o7777n),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
  };
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}

async function inventoryEntry(root, entryPath, ownerUid, entries) {
  const before = await lstat(entryPath, { bigint: true });
  if (Number(before.uid) !== ownerUid) fail(`runtime tree contains an entry not owned by service uid ${ownerUid}`);
  const identity = statIdentity(before);
  const relativePath = path.relative(root, entryPath) || '.';

  if (before.isDirectory()) {
    entries.push({ path: relativePath, type: 'directory', ...identity });
    const names = (await readdir(entryPath)).sort();
    for (const name of names) await inventoryEntry(root, path.join(entryPath, name), ownerUid, entries);
    const after = await lstat(entryPath, { bigint: true });
    const namesAfter = (await readdir(entryPath)).sort();
    if (String(after.dev) !== identity.dev || String(after.ino) !== identity.ino ||
        String(after.mtimeNs) !== identity.mtimeNs || names.join('\0') !== namesAfter.join('\0')) {
      fail('runtime directory changed during inspection');
    }
    return;
  }
  if (before.isSymbolicLink()) {
    entries.push({ path: relativePath, type: 'symlink', ...identity, target: await readlink(entryPath) });
    return;
  }
  if (!before.isFile()) fail(`runtime tree contains a special file at ${relativePath}`);
  const digest = await hashFile(entryPath);
  const after = await lstat(entryPath, { bigint: true });
  if (String(after.dev) !== identity.dev || String(after.ino) !== identity.ino ||
      Number(after.uid) !== ownerUid || String(after.size) !== identity.size ||
      String(after.mtimeNs) !== String(before.mtimeNs)) {
    fail(`runtime file changed during inspection at ${relativePath}`);
  }
  entries.push({ path: relativePath, type: 'file', ...identity, sha256: digest });
}

async function inventoryRuntimeTree(runtimePath, ownerUid, transactionId) {
  if (!Number.isInteger(ownerUid) || ownerUid < 0) fail('invalid service uid');
  const requestedPath = path.resolve(runtimePath);
  const rootStat = await lstat(requestedPath, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('runtime root must be a real directory');
  const root = await realpath(requestedPath);
  if (root !== requestedPath) fail('runtime root must not resolve through a symlink');
  if (Number(rootStat.uid) !== ownerUid) fail(`runtime root is not owned by service uid ${ownerUid}`);
  assertNoNestedMounts(root, await mountTargets());
  const entries = [];
  await inventoryEntry(root, root, ownerUid, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  if (transactionId !== null) {
    const markerPath = path.join(root, '.runtime-transaction-id');
    const markerStat = await lstat(markerPath, { bigint: true }).catch(() => fail('runtime transaction identity marker is missing'));
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || Number(markerStat.uid) !== ownerUid) {
      fail('runtime transaction identity marker has unsafe type or ownership');
    }
    const marker = await readFile(markerPath, 'utf8').catch(() => '');
    if (marker.trim() !== transactionId) fail('runtime transaction identity does not match');
  }
  const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  return { root, entries, digest };
}

export async function inspectRuntimeTree(runtimePath, ownerUid, transactionId = null) {
  return (await inventoryRuntimeTree(runtimePath, ownerUid, transactionId)).digest;
}

function statMatches(stat, expected) {
  const actual = statIdentity(stat);
  return actual.dev === expected.dev && actual.ino === expected.ino && actual.uid === expected.uid &&
    actual.gid === expected.gid && actual.mode === expected.mode && actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs;
}

async function removeEntry(root, entryPath, expected, childrenByPath) {
  const stat = await lstat(entryPath, { bigint: true });
  if (!statMatches(stat, expected)) fail(`runtime entry changed since inventory at ${expected.path}`);
  if (expected.type === 'directory') {
    const expectedChildren = childrenByPath.get(expected.path) ?? [];
    const names = (await readdir(entryPath)).sort();
    const expectedNames = expectedChildren.map((entry) => path.basename(entry.path)).sort();
    if (names.join('\0') !== expectedNames.join('\0')) fail(`runtime directory contents changed since inventory at ${expected.path}`);
    for (const child of expectedChildren) {
      await removeEntry(root, path.join(entryPath, path.basename(child.path)), child, childrenByPath);
    }
    if ((await readdir(entryPath)).length !== 0) fail(`runtime directory gained contents during removal at ${expected.path}`);
    await rmdir(entryPath);
  } else if (expected.type === 'symlink') {
    if (await readlink(entryPath) !== expected.target) fail(`runtime symlink changed since inventory at ${expected.path}`);
    await unlink(entryPath);
  } else if (expected.type === 'file') {
    if (await hashFile(entryPath) !== expected.sha256) fail(`runtime file contents changed since inventory at ${expected.path}`);
    const afterHash = await lstat(entryPath, { bigint: true });
    if (!statMatches(afterHash, expected)) fail(`runtime file changed during removal at ${expected.path}`);
    await unlink(entryPath);
  } else {
    fail(`refusing to remove unexpected entry type at ${expected.path}`);
  }
}

export async function removeRuntimeTree(runtimePath, ownerUid, expectedDigest, transactionId = null) {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest)) fail('invalid expected runtime inventory digest');
  const inventory = await inventoryRuntimeTree(runtimePath, ownerUid, transactionId);
  if (inventory.digest !== expectedDigest) fail('runtime tree no longer matches its transaction inventory; preserved');
  assertNoNestedMounts(inventory.root, await mountTargets());
  const childrenByPath = new Map();
  for (const entry of inventory.entries) {
    if (entry.path === '.') continue;
    const parent = path.dirname(entry.path);
    const children = childrenByPath.get(parent) ?? [];
    children.push(entry);
    childrenByPath.set(parent, children);
  }
  await removeEntry(inventory.root, inventory.root, inventory.entries.find((entry) => entry.path === '.'), childrenByPath);
}

async function main(args) {
  const [operation, runtimePath, uidText, digest, transactionId] = args;
  const uid = Number(uidText);
  if (!['inspect', 'remove'].includes(operation) || !runtimePath || !/^\d+$/.test(uidText ?? '')) {
    fail('usage: runtime-tree-safety.mjs <inspect|remove> <runtime-path> <service-uid> [digest] [transaction-id|-]');
  }
  if (operation === 'inspect') {
    process.stdout.write(`${await inspectRuntimeTree(runtimePath, uid, transactionId && transactionId !== '-' ? transactionId : null)}\n`);
    return;
  }
  if (!digest) fail('remove requires a transaction inventory digest');
  await removeRuntimeTree(runtimePath, uid, digest, transactionId && transactionId !== '-' ? transactionId : null);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main(process.argv.slice(2)).catch((error) => {
    const message = error instanceof Error ? error.message : 'runtime tree safety check failed';
    process.stderr.write(`deploy: ${message}\n`);
    process.exitCode = 1;
  });
}
