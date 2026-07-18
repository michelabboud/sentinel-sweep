import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildManifest } from '../../runtime/discovery/index.mjs';
import { TargetBoundary } from '../../runtime/lib/fs-boundary.mjs';
import { operationId, routeId } from '../../runtime/lib/identity.mjs';

const fixtureDirectory = fileURLToPath(new URL('../fixtures/discovery/', import.meta.url));
const goldenPath = fileURLToPath(new URL('../fixtures/discovery/openapi-complete.manifest.json', import.meta.url));
const bundledDefaults = JSON.parse(
  await readFile(new URL('../../settings.json', import.meta.url), 'utf8'),
);

function stripGeneratedAt(manifest) {
  const { generatedAt: _generatedAt, ...stable } = manifest;
  return {
    ...stable,
    target: { ...stable.target, root: '<target-root>' },
  };
}

async function fixtureBoundary() {
  return TargetBoundary.create(fixtureDirectory);
}

function configWith(overrides = {}) {
  return {
    ...structuredClone(bundledDefaults),
    ...overrides,
  };
}

function completeConfig() {
  return configWith({
    discovery: {
      openapi: ['openapi-complete.json'],
      vueRouter: [
        'vue-complete/router.js',
        'vue-complete/public-router.ts',
      ],
    },
    trustedOverrides: {
      operations: {
        [operationId('GET', '/api/admin')]: {
          allowedRoles: ['admin'],
          targetModel: 'admin-read',
        },
        [operationId('POST', '/api/items')]: {
          allowedRoles: ['editor'],
          parameterExamples: [],
          sideEffects: { classes: ['data-write'] },
          rollback: 'delete-created-item',
        },
        [operationId('DELETE', '/api/items/{itemId}')]: {
          allowedRoles: ['admin'],
          deleteMode: 'hard',
          sideEffects: { classes: ['data-delete'] },
          rollback: null,
        },
      },
      routes: {},
    },
  });
}

test('builds the strict golden manifest and remains deterministic', async () => {
  const targetBoundary = await fixtureBoundary();
  const config = completeConfig();
  const goldenManifest = JSON.parse(await readFile(goldenPath, 'utf8'));

  const first = stripGeneratedAt(await buildManifest({
    targetBoundary,
    config,
    generatedAt: '2026-07-18T00:00:00.000Z',
  }));
  const second = stripGeneratedAt(await buildManifest({
    targetBoundary,
    config,
    generatedAt: '2030-01-01T00:00:00.000Z',
  }));

  assert.ok(first.routes.some((route) => route.path === '/admin/users/{id}'));
  assert.deepEqual(first.routes.find((route) => route.path === '/admin').auth.allowedRoles, []);
  assert.deepEqual(
    first.routes.find((route) => route.path === '/landing'),
    {
      id: routeId('/landing'),
      path: '/landing',
      name: 'landing',
      component: 'LandingView',
      aliases: ['/home', '/welcome'],
      auth: { state: 'public', allowedRoles: [] },
      parameters: [],
      provenance: {
        adapter: 'vue-router-static',
        file: 'vue-complete/router.js',
        pointer: '/routes/1/children/0',
      },
    },
  );
  assert.deepEqual(first, goldenManifest);
  assert.deepEqual(second, goldenManifest);
});

test('accepts only exact discovered stable IDs for canonical operation and route overrides', async () => {
  const targetBoundary = await fixtureBoundary();
  const adminOperationId = operationId('GET', '/api/admin');
  const adminRouteId = routeId('/api/admin');
  const exact = await buildManifest({
    targetBoundary,
    config: configWith({
      discovery: { openapi: ['openapi-complete.json'] },
      trustedOverrides: {
        operations: {
          [adminOperationId]: { allowedRoles: ['admin'] },
        },
        routes: {
          [adminRouteId]: { allowedRoles: ['admin'] },
        },
      },
    }),
  });

  assert.deepEqual(
    exact.operations.find((operation) => operation.id === adminOperationId).auth.allowedRoles,
    ['admin'],
  );
  assert.deepEqual(
    exact.routes.find((route) => route.id === adminRouteId).auth.allowedRoles,
    ['admin'],
  );

  const rejectedKeys = [
    { collection: 'operations', id: 'op:get:/api/admin' },
    { collection: 'routes', id: 'route:/api/admin' },
    { collection: 'operations', id: 'getAdminStatus' },
  ];
  for (const rejected of rejectedKeys) {
    await assert.rejects(
      buildManifest({
        targetBoundary,
        config: configWith({
          discovery: { openapi: ['openapi-complete.json'] },
          trustedOverrides: {
            operations: {},
            routes: {},
            [rejected.collection]: {
              [rejected.id]: { allowedRoles: ['admin'] },
            },
          },
        }),
      }),
      (error) => error?.code === 'OVERRIDE_ID_UNKNOWN',
    );
  }
});

