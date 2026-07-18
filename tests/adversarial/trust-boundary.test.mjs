import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadTrustedConfig } from '../../runtime/lib/config.mjs';
import { TargetBoundary } from '../../runtime/lib/fs-boundary.mjs';
import { findingId, operationId, routeId } from '../../runtime/lib/identity.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-trust-boundary-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('trusted config cannot be loaded from the untrusted target tree', async (t) => {
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  const insideTarget = path.join(targetRoot, 'sentinel.config.json');
  const defaultsPath = path.join(root, 'defaults.json');
  await mkdir(targetRoot);
  await writeFile(insideTarget, '{"version":2}\n');
  await writeFile(defaultsPath, '{"version":2}\n');

  await assert.rejects(
    () => loadTrustedConfig({ configPath: insideTarget, targetRoot, defaultsPath }),
    { code: 'CONFIG_UNTRUSTED_LOCATION' },
  );
});

test('untrusted config location is rejected before any defaults are read', async (t) => {
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  const insideTarget = path.join(targetRoot, 'sentinel.config.json');
  await mkdir(targetRoot);
  await writeFile(insideTarget, '{"schemaVersion":"2.0"}\n');

  await assert.rejects(
    () => loadTrustedConfig({
      configPath: insideTarget,
      targetRoot,
      defaultsPath: path.join(root, 'missing-defaults.json'),
    }),
    { code: 'CONFIG_UNTRUSTED_LOCATION' },
  );
});

test('trusted config merges with strict v2 defaults and rejects unknown settings', async (t) => {
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  const configPath = path.join(root, 'sentinel.config.json');
  const defaultsPath = fileURLToPath(new URL('../../settings.json', import.meta.url));
  await mkdir(targetRoot);
  await writeFile(configPath, '{"responseTimeoutMs":10000}\n');

  const config = await loadTrustedConfig({ configPath, targetRoot, defaultsPath });
  assert.equal(config.responseTimeoutMs, 10000);
  assert.equal(config.browserSettleMs, 500);
  assert.equal(config.schemaVersion, '2.0');
  assert.equal(config.allowMutations, false);

  await writeFile(configPath, '{"unknownSetting":true}\n');
  await assert.rejects(
    () => loadTrustedConfig({ configPath, targetRoot, defaultsPath }),
    { code: 'SCHEMA_INVALID' },
  );

  await writeFile(configPath, '{"responseTimeoutMs":1000,"browserSettleMs":250}\n');
  assert.equal(
    (await loadTrustedConfig({ configPath, targetRoot, defaultsPath })).browserSettleMs,
    250,
  );

  for (const browserSettleMs of [500, 501]) {
    await writeFile(
      configPath,
      `${JSON.stringify({ responseTimeoutMs: 500, browserSettleMs })}\n`,
    );
    await assert.rejects(
      () => loadTrustedConfig({ configPath, targetRoot, defaultsPath }),
      { code: 'CONFIG_BROWSER_SETTLE_INVALID' },
    );
  }
});

test('.env cannot be selected as an adapter input even when it is inside the target', async (t) => {
  const root = await fixture(t);
  const targetRoot = path.join(root, 'target');
  await mkdir(targetRoot);
  await writeFile(path.join(targetRoot, '.env'), 'TOKEN=do-not-read\n');

  const boundary = await TargetBoundary.create(targetRoot);
  await assert.rejects(() => boundary.resolveInput('.env'));
});

test('route and operation identities normalize duplicate slashes and parameter names', () => {
  assert.equal(routeId('/v1//users/{id}/'), routeId('/v1/users/{userId}'));
  assert.equal(routeId('/v1/users/:id'), routeId('/v1/users/{userId}'));
  assert.equal(
    operationId('get', '/v1//users/{id}/'),
    operationId('GET', '/v1/users/:userId'),
  );
  assert.notEqual(operationId('GET', '/v1/users/{id}'), operationId('POST', '/v1/users/{id}'));
});

test('finding identities are stable across recursively reordered fields', () => {
  const left = findingId({
    route: '/v1/users/{id}',
    evidence: { status: 500, headers: { zebra: 'z', alpha: 'a' } },
    rule: 'unexpected-status',
  });
  const right = findingId({
    rule: 'unexpected-status',
    evidence: { headers: { alpha: 'a', zebra: 'z' }, status: 500 },
    route: '/v1/users/{id}',
  });

  assert.equal(left, right);
  assert.match(left, /^[a-f0-9]{64}$/);
});
