import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildManifest } from '../../runtime/discovery/index.mjs';
import { loadTrustedConfig } from '../../runtime/lib/config.mjs';
import { TargetBoundary } from '../../runtime/lib/fs-boundary.mjs';
import { operationId, routeId } from '../../runtime/lib/identity.mjs';
import { buildExecutionPlan } from '../../runtime/policy/execution.mjs';

const targetRoot = fileURLToPath(new URL('../fixtures/discovery/', import.meta.url));
const defaultsPath = fileURLToPath(new URL('../../settings.json', import.meta.url));

test('0600 external config and 0644 defaults reach discovery and execution planning', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-config-contract-'));
  t.after(async () => {
    await rm(temporary, { recursive: true, force: true });
  });
  const configPath = path.join(temporary, 'sentinel.config.json');
  const adminOperation = operationId('GET', '/api/admin');
  const itemOperation = operationId('GET', '/api/items/{itemId}');
  const adminRoute = routeId('/admin/users/{id}');
  const external = {
    approvedOrigins: ['http://127.0.0.1:4317'],
    roles: {
      user: { tokenRef: 'env:SENTINEL_USER_TOKEN' },
      admin: { tokenRef: 'env:SENTINEL_ADMIN_TOKEN' },
    },
    services: [{
      name: 'fixture',
      approvedOrigin: 'http://127.0.0.1:4317',
      sourcePath: '.',
    }],
    discovery: {
      openapi: ['openapi-complete.json'],
      vueRouter: ['vue-complete/router.js'],
    },
    trustedOverrides: {
      operations: {
        [adminOperation]: { allowedRoles: ['admin'] },
        [itemOperation]: {
          allowedRoles: ['user', 'admin'],
          parameterExamples: [
            { location: 'path', name: 'itemId', value: 'known-item' },
            { location: 'query', name: 'includeDetails', value: true },
          ],
        },
      },
      routes: {
        [adminRoute]: {
          allowedRoles: ['admin'],
          parameterExamples: [
            { location: 'path', name: 'id', value: 'known-user' },
          ],
        },
      },
    },
  };
  await writeFile(configPath, `${JSON.stringify(external)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);

  assert.equal((await lstat(configPath)).mode & 0o7777, 0o600);
  assert.equal((await lstat(defaultsPath)).mode & 0o7777, 0o644);

  const config = await loadTrustedConfig({ configPath, targetRoot, defaultsPath });
  const boundary = await TargetBoundary.create(targetRoot);
  const manifest = await buildManifest({
    targetBoundary: boundary,
    config,
    generatedAt: '2026-07-18T00:00:00.000Z',
  });
  const plan = buildExecutionPlan({
    manifest,
    config,
    mode: 'sweep',
    sandboxAcknowledged: false,
  });

  const item = manifest.operations.find((candidate) => candidate.id === itemOperation);
  assert.deepEqual(item.auth.allowedRoles, ['admin', 'user']);
  assert.deepEqual(
    item.parameters.map(({ location, name, example }) => ({ location, name, example })),
    [
      { location: 'path', name: 'itemId', example: 'known-item' },
      { location: 'query', name: 'includeDetails', example: true },
    ],
  );
  assert.deepEqual(
    manifest.routes.find((candidate) => candidate.id === adminRoute).auth.allowedRoles,
    ['admin'],
  );
  assert.deepEqual(plan.roleUniverse, ['admin', 'user']);
  assert.ok(Object.isFrozen(plan.roleUniverse));
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes('tokenRef'), false);
  assert.equal(serialized.includes('env:'), false);
  assert.equal(serialized.includes('SENTINEL_'), false);
});

test('canonicalizes approved origins once and rejects ambiguous service policy', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-config-origins-'));
  t.after(async () => {
    await rm(temporary, { recursive: true, force: true });
  });
  const configPath = path.join(temporary, 'sentinel.config.json');

  async function writeExternal(value) {
    await writeFile(configPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(configPath, 0o600);
  }

  const external = {
    approvedOrigins: [
      'http://localhost',
      'http://localhost:80',
      'http://127.0.0.1:80',
    ],
    services: [
      { name: 'zeta', approvedOrigin: 'http://localhost:80', sourcePath: '.' },
      { name: 'alpha', approvedOrigin: 'http://127.0.0.1', sourcePath: '.' },
    ],
  };
  await writeExternal(external);

  const normalized = await loadTrustedConfig({ configPath, targetRoot, defaultsPath });
  assert.deepEqual(normalized.approvedOrigins, [
    'http://127.0.0.1',
    'http://localhost',
  ]);
  assert.deepEqual(
    normalized.services.map(({ name, approvedOrigin }) => ({ name, approvedOrigin })),
    [
      { name: 'alpha', approvedOrigin: 'http://127.0.0.1' },
      { name: 'zeta', approvedOrigin: 'http://localhost' },
    ],
  );

  await writeExternal({
    ...external,
    services: [
      { name: 'duplicate', approvedOrigin: 'http://localhost', sourcePath: '.' },
      { name: 'duplicate', approvedOrigin: 'http://127.0.0.1', sourcePath: '.' },
    ],
  });
  await assert.rejects(
    () => loadTrustedConfig({ configPath, targetRoot, defaultsPath }),
    (error) => error?.code === 'CONFIG_SERVICE_DUPLICATE',
  );

  await writeExternal({
    approvedOrigins: ['http://localhost'],
    services: [{
      name: 'unapproved',
      approvedOrigin: 'http://127.0.0.1',
      sourcePath: '.',
    }],
  });
  await assert.rejects(
    () => loadTrustedConfig({ configPath, targetRoot, defaultsPath }),
    (error) => error?.code === 'CONFIG_SERVICE_ORIGIN_UNAPPROVED',
  );
});