test('applies every canonical operation override field', async () => {
  const targetBoundary = await fixtureBoundary();
  const id = operationId('DELETE', '/api/items/{itemId}');
  const manifest = await buildManifest({
    targetBoundary,
    config: configWith({
      discovery: { openapi: ['openapi-complete.json'] },
      trustedOverrides: {
        operations: {
          [id]: {
            allowedRoles: ['operator', 'admin'],
            parameterExamples: [
              { location: 'path', name: 'itemId', value: 'known-item' },
            ],
            targetModel: 'Item',
            deleteMode: 'hard',
            sideEffects: { classes: ['data-delete'] },
            rollback: 'restore-item',
          },
        },
        routes: {},
      },
    }),
    generatedAt: '2026-07-18T00:00:00.000Z',
  });
  const operation = manifest.operations.find((candidate) => candidate.id === id);

  assert.deepEqual(operation.auth.allowedRoles, ['admin', 'operator']);
  assert.equal(operation.parameters[0].example, 'known-item');
  assert.equal(operation.targetModel, 'Item');
  assert.equal(operation.deleteMode, 'hard');
  assert.deepEqual(operation.sideEffects, { state: 'known', classes: ['data-delete'] });
  assert.equal(operation.rollback, 'restore-item');
});

test('applies canonical qualified route parameter examples', async () => {
  const targetBoundary = await fixtureBoundary();
  const id = routeId('/admin/users/{id}');
  const manifest = await buildManifest({
    targetBoundary,
    config: configWith({
      discovery: { vueRouter: ['vue-complete/router.js'] },
      trustedOverrides: {
        operations: {},
        routes: {
          [id]: {
            allowedRoles: ['admin'],
            parameterExamples: [
              { location: 'path', name: 'id', value: 'known-user' },
            ],
          },
        },
      },
    }),
  });
  const route = manifest.routes.find((candidate) => candidate.id === id);

  assert.deepEqual(route.auth.allowedRoles, ['admin']);
  assert.equal(route.parameters[0].example, 'known-user');
});

test('rejects duplicate canonical qualified examples with stable semantic errors', async () => {
  const targetBoundary = await fixtureBoundary();
  const id = operationId('GET', '/api/items/{itemId}');
  const base = {
    discovery: { openapi: ['openapi-complete.json'] },
    trustedOverrides: {
      operations: {
        [id]: {
          parameterExamples: [
            { location: 'path', name: 'itemId', value: 'known-item' },
            { location: 'path', name: 'itemId', value: 'known-item' },
          ],
        },
      },
      routes: {},
    },
  };
  await assert.rejects(
    buildManifest({ targetBoundary, config: configWith(base) }),
    (error) => error?.code === 'OVERRIDE_INVALID'
      && error?.details?.id === id
      && error?.details?.field === 'parameterExamples',
  );

  base.trustedOverrides.operations[id].parameterExamples[1].value = 'different-item';
  await assert.rejects(
    buildManifest({ targetBoundary, config: configWith(base) }),
    (error) => error?.code === 'MANIFEST_CONFLICT'
      && error?.details?.id === id
      && error?.details?.field === 'parameterExamples',
  );
});

test('rejects parameter examples that do not identify an exact discovered parameter', async () => {
  const targetBoundary = await fixtureBoundary();
  const id = operationId('GET', '/api/items/{itemId}');
  await assert.rejects(
    buildManifest({
      targetBoundary,
      config: configWith({
        discovery: { openapi: ['openapi-complete.json'] },
        trustedOverrides: {
          operations: {
            [id]: {
              parameterExamples: [
                { location: 'query', name: 'itemId', value: 'wrong-location' },
              ],
            },
          },
          routes: {},
        },
      }),
    }),
    (error) => error?.code === 'OVERRIDE_INVALID'
      && error?.details?.id === id
      && error?.details?.field === 'parameterExamples',
  );
});

test('direct buildManifest callers cannot use discovery or override aliases', async () => {
  const targetBoundary = await fixtureBoundary();
  const id = operationId('GET', '/api/admin');
  const canonicalDiscovery = { discovery: { openapi: ['openapi-complete.json'] } };
  const aliases = [
    { openapi: ['openapi-complete.json'] },
    { openapiPaths: ['openapi-complete.json'] },
    { vueRouter: ['vue-complete/router.js'] },
    { vueRouterPaths: ['vue-complete/router.js'] },
    { ...canonicalDiscovery, operationOverrides: { [id]: { allowedRoles: ['admin'] } } },
    { ...canonicalDiscovery, routeOverrides: {} },
    { ...canonicalDiscovery, operationRoles: { [id]: ['admin'] } },
    { ...canonicalDiscovery, routeRoles: {} },
    {
      ...canonicalDiscovery,
      parameterExamples: [{
        operationId: id,
        location: 'query',
        name: 'page',
        value: 1,
      }],
    },
    {
      ...canonicalDiscovery,
      trustedOverrides: { [id]: { allowedRoles: ['admin'] } },
    },
    {
      ...canonicalDiscovery,
      trustedOverrides: {
        operations: { [id]: { parameterExamples: { page: 1 } } },
        routes: {},
      },
    },
    {
      ...canonicalDiscovery,
      trustedOverrides: {
        operations: { [id]: { sideEffects: ['data-write'] } },
        routes: {},
      },
    },
    {
      ...canonicalDiscovery,
      trustedOverrides: {
        operations: {
          [id]: { sideEffects: { classes: ['data-write'], rollback: 'undo' } },
        },
        routes: {},
      },
    },
  ];

  for (const alias of aliases) {
    await assert.rejects(
      buildManifest({ targetBoundary, config: configWith(alias) }),
      (error) => error?.code === 'SCHEMA_INVALID',
      JSON.stringify(alias),
    );
  }
});

