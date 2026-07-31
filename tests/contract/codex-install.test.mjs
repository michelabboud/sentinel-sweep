import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INSTALL = path.join(ROOT, 'codex/install.sh');
const UNINSTALL = path.join(ROOT, 'codex/uninstall.sh');
const WRAPPER = path.join(ROOT, 'codex/bin/sentinel-codex.sh');

async function temporaryHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'sentinel-codex-install-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function run(script, home, name) {
  return execFileAsync('bash', [script, name], {
    cwd: ROOT,
    env: { ...process.env, HOME: home },
  });
}

async function rejects(script, home, name) {
  try {
    await run(script, home, name);
  } catch (error) {
    return error;
  }
  assert.fail(`${path.basename(script)} unexpectedly accepted ${JSON.stringify(name)}`);
}

test('installer prints only supported examples and is safely idempotent for its own link', async (t) => {
  const home = await temporaryHome(t);
  const name = 'sentinel-contract';
  const link = path.join(home, '.local/bin', name);

  const first = await run(INSTALL, home, name);
  assert.equal(first.stderr, '');
  assert.match(first.stdout, /sentinel-contract --help/u);
  assert.match(
    first.stdout,
    /sentinel-contract setup --target <path> --config <path> --json/u,
  );
  assert.match(
    first.stdout,
    /sentinel-contract sweep --target <path> --config <path> --json/u,
  );
  assert.doesNotMatch(first.stdout, /--dry-run|--risk-level|--safe-only|--reuse-manifest/u);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await realpath(link), await realpath(WRAPPER));

  const second = await run(INSTALL, home, name);
  assert.equal(second.stderr, '');
  assert.match(second.stdout, /already installed/u);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await realpath(link), await realpath(WRAPPER));

  const removed = await run(UNINSTALL, home, name);
  assert.equal(removed.stderr, '');
  assert.match(removed.stdout, /Removed command/u);
  await assert.rejects(lstat(link), { code: 'ENOENT' });
});

test('install and uninstall reject traversal, separators, controls, and oversized names', async (t) => {
  const home = await temporaryHome(t);
  const outside = path.join(home, '.bashrc');
  await writeFile(outside, 'preserve-me\n', { mode: 0o600 });
  const invalidNames = [
    '../../.bashrc',
    '../escape',
    '.',
    '..',
    '/tmp/absolute',
    'nested/name',
    'back\\slash',
    'line\nbreak',
    '-leading-option',
    'x'.repeat(65),
  ];

  for (const name of invalidNames) {
    const installError = await rejects(INSTALL, home, name);
    assert.match(`${installError.stdout ?? ''}${installError.stderr ?? ''}`, /invalid command name/iu);
    const uninstallError = await rejects(UNINSTALL, home, name);
    assert.match(`${uninstallError.stdout ?? ''}${uninstallError.stderr ?? ''}`, /invalid command name/iu);
  }

  assert.equal(await readFile(outside, 'utf8'), 'preserve-me\n');
});

test('install and uninstall preserve regular files and unrelated symlinks', async (t) => {
  const home = await temporaryHome(t);
  const bin = path.join(home, '.local/bin');
  await mkdir(bin, { recursive: true, mode: 0o700 });

  const regular = path.join(bin, 'sentinel-regular');
  await writeFile(regular, 'unrelated regular file\n', { mode: 0o600 });
  for (const script of [INSTALL, UNINSTALL]) {
    const error = await rejects(script, home, 'sentinel-regular');
    assert.match(`${error.stdout ?? ''}${error.stderr ?? ''}`, /refus/iu);
    assert.equal(await readFile(regular, 'utf8'), 'unrelated regular file\n');
    assert.equal((await lstat(regular)).isFile(), true);
  }

  const unrelatedTarget = path.join(home, 'unrelated-launcher');
  await writeFile(unrelatedTarget, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const unrelatedLink = path.join(bin, 'sentinel-unrelated');
  await symlink(unrelatedTarget, unrelatedLink);
  for (const script of [INSTALL, UNINSTALL]) {
    const error = await rejects(script, home, 'sentinel-unrelated');
    assert.match(`${error.stdout ?? ''}${error.stderr ?? ''}`, /refus/iu);
    assert.equal((await lstat(unrelatedLink)).isSymbolicLink(), true);
    assert.equal(await realpath(unrelatedLink), await realpath(unrelatedTarget));
  }

  const brokenLink = path.join(bin, 'sentinel-broken');
  await symlink(path.join(home, 'missing-target'), brokenLink);
  for (const script of [INSTALL, UNINSTALL]) {
    const error = await rejects(script, home, 'sentinel-broken');
    assert.match(`${error.stdout ?? ''}${error.stderr ?? ''}`, /refus/iu);
    assert.equal((await lstat(brokenLink)).isSymbolicLink(), true);
  }
});
