import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

test('lint exits non-zero when any checked module has invalid syntax', async () => {
  const invalidName = `.sentinel-invalid-lint-${process.pid}-${Date.now()}.mjs`;
  const invalidPath = fileURLToPath(new URL(`../${invalidName}`, import.meta.url));

  await writeFile(invalidPath, 'export const broken = ;\n', { mode: 0o600 });
  try {
    const result = spawnSync('npm', ['run', 'lint'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });

    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(invalidName));
    assert.notEqual(result.status, 0, 'lint must propagate node --check failures');
  } finally {
    await unlink(invalidPath);
  }
});
