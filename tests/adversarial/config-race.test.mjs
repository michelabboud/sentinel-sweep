import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdtemp,
  rename,
  rm,
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

test('rejects an external config replaced by another regular file before open', async (t) => {
  assert.equal(typeof configModule.readVerifiedJsonFile, 'function');
  const root = await fixture(t);
  const configPath = path.join(root, 'sentinel.config.json');
  const replacementPath = path.join(root, 'replacement.json');
  await writeFile(configPath, '{}\n', { mode: 0o600 });
  await writeFile(replacementPath, '{"allowMutations":true}\n', { mode: 0o644 });
  await chmod(configPath, 0o600);
  await chmod(replacementPath, 0o644);
  const expectedStat = await lstat(configPath, { bigint: true });
  await rename(replacementPath, configPath);

  await assert.rejects(
    configModule.readVerifiedJsonFile({
      filePath: configPath,
      expectedStat,
      label: 'CONFIG',
      requirePrivateMode: true,
    }),
    { code: 'CONFIG_FILE_CHANGED' },
  );
});

test('rejects bundled defaults replaced by another regular file before open', async (t) => {
  assert.equal(typeof configModule.readVerifiedJsonFile, 'function');
  const root = await fixture(t);
  const defaultsPath = path.join(root, 'settings.json');
  const replacementPath = path.join(root, 'replacement.json');
  await writeFile(defaultsPath, '{}\n', { mode: 0o644 });
  await writeFile(replacementPath, '{"allowMutations":true}\n', { mode: 0o644 });
  await chmod(defaultsPath, 0o644);
  await chmod(replacementPath, 0o644);
  const expectedStat = await lstat(defaultsPath, { bigint: true });
  await rename(replacementPath, defaultsPath);

  await assert.rejects(
    configModule.readVerifiedJsonFile({
      filePath: defaultsPath,
      expectedStat,
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
  const script = `
import { execFileSync } from 'node:child_process';
import { lstat, unlink, writeFile } from 'node:fs/promises';
import { readVerifiedJsonFile } from ${JSON.stringify(configModuleUrl)};

const filePath = ${JSON.stringify(fifoPath)};
await writeFile(filePath, '{}\\n', { mode: 0o600 });
const expectedStat = await lstat(filePath, { bigint: true });
await unlink(filePath);
execFileSync('mkfifo', [filePath]);
try {
  await readVerifiedJsonFile({
    filePath,
    expectedStat,
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
