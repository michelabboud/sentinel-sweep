import assert from 'node:assert/strict';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { OutputBoundary } from '../../runtime/lib/output-boundary.mjs';

async function parent(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-output-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function currentProcessStartTime() {
  const text = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 1).trim().split(/\s+/u);
  assert.ok(fields.length >= 20);
  return fields[19];
}

test('publishes an exclusive private file and never overwrites it', async (t) => {
  const root = await parent(t);
  const destination = path.join(root, 'manifest.json');
  await OutputBoundary.writeFile(destination, '{"schemaVersion":"2.0"}\n');
  assert.equal(await readFile(destination, 'utf8'), '{"schemaVersion":"2.0"}\n');
  assert.equal((await lstat(destination)).mode & 0o777, 0o600);
  await assert.rejects(
    OutputBoundary.writeFile(destination, 'replacement\n'),
    (error) => error?.code === 'OUTPUT_EXISTS',
  );
  assert.equal(await readFile(destination, 'utf8'), '{"schemaVersion":"2.0"}\n');
  assert.deepEqual((await readdir(root)).sort(), ['manifest.json']);
});

test('publishes a nested inert tree atomically with private modes', async (t) => {
  const root = await parent(t);
  const destination = path.join(root, 'collection');
  await OutputBoundary.writeTree(destination, [
    { path: 'bruno.json', content: '{}\n', mediaType: 'application/json' },
    { path: 'requests/health.bru', content: 'meta {}\n', mediaType: 'text/plain' },
  ]);
  assert.equal(await readFile(path.join(destination, 'bruno.json'), 'utf8'), '{}\n');
  assert.equal(
    await readFile(path.join(destination, 'requests/health.bru'), 'utf8'),
    'meta {}\n',
  );
  assert.equal((await lstat(destination)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(destination, 'requests'))).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(destination, 'bruno.json'))).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(root)).sort(), ['collection']);
});

test('rejects symlink parents, existing symlink destinations, and escaping artifact paths', async (t) => {
  const root = await parent(t);
  const actual = path.join(root, 'actual');
  const alias = path.join(root, 'alias');
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, alias, 'dir');
  await assert.rejects(
    OutputBoundary.writeFile(path.join(alias, 'result.txt'), 'blocked\n'),
    (error) => error?.code === 'OUTPUT_PARENT_INVALID',
  );

  const outside = path.join(root, 'outside.txt');
  const destination = path.join(root, 'destination.txt');
  await writeFile(outside, 'outside\n', { mode: 0o600 });
  await symlink(outside, destination);
  await assert.rejects(
    OutputBoundary.writeFile(destination, 'blocked\n'),
    (error) => error?.code === 'OUTPUT_EXISTS',
  );
  assert.equal(await readFile(outside, 'utf8'), 'outside\n');

  await assert.rejects(
    OutputBoundary.writeTree(path.join(root, 'bad-tree'), [
      { path: '../escape.txt', content: 'blocked\n', mediaType: 'text/plain' },
    ]),
    (error) => error?.code === 'OUTPUT_ARTIFACT_INVALID',
  );
  for (const artifactPath of [
    'line\nbreak.txt',
    'bidi\u202efile.txt',
    '.sentinel-output-stage-v2',
  ]) {
    await assert.rejects(
      OutputBoundary.writeTree(path.join(root, `bad-${artifactPath.length}`), [
        { path: artifactPath, content: 'blocked\n', mediaType: 'text/plain' },
      ]),
      (error) => error?.code === 'OUTPUT_ARTIFACT_INVALID',
    );
  }
  await assert.rejects(lstat(path.join(root, 'escape.txt')));
  assert.deepEqual((await readdir(root)).sort(), ['actual', 'alias', 'destination.txt', 'outside.txt']);
});

test('rejects output parents writable by another uid before creating staging', async (t) => {
  const root = await parent(t);
  const unsafe = path.join(root, 'unsafe');
  await mkdir(unsafe, { mode: 0o700 });
  await chmod(unsafe, 0o777);
  await assert.rejects(
    OutputBoundary.writeTree(path.join(unsafe, 'collection'), [
      { path: 'bruno.json', content: '{}\n', mediaType: 'application/json' },
    ]),
    (error) => error?.code === 'OUTPUT_PARENT_INVALID',
  );
  assert.deepEqual(await readdir(unsafe), []);
});

test('snapshots and validates the complete tree before any filesystem write', async (t) => {
  const root = await parent(t);
  await assert.rejects(
    OutputBoundary.writeTree(path.join(root, 'late-invalid'), [
      { path: 'valid.txt', content: 'must never be staged\n', mediaType: 'text/plain' },
      { path: '../escape.txt', content: 'blocked\n', mediaType: 'text/plain' },
    ]),
    (error) => error?.code === 'OUTPUT_ARTIFACT_INVALID',
  );

  let getterCalled = false;
  const hostile = {};
  for (const key of ['path', 'content', 'mediaType']) {
    Object.defineProperty(hostile, key, {
      enumerable: true,
      get() {
        getterCalled = true;
        return key === 'path' ? 'hostile.txt' : 'text/plain';
      },
    });
  }
  await assert.rejects(
    OutputBoundary.writeTree(path.join(root, 'accessor'), [hostile]),
    (error) => error?.code === 'OUTPUT_ARTIFACT_INVALID',
  );
  assert.equal(getterCalled, false);
  assert.deepEqual(await readdir(root), []);
});

test('honors a live cooperative tree reservation instead of entering the rename gap', async (t) => {
  const root = await parent(t);
  const destination = path.join(root, 'collection');
  const lock = path.join(root, '.collection.sentinel.lock');
  const nonce = 'a'.repeat(32);
  await writeFile(lock, `${JSON.stringify({
    version: 2,
    pid: process.pid,
    startTime: await currentProcessStartTime(),
    nonce,
  })}\n`, { mode: 0o600 });

  await assert.rejects(
    OutputBoundary.writeTree(destination, [
      { path: 'bruno.json', content: '{}\n', mediaType: 'application/json' },
    ]),
    (error) => error?.code === 'OUTPUT_BUSY',
  );
  assert.equal((await lstat(lock)).isFile(), true);
  await assert.rejects(lstat(destination), { code: 'ENOENT' });
  assert.deepEqual(await readdir(root), ['.collection.sentinel.lock']);
});

test('recovers linked locktmp and no-marker staging crash prefixes from a dead owner', async (t) => {
  const root = await parent(t);
  const destination = path.join(root, 'collection');
  const lock = path.join(root, '.collection.sentinel.lock');
  const nonce = 'b'.repeat(32);
  const staging = path.join(root, `.collection.sentinel-${nonce}.stage`);
  await mkdir(staging, { mode: 0o700 });
  await writeFile(path.join(staging, 'partial.txt'), 'partial\n', { mode: 0o600 });
  await writeFile(lock, `${JSON.stringify({
    version: 2,
    pid: 999999999,
    startTime: '1',
    nonce,
  })}\n`, { mode: 0o600 });
  await link(lock, path.join(root, `.collection.sentinel-${nonce}.locktmp`));

  await OutputBoundary.writeTree(destination, [
    { path: 'bruno.json', content: '{}\n', mediaType: 'application/json' },
  ]);
  assert.deepEqual(await readdir(root), ['collection']);
  assert.equal(await readFile(path.join(destination, 'bruno.json'), 'utf8'), '{}\n');
});
