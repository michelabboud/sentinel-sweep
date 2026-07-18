import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import * as configModule from '../../runtime/lib/config.mjs';

const execFile = promisify(execFileCallback);
const configModuleUrl = new URL('../../runtime/lib/config.mjs', import.meta.url).href;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-config-race-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function targetBoundary(targetRoot) {
  return {
    lexical: path.resolve(targetRoot),
    canonical: await realpath(targetRoot),
  };
}

test('rejects an external config replaced by another regular file before open', async (t) => {
  assert.equal(typeof configModule.readVerifiedJsonFile, 'function');
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  const configPath = path.join(root, 'sentinel.config.json');
  const replacementPath = path.join(root, 'replacement.json');
  await mkdir(targetRoot);
  await writeFile(configPath, '{}\n', { mode: 0o600 });
  await writeFile(replacementPath, '{"allowMutations":true}\n', { mode: 0o644 });
  await chmod(configPath, 0o600);
  await chmod(replacementPath, 0o644);
  const expectedStat = await lstat(configPath, { bigint: true });
  const boundary = await targetBoundary(targetRoot);
  const expectedPathBinding = await configModule.captureTrustedPathBinding({
    filePath: configPath,
    targetRoot: boundary,
    label: 'CONFIG',
    expectedStat,
  });
  await rename(replacementPath, configPath);

  await assert.rejects(
    configModule.readVerifiedJsonFile({
      filePath: configPath,
      expectedStat,
      expectedPathBinding,
      targetRoot: boundary,
      label: 'CONFIG',
      requirePrivateMode: true,
    }),
    { code: 'CONFIG_FILE_CHANGED' },
  );
});

test('rejects bundled defaults replaced by another regular file before open', async (t) => {
  assert.equal(typeof configModule.readVerifiedJsonFile, 'function');
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  const defaultsPath = path.join(root, 'settings.json');
  const replacementPath = path.join(root, 'replacement.json');
  await mkdir(targetRoot);
  await writeFile(defaultsPath, '{}\n', { mode: 0o644 });
  await writeFile(replacementPath, '{"allowMutations":true}\n', { mode: 0o644 });
  await chmod(defaultsPath, 0o644);
  await chmod(replacementPath, 0o644);
  const expectedStat = await lstat(defaultsPath, { bigint: true });
  const boundary = await targetBoundary(targetRoot);
  const expectedPathBinding = await configModule.captureTrustedPathBinding({
    filePath: defaultsPath,
    targetRoot: boundary,
    label: 'DEFAULTS',
    expectedStat,
  });
  await rename(replacementPath, defaultsPath);

  await assert.rejects(
    configModule.readVerifiedJsonFile({
      filePath: defaultsPath,
      expectedStat,
      expectedPathBinding,
      targetRoot: boundary,
      label: 'DEFAULTS',
      requirePrivateMode: false,
    }),
    { code: 'DEFAULTS_FILE_CHANGED' },
  );
});

test('a regular-file-to-FIFO swap is opened nonblocking and rejected as non-regular', async (t) => {
  if (process.platform === 'win32') return;
  assert.equal(typeof configModule.readVerifiedJsonFile, 'function');
  const root = await fixture(t);
  const scriptPath = path.join(root, 'fifo-race.mjs');
  const fifoPath = path.join(root, 'sentinel.config.json');
  const targetRoot = path.join(root, 'target');
  const script = `
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { captureTrustedPathBinding, readVerifiedJsonFile } from ${JSON.stringify(configModuleUrl)};

const filePath = ${JSON.stringify(fifoPath)};
const targetRoot = ${JSON.stringify(targetRoot)};
await mkdir(targetRoot);
await writeFile(filePath, '{}\\n', { mode: 0o600 });
const expectedStat = await lstat(filePath, { bigint: true });
const boundary = { lexical: targetRoot, canonical: await realpath(targetRoot) };
const expectedPathBinding = await captureTrustedPathBinding({
  filePath,
  targetRoot: boundary,
  label: 'CONFIG',
  expectedStat,
});
await unlink(filePath);
execFileSync('mkfifo', [filePath]);
try {
  await readVerifiedJsonFile({
    filePath,
    expectedStat,
    expectedPathBinding,
    targetRoot: boundary,
    label: 'CONFIG',
    requirePrivateMode: true,
  });
  process.exitCode = 2;
} catch (error) {
  process.stdout.write(String(error?.code));
  process.exitCode = error?.code === 'CONFIG_NOT_FILE' ? 0 : 3;
}
`;
  await writeFile(scriptPath, script);

  const result = await execFile(process.execPath, [scriptPath], { timeout: 2000 });
  assert.equal(result.stdout, 'CONFIG_NOT_FILE');
  await unlink(fifoPath);
});

