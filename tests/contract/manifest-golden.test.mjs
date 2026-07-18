import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildManifest } from '../../runtime/discovery/index.mjs';
import { TargetBoundary } from '../../runtime/lib/fs-boundary.mjs';
import { operationId, routeId } from '../../runtime/lib/identity.mjs';

const fixtureDirectory = fileURLToPath(new URL('../fixtures/discovery/', import.meta.url));
const goldenPath = fileURLToPath(new URL('../fixtures/discovery/openapi-complete.manifest.json', import.meta.url));

function stripGeneratedAt(manifest) {
  const { generatedAt: _generatedAt, ...stable } = manifest;
  return stable;
}

async function fixtureBoundary() {
  return TargetBoundary.create(fixtureDirectory);
}

function completeConfig() {
  return {
    target: {
      name: 'openapi-fixture',
      root: 'tests/fixtures/discovery',
      framework: { frontend: 'vue', backend: 'unknown' }
    },
    discovery: {
      openapi: ['openapi-complete.json'],
      vueRouter: [
        'vue-complete/router.js',
        'vue-complete/public-router.ts'
      ]
    },
    trustedOverrides: {
      [operationId('GET', '/api/admin')]: {
        allowedRoles: ['admin'],
        targetModel: 'admin-read'
      },
      [operationId('POST', '/api/items')]: {
        allowedRoles: ['editor'],
        parameterExamples: {},
        sideEffects: {
          classes: ['data-write'],
          rollback: 'delete-created-item'
        }
      },
      [operationId('DELETE', '/api/items/{itemId}')]: {
        allowedRoles: ['admin'],
        deleteMode: 'hard',
        sideEffects: {
          classes: ['data-delete'],
          rollback: null
        }
      }
    }
  };
}

