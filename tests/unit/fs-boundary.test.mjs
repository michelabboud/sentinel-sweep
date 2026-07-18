import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { RunBoundary, TargetBoundary } from '../../runtime/lib/fs-boundary.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-fs-boundary-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('TargetBoundary rejects a symlink target root', async (t) => {
  const root = await fixture(t);
  const target = path.join(root, 'target');
  const symlinkRoot = path.join(root, 'target-link');
  await mkdir(target);
  await symlink(target, symlinkRoot, 'dir');

  await assert.rejects(() => TargetBoundary.create(symlinkRoot), {
    code: 'TARGET_ROOT_SYMLINK',
  });
});

test('TargetBoundary reads regular files but rejects symlinks and escapes', async (t) => {
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  const outside = path.join(root, 'outside.json');
  await mkdir(targetRoot);
  await writeFile(path.join(targetRoot, 'openapi.json'), '{"openapi":"3.1.0"}\n');
  await writeFile(outside, '{}\n');
  await symlink(outside, path.join(targetRoot, 'linked-openapi.json'));

  const boundary = await TargetBoundary.create(targetRoot);
  assert.equal(await boundary.readText('openapi.json'), '{"openapi":"3.1.0"}\n');
  await assert.rejects(() => boundary.readText('linked-openapi.json'), {
    code: 'INPUT_SYMLINK',
  });
  await assert.rejects(() => boundary.readText('../outside.json'), {
    code: 'PATH_ESCAPE',
  });
});

test('TargetBoundary readText rejects secret-bearing adapter inputs', async (t) => {
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  await mkdir(targetRoot);
  const blockedInputs = [
    '.env',
    '.env.local',
    'server.pem',
    'private.key',
    'credentials.json',
    'service-account-credentials.yaml',
  ];
  await Promise.all(blockedInputs.map(
    (name) => writeFile(path.join(targetRoot, name), 'must-not-be-read\n'),
  ));

  const boundary = await TargetBoundary.create(targetRoot);
  for (const name of blockedInputs) {
    await assert.rejects(() => boundary.readText(name), { code: 'INPUT_TYPE_BLOCKED' });
  }
});

test('TargetBoundary readText preserves approved OpenAPI and Vue adapter inputs', async (t) => {
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  await mkdir(targetRoot);
  await writeFile(path.join(targetRoot, 'openapi.yaml'), 'openapi: 3.1.0\n');
  await writeFile(path.join(targetRoot, 'AccountView.vue'), '<template />\n');
  await writeFile(path.join(targetRoot, 'router.js'), 'export const routes = [];\n');
  await writeFile(path.join(targetRoot, 'router.ts'), 'export const routes = [];\n');

  const boundary = await TargetBoundary.create(targetRoot);
  assert.equal(await boundary.readText('openapi.yaml'), 'openapi: 3.1.0\n');
  assert.equal(await boundary.readText('AccountView.vue'), '<template />\n');
  assert.equal(await boundary.readText('router.js'), 'export const routes = [];\n');
  assert.equal(await boundary.readText('router.ts'), 'export const routes = [];\n');
});

test('TargetBoundary source extensions do not override secret filename denials', async (t) => {
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  await mkdir(targetRoot);
  await writeFile(path.join(targetRoot, 'credentials.js'), 'export default {};\n');
  await writeFile(path.join(targetRoot, 'private-key.ts'), 'export default {};\n');

  const boundary = await TargetBoundary.create(targetRoot);
  await assert.rejects(() => boundary.readText('credentials.js'), {
    code: 'INPUT_TYPE_BLOCKED',
  });
  await assert.rejects(() => boundary.readText('private-key.ts'), {
    code: 'INPUT_TYPE_BLOCKED',
  });
});

test('TargetBoundary never accepts .env as an adapter input', async (t) => {
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  await mkdir(targetRoot);
  await writeFile(path.join(targetRoot, '.env'), 'SENTINEL_ADMIN_TOKEN=top-secret\n');

  const boundary = await TargetBoundary.create(targetRoot);
  await assert.rejects(() => boundary.resolveInput('.env'));
});

