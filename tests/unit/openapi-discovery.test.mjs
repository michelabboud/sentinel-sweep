import assert from 'node:assert/strict';
import { mkdtemp, cp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverOpenApi } from '../../runtime/discovery/openapi.mjs';
import { SentinelError } from '../../runtime/lib/errors.mjs';
import { TargetBoundary } from '../../runtime/lib/fs-boundary.mjs';

const fixtureDirectory = fileURLToPath(new URL('../fixtures/discovery/', import.meta.url));
const DISCOVERY_INPUT_LIMIT = 16 * 1024 * 1024;

async function fixtureBoundary() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sentinel-openapi-'));
  await cp(fixtureDirectory, root, { recursive: true });
  return TargetBoundary.create(root);
}

test('discovers complete OpenAPI operations, schemas, auth, examples, and conservative side effects', async () => {
  const boundary = await fixtureBoundary();
  const result = await discoverOpenApi({ boundary, relativePath: 'openapi-complete.json' });

  assert.deepEqual(result.coverage, { adapter: 'openapi-json', status: 'complete', gaps: [] });
  assert.equal(result.operations.find((operation) => operation.id === 'op:get:/api/admin').auth.state, 'required');
  assert.equal(result.operations.find((operation) => operation.id === 'op:post:/api/items').requestBody.schemaId, 'schema:openapi:ItemCreate');
  assert.equal(result.operations.find((operation) => operation.id === 'op:get:/api/items/{itemId}').parameters[0].example, 'known-item');
  assert.deepEqual(result.operations.find((operation) => operation.method === 'POST').sideEffects, { state: 'unknown', classes: [] });
  assert.deepEqual(result.operations.find((operation) => operation.method === 'GET').sideEffects, { state: 'known', classes: [] });
  assert.deepEqual(result.operations.map((operation) => operation.id), [
    'op:get:/api/admin',
    'op:get:/api/items',
    'op:post:/api/items',
    'op:get:/api/items/{itemId}',
    'op:delete:/api/items/{itemId}',
    'op:get:/api/public'
  ]);
  assert.equal(result.schemas.find((schema) => schema.id === 'schema:openapi:Item').provenance.pointer, '#/components/schemas/Item');
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.message.includes('x-sentinel-allowed-roles')));
  assert.deepEqual(result.operations.find((operation) => operation.id === 'op:get:/api/admin').auth.allowedRoles, []);
});

test('keeps proven operations while reporting unsupported OpenAPI patterns as stable partial gaps', async () => {
  const boundary = await fixtureBoundary();
  const result = await discoverOpenApi({ boundary, relativePath: 'openapi-unsupported.json' });

  assert.equal(result.coverage.status, 'partial');
  assert.deepEqual(result.operations.map((operation) => operation.id), [
    'op:post:/api/events',
    'op:get:/api/public'
  ]);
  assert.deepEqual(result.coverage.gaps, [
    'callback:#/paths/~1api~1events/post/callbacks',
    'external-ref:#/paths/~1api~1events/post/responses/202/content/application~1json/schema/$ref',
    'non-json-content:#/paths/~1api~1events/post/requestBody/content/text~1plain',
    'webhook:#/webhooks/newEvent'
  ]);
});

test('bounds OpenAPI reads and reports an oversized input as coverage evidence', async () => {
  let observedOptions;
  const complete = await discoverOpenApi({
    boundary: {
      async readText(relativePath, options) {
        assert.equal(relativePath, 'openapi.json');
        observedOptions = options;
        return '{"openapi":"3.1.0","paths":{}}';
      },
    },
    relativePath: 'openapi.json',
  });
  assert.deepEqual(observedOptions, { maxBytes: DISCOVERY_INPUT_LIMIT });
  assert.equal(complete.coverage.status, 'complete');

  const oversized = await discoverOpenApi({
    boundary: {
      async readText(relativePath, options) {
        assert.equal(relativePath, 'oversized.json');
        assert.deepEqual(options, { maxBytes: DISCOVERY_INPUT_LIMIT });
        throw new SentinelError(
          'INPUT_SIZE_LIMIT',
          'Input exceeds the configured read limit',
          { maxBytes: DISCOVERY_INPUT_LIMIT },
        );
      },
    },
    relativePath: 'oversized.json',
  });
  assert.deepEqual(oversized.coverage, {
    adapter: 'openapi-json',
    status: 'partial',
    gaps: ['size-limit:oversized.json'],
  });
  assert.deepEqual(oversized.diagnostics, [{
    code: 'OPENAPI_SIZE_LIMIT',
    message: `OpenAPI discovery input oversized.json exceeds the ${DISCOVERY_INPUT_LIMIT}-byte limit`,
    sourcePath: 'oversized.json',
    pointer: '/',
  }]);
  assert.deepEqual(oversized.routes, []);
  assert.deepEqual(oversized.operations, []);
  assert.deepEqual(oversized.schemas, []);
});

test('rejects unsupported OpenAPI versions and unsafe document paths', async () => {
  const boundary = await fixtureBoundary();
  await writeFile(path.join(boundary.root, 'openapi-v2.json'), JSON.stringify({ openapi: '2.0.0', paths: {} }));

  await assert.rejects(
    discoverOpenApi({ boundary, relativePath: 'openapi-v2.json' }),
    /OpenAPI 3\.0 or 3\.1/
  );
  await assert.rejects(
    discoverOpenApi({ boundary, relativePath: '/tmp/openapi.json' }),
    /relative/i
  );
  await assert.rejects(
    discoverOpenApi({ boundary, relativePath: '//example.invalid/openapi.json' }),
    /relative/i
  );
});