test('builds the strict golden manifest and remains deterministic', async () => {
  const targetBoundary = await fixtureBoundary();
  const config = completeConfig();
  const goldenManifest = JSON.parse(await readFile(goldenPath, 'utf8'));

  const first = stripGeneratedAt(await buildManifest({ targetBoundary, config, generatedAt: '2026-07-18T00:00:00.000Z' }));
  const second = stripGeneratedAt(await buildManifest({ targetBoundary, config, generatedAt: '2030-01-01T00:00:00.000Z' }));

  assert.ok(first.routes.some((route) => route.path === '/admin/users/{id}'));
  assert.deepEqual(
    first.routes.find((route) => route.path === '/admin').auth.allowedRoles,
    [],
  );
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

test('rejects trusted overrides for IDs absent from discovery', async () => {
  const targetBoundary = await fixtureBoundary();

  await assert.rejects(
    buildManifest({
      targetBoundary,
      config: {
        target: completeConfig().target,
        discovery: { openapi: ['openapi-complete.json'] },
        trustedOverrides: {
          'missing-operation-id': { allowedRoles: ['admin'] }
        }
      }
    }),
    /override.*missing-operation-id/i
  );
});

test('accepts only exact discovered stable IDs for operation and route overrides', async () => {
  const targetBoundary = await fixtureBoundary();
  const adminOperationId = operationId('GET', '/api/admin');
  const adminRouteId = routeId('/api/admin');
  const exact = await buildManifest({
    targetBoundary,
    config: {
      target: completeConfig().target,
      discovery: { openapi: ['openapi-complete.json'] },
      trustedOverrides: {
        operations: {
          [adminOperationId]: { allowedRoles: ['admin'] }
        },
        routes: {
          [adminRouteId]: { allowedRoles: ['admin'] }
        }
      }
    }
  });

  assert.deepEqual(
    exact.operations.find((operation) => operation.id === adminOperationId).auth.allowedRoles,
    ['admin']
  );
  assert.deepEqual(
    exact.routes.find((route) => route.id === adminRouteId).auth.allowedRoles,
    ['admin']
  );

  const rejectedKeys = [
    { collection: 'operations', id: 'op:get:/api/admin' },
    { collection: 'routes', id: 'route:/api/admin' },
    { collection: 'operations', id: 'getAdminStatus' }
  ];
  for (const rejected of rejectedKeys) {
    await assert.rejects(
      buildManifest({
        targetBoundary,
        config: {
          target: completeConfig().target,
          discovery: { openapi: ['openapi-complete.json'] },
          trustedOverrides: {
            [rejected.collection]: {
              [rejected.id]: { allowedRoles: ['admin'] }
            }
          }
        }
      }),
      (error) => error?.code === 'OVERRIDE_ID_UNKNOWN'
    );
  }
});

test('coalesces semantically identical override definitions from every trusted source', async () => {
  const targetBoundary = await fixtureBoundary();
  const id = operationId('DELETE', '/api/items/{itemId}');
  const manifest = await buildManifest({
    targetBoundary,
    config: {
      target: completeConfig().target,
      discovery: { openapi: ['openapi-complete.json'] },
      trustedOverrides: {
        operations: {
          [id]: {
            allowedRoles: ['operator', 'admin'],
            parameterExamples: { path: { itemId: 'known-item' } },
            targetModel: 'Item',
            deleteMode: 'hard',
            sideEffects: {
              classes: ['data-delete'],
              rollback: 'restore-item'
            }
          }
        }
      },
      operationOverrides: {
        [id]: {
          allowedRoles: ['admin', 'operator'],
          parameterExamples: { 'path:itemId': 'known-item' },
          targetModel: 'Item',
          deleteMode: 'hard',
          sideEffects: ['data-delete'],
          rollback: 'restore-item'
        }
      },
      operationRoles: {
        [id]: ['admin', 'operator']
      },
      parameterExamples: [
        {
          operationId: id,
          location: 'path',
          name: 'itemId',
          value: 'known-item'
        }
      ]
    },
    generatedAt: '2026-07-18T00:00:00.000Z'
  });
  const operation = manifest.operations.find((candidate) => candidate.id === id);

  assert.deepEqual(operation.auth.allowedRoles, ['admin', 'operator']);
  assert.equal(operation.parameters[0].example, 'known-item');
  assert.equal(operation.targetModel, 'Item');
  assert.equal(operation.deleteMode, 'hard');
  assert.deepEqual(operation.sideEffects, { state: 'known', classes: ['data-delete'] });
  assert.equal(operation.rollback, 'restore-item');
});

test('rejects conflicting generic and qualified parameter-example aliases before application', async () => {
  const targetBoundary = await fixtureBoundary();
  const id = operationId('GET', '/api/items/{itemId}');
  const conflicts = [
    {
      generic: 'itemId',
      qualified: 'path:itemId',
      genericValue: 'generic-item',
      qualifiedValue: 'qualified-item'
    },
    {
      generic: 'includeDetails',
      qualified: 'query:includeDetails',
      genericValue: false,
      qualifiedValue: true
    }
  ];

  for (const conflict of conflicts) {
    await assert.rejects(
      buildManifest({
        targetBoundary,
        config: {
          target: completeConfig().target,
          discovery: { openapi: ['openapi-complete.json'] },
          trustedOverrides: {
            operations: {
              [id]: {
                parameterExamples: {
                  [conflict.generic]: conflict.genericValue,
                  [conflict.qualified]: conflict.qualifiedValue
                }
              }
            }
          }
        }
      }),
      (error) => error?.code === 'MANIFEST_CONFLICT'
        && error?.details?.id === id
        && error?.details?.field === 'parameterExamples',
      conflict.qualified
    );
  }
});

test('coalesces identical generic and qualified parameter-example aliases deterministically', async () => {
  const targetBoundary = await fixtureBoundary();
  const id = operationId('GET', '/api/items/{itemId}');
  const build = (parameterExamples) => buildManifest({
    targetBoundary,
    config: {
      target: completeConfig().target,
      discovery: { openapi: ['openapi-complete.json'] },
      trustedOverrides: {
        operations: {
          [id]: { parameterExamples }
        }
      }
    },
    generatedAt: '2026-07-18T00:00:00.000Z'
  });
  const genericFirst = await build({
    itemId: 'known-item',
    'path:itemId': 'known-item',
    includeDetails: true,
    'query:includeDetails': true
  });
  const qualifiedFirst = await build({
    'query:includeDetails': true,
    includeDetails: true,
    'path:itemId': 'known-item',
    itemId: 'known-item'
  });
  const operation = genericFirst.operations.find((candidate) => candidate.id === id);

  assert.deepEqual(genericFirst, qualifiedFirst);
  assert.equal(operation.parameters.find((parameter) => parameter.name === 'itemId').example, 'known-item');
  assert.equal(operation.parameters.find((parameter) => parameter.name === 'includeDetails').example, true);
});

test('rejects conflicting override fields across trusted sources before application', async () => {
  const targetBoundary = await fixtureBoundary();
  const adminId = operationId('GET', '/api/admin');
  const itemId = operationId('GET', '/api/items/{itemId}');
  const postId = operationId('POST', '/api/items');
  const deleteId = operationId('DELETE', '/api/items/{itemId}');
  const cases = [
    {
      field: 'allowedRoles',
      id: adminId,
      trusted: { allowedRoles: ['admin'] },
      extra: { operationRoles: { [adminId]: ['operator'] } }
    },
    {
      field: 'parameterExamples',
      id: itemId,
      trusted: { parameterExamples: { 'path:itemId': 'known-item' } },
      extra: {
        parameterExamples: [{
          operationId: itemId,
          location: 'path',
          name: 'itemId',
          value: 'different-item'
        }]
      }
    },
    {
      field: 'parameterExamples',
      id: itemId,
      trusted: { parameterExamples: { 'path:itemId': 'known-item' } },
      extra: {
        parameterExamples: [
          {
            operationId: itemId,
            location: 'path',
            name: 'itemId',
            value: 'different-item'
          },
          {
            operationId: itemId,
            location: 'path',
            name: 'itemId',
            value: 'known-item'
          }
        ]
      }
    },
    {
      field: 'targetModel',
      id: adminId,
      trusted: { targetModel: 'Admin' },
      extra: { operationOverrides: { [adminId]: { targetModel: 'User' } } }
    },
    {
      field: 'deleteMode',
      id: deleteId,
      trusted: { deleteMode: 'soft' },
      extra: { operationOverrides: { [deleteId]: { deleteMode: 'hard' } } }
    },
    {
      field: 'sideEffects',
      id: postId,
      trusted: { sideEffects: { classes: ['data-write'] } },
      extra: { operationOverrides: { [postId]: { sideEffects: ['email-send'] } } }
    },
    {
      field: 'rollback',
      id: postId,
      trusted: { sideEffects: { classes: ['data-write'], rollback: 'undo-create' } },
      extra: { operationOverrides: { [postId]: { rollback: 'archive-create' } } }
    }
  ];

  for (const conflict of cases) {
    await assert.rejects(
      buildManifest({
        targetBoundary,
        config: {
          target: completeConfig().target,
          discovery: { openapi: ['openapi-complete.json'] },
          trustedOverrides: {
            operations: {
              [conflict.id]: conflict.trusted
            }
          },
          ...conflict.extra
        }
      }),
      (error) => error?.code === 'MANIFEST_CONFLICT'
        && error?.details?.id === conflict.id
        && error?.details?.field === conflict.field,
      conflict.field
    );
  }
});

test('merges identical duplicate records and rejects semantic conflicts', async () => {
  const targetBoundary = await fixtureBoundary();

  const identical = await buildManifest({
    targetBoundary,
    config: {
      target: completeConfig().target,
      discovery: { openapi: ['openapi-complete.json', 'openapi-complete.json'] }
    },
    generatedAt: '2026-07-18T00:00:00.000Z'
  });
  assert.equal(new Set(identical.operations.map((operation) => operation.id)).size, identical.operations.length);

  await assert.rejects(
    buildManifest({
      targetBoundary,
      config: {
        target: completeConfig().target,
        discovery: { openapi: ['openapi-complete.json', 'openapi-unsupported.json'] }
      },
      generatedAt: '2026-07-18T00:00:00.000Z'
    }),
    (error) => error?.code === 'MANIFEST_CONFLICT'
  );
});