test('direct buildManifest rejects inherited discovery before it can select inputs', async () => {
  const targetBoundary = await fixtureBoundary();
  const inherited = Object.create({
    discovery: { openapi: ['openapi-complete.json'] },
  });
  Object.assign(inherited, structuredClone(bundledDefaults));

  await assert.rejects(
    buildManifest({ targetBoundary, config: inherited }),
    (error) => error?.code === 'CONFIG_INVALID',
  );
});

test('direct buildManifest rejects inherited mutation-affecting overrides', async () => {
  const targetBoundary = await fixtureBoundary();
  const id = operationId('DELETE', '/api/items/{itemId}');
  const inherited = Object.create({
    trustedOverrides: {
      operations: {
        [id]: {
          allowedRoles: ['admin'],
          parameterExamples: [
            { location: 'path', name: 'itemId', value: 'known-item' },
          ],
          deleteMode: 'hard',
          sideEffects: { classes: ['data-delete'] },
          rollback: 'restore-item',
        },
      },
      routes: {},
    },
  });
  Object.assign(inherited, configWith({
    discovery: { openapi: ['openapi-complete.json'] },
  }));

  await assert.rejects(
    buildManifest({ targetBoundary, config: inherited }),
    (error) => error?.code === 'CONFIG_INVALID',
  );
});

test('direct buildManifest rejects accessors without invoking them', async () => {
  const targetBoundary = await fixtureBoundary();
  const config = configWith({
    discovery: { openapi: ['openapi-complete.json'] },
  });
  let getterCalls = 0;
  Object.defineProperty(config, 'trustedOverrides', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { operations: {}, routes: {} };
    },
  });

  await assert.rejects(
    buildManifest({ targetBoundary, config }),
    (error) => error?.code === 'CONFIG_INVALID',
  );
  assert.equal(getterCalls, 0);
});

test('direct buildManifest rejects nested objects with inherited config data', async () => {
  const targetBoundary = await fixtureBoundary();
  const id = operationId('GET', '/api/items/{itemId}');
  const override = Object.create({
    parameterExamples: [
      { location: 'path', name: 'itemId', value: 'inherited-item' },
    ],
  });
  const config = configWith({
    discovery: { openapi: ['openapi-complete.json'] },
    trustedOverrides: {
      operations: { [id]: override },
      routes: {},
    },
  });

  await assert.rejects(
    buildManifest({ targetBoundary, config }),
    (error) => error?.code === 'CONFIG_INVALID',
  );
});

test('direct buildManifest enforces the browser settle timeout invariant', async () => {
  const targetBoundary = await fixtureBoundary();

  await assert.rejects(
    buildManifest({
      targetBoundary,
      config: configWith({
        discovery: { openapi: ['openapi-complete.json'] },
        responseTimeoutMs: 500,
        browserSettleMs: 500,
      }),
    }),
    { code: 'CONFIG_BROWSER_SETTLE_INVALID' },
  );
});

test('missing canonical discovery remains the semantic DISCOVERY_REQUIRED error', async () => {
  const targetBoundary = await fixtureBoundary();
  await assert.rejects(
    buildManifest({ targetBoundary, config: configWith() }),
    (error) => error?.code === 'DISCOVERY_REQUIRED',
  );
});

test('merges identical duplicate records and rejects semantic conflicts', async () => {
  const targetBoundary = await fixtureBoundary();

  const identical = await buildManifest({
    targetBoundary,
    config: configWith({
      discovery: { openapi: ['openapi-complete.json', 'openapi-complete.json'] },
    }),
    generatedAt: '2026-07-18T00:00:00.000Z',
  });
  assert.equal(new Set(identical.operations.map((operation) => operation.id)).size, identical.operations.length);

  await assert.rejects(
    buildManifest({
      targetBoundary,
      config: configWith({
        discovery: { openapi: ['openapi-complete.json', 'openapi-unsupported.json'] },
      }),
      generatedAt: '2026-07-18T00:00:00.000Z',
    }),
    (error) => error?.code === 'MANIFEST_CONFLICT',
  );
});
