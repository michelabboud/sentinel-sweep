import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildManifest } from '../../runtime/discovery/index.mjs';
import { TargetBoundary } from '../../runtime/lib/fs-boundary.mjs';
import { operationId } from '../../runtime/lib/identity.mjs';

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
      framework: { frontend: 'none', backend: 'unknown' }
    },
    discovery: {
      openapi: ['openapi-complete.json']
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