test('TargetBoundary resolves a regular supported adapter input inside the pinned root', async (t) => {
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  await mkdir(targetRoot);
  await writeFile(path.join(targetRoot, 'openapi.yaml'), 'openapi: 3.1.0\n');

  const boundary = await TargetBoundary.create(targetRoot);
  assert.equal(await boundary.resolveInput('openapi.yaml'), path.join(targetRoot, 'openapi.yaml'));
});

test('RunBoundary atomically replaces output symlinks and writes mode 0600', async (t) => {
  const root = await fixture(t);
  const runRoot = path.join(root, 'run');
  const victim = path.join(root, 'victim.txt');
  await mkdir(runRoot);
  await writeFile(victim, 'untouched\n');
  await chmod(victim, 0o644);
  await symlink(victim, path.join(runRoot, 'report.txt'));

  const boundary = await RunBoundary.create(runRoot);
  await boundary.writeText('report.txt', 'safe output\n');

  const output = path.join(runRoot, 'report.txt');
  const stat = await lstat(output);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(await readFile(output, 'utf8'), 'safe output\n');
  assert.equal(await readFile(victim, 'utf8'), 'untouched\n');
});

test('RunBoundary writes canonical JSON with a final newline', async (t) => {
  const root = await fixture(t);
  const runRoot = path.join(root, 'run');
  await mkdir(runRoot);

  const boundary = await RunBoundary.create(runRoot);
  await boundary.writeJson('result.json', {
    zebra: 1,
    alpha: { two: 2, one: 1 },
  });

  assert.equal(
    await readFile(path.join(runRoot, 'result.json'), 'utf8'),
    '{\n  "alpha": {\n    "one": 1,\n    "two": 2\n  },\n  "zebra": 1\n}\n',
  );
  assert.equal((await lstat(path.join(runRoot, 'result.json'))).mode & 0o777, 0o600);
});

test('RunBoundary atomically writes exact binary bytes with mode 0600', async (t) => {
  const root = await fixture(t);
  const runRoot = path.join(root, 'run');
  const victim = path.join(root, 'victim.bin');
  await mkdir(runRoot);
  await writeFile(victim, Buffer.from([1, 2, 3]));
  await symlink(victim, path.join(runRoot, 'browser.png'));
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);

  const boundary = await RunBoundary.create(runRoot);
  await boundary.writeBytes('browser.png', png);

  const output = path.join(runRoot, 'browser.png');
  assert.deepEqual(await readFile(output), Buffer.from(png));
  assert.deepEqual(await readFile(victim), Buffer.from([1, 2, 3]));
  assert.equal((await lstat(output)).isSymbolicLink(), false);
  assert.equal((await lstat(output)).mode & 0o777, 0o600);
  await assert.rejects(() => boundary.writeBytes('invalid.png', 'not bytes'), {
    code: 'OUTPUT_BYTES_INVALID',
  });
});

test('RunBoundary refuses output path escapes', async (t) => {
  const root = await fixture(t);
  const runRoot = path.join(root, 'run');
  await mkdir(runRoot);

  const boundary = await RunBoundary.create(runRoot);
  await assert.rejects(() => boundary.writeText('../outside.txt', 'blocked'), {
    code: 'PATH_ESCAPE',
  });
});

test('RunBoundary atomically replaces the latest symlink without following it', async (t) => {
  const root = await fixture(t);
  const reportRoot = path.join(root, 'reports');
  const runId = '2026-07-18T05-46-00Z';
  const runRoot = path.join(reportRoot, runId);
  const victim = path.join(root, 'victim');
  await mkdir(runRoot, { recursive: true });
  await mkdir(victim);
  await writeFile(path.join(victim, 'marker.txt'), 'untouched\n');
  await symlink(victim, path.join(reportRoot, 'latest'), 'dir');

  const boundary = await RunBoundary.create(runRoot);
  await boundary.replaceLatest(reportRoot, runId);

  const latest = path.join(reportRoot, 'latest');
  assert.equal((await lstat(latest)).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(victim, 'marker.txt'), 'utf8'), 'untouched\n');
  assert.equal(await readlink(latest), runId);
});