test('rejects same-inode parent relocation beneath the target after path approval', async (t) => {
  assert.equal(typeof configModule.captureTrustedPathBinding, 'function');
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  const trustedParent = path.join(root, 'trusted');
  const movedParent = path.join(targetRoot, 'relocated-trusted');
  const configPath = path.join(trustedParent, 'sentinel.config.json');
  await mkdir(targetRoot);
  await mkdir(trustedParent);
  await writeFile(configPath, '{}\n', { mode: 0o600 });
  await chmod(configPath, 0o600);
  const boundary = await targetBoundary(targetRoot);
  const expectedStat = await lstat(configPath, { bigint: true });
  const expectedPathBinding = await configModule.captureTrustedPathBinding({
    filePath: configPath,
    targetRoot: boundary,
    label: 'CONFIG',
    expectedStat,
  });

  await rename(trustedParent, movedParent);
  await symlink(movedParent, trustedParent, 'dir');

  await assert.rejects(
    configModule.readVerifiedJsonFile({
      filePath: configPath,
      expectedStat,
      expectedPathBinding,
      targetRoot: boundary,
      label: 'CONFIG',
      requirePrivateMode: true,
    }),
    { code: 'CONFIG_UNTRUSTED_LOCATION' },
  );
});

test('detects parent relocation restored before the post-read path check', async (t) => {
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  const trustedParent = path.join(root, 'trusted');
  const movedParent = path.join(targetRoot, 'relocated-trusted');
  const configPath = path.join(trustedParent, 'sentinel.config.json');
  await mkdir(targetRoot);
  await mkdir(trustedParent);
  await writeFile(configPath, '{}\n', { mode: 0o600 });
  await chmod(configPath, 0o600);

  const probe = await open(configPath, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalDescriptor = Object.getOwnPropertyDescriptor(fileHandlePrototype, 'readFile');
  let intercepted = false;
  Object.defineProperty(fileHandlePrototype, 'readFile', {
    ...originalDescriptor,
    value: async function relocateDuringRead(...args) {
      if (intercepted) return originalDescriptor.value.apply(this, args);
      intercepted = true;
      await rename(trustedParent, movedParent);
      await symlink(movedParent, trustedParent, 'dir');
      try {
        return await originalDescriptor.value.apply(this, args);
      } finally {
        await unlink(trustedParent);
        await rename(movedParent, trustedParent);
      }
    },
  });
  t.after(() => {
    Object.defineProperty(fileHandlePrototype, 'readFile', originalDescriptor);
  });

  await assert.rejects(
    configModule.loadTrustedConfig({ configPath, targetRoot }),
    { code: 'CONFIG_FILE_CHANGED' },
  );
  assert.equal(intercepted, true);
});

test('rejects simulated inode reuse when extended file identity changed', async (t) => {
  assert.equal(typeof configModule.captureTrustedPathBinding, 'function');
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  const configPath = path.join(root, 'sentinel.config.json');
  await mkdir(targetRoot);
  await writeFile(configPath, '{}\n', { mode: 0o600 });
  await chmod(configPath, 0o600);
  const originalStat = await lstat(configPath, { bigint: true });
  await unlink(configPath);
  await writeFile(configPath, '{"allowMutations":true}\n', { mode: 0o600 });
  await chmod(configPath, 0o600);
  const replacementStat = await lstat(configPath, { bigint: true });
  const boundary = await targetBoundary(targetRoot);
  const expectedPathBinding = await configModule.captureTrustedPathBinding({
    filePath: configPath,
    targetRoot: boundary,
    label: 'CONFIG',
    expectedStat: replacementStat,
  });
  const simulatedReusedStat = {
    dev: replacementStat.dev,
    ino: replacementStat.ino,
    birthtimeNs: originalStat.birthtimeNs,
    ctimeNs: originalStat.ctimeNs,
    size: originalStat.size,
    mtimeNs: originalStat.mtimeNs,
  };

  await assert.rejects(
    configModule.readVerifiedJsonFile({
      filePath: configPath,
      expectedStat: simulatedReusedStat,
      expectedPathBinding,
      targetRoot: boundary,
      label: 'CONFIG',
      requirePrivateMode: true,
    }),
    { code: 'CONFIG_FILE_CHANGED' },
  );
});
