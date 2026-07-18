import assert from 'node:assert/strict';
import test from 'node:test';

import { sweepApi } from '../../runtime/api/sweep.mjs';
import { buildExecutionPlan } from '../../runtime/policy/execution.mjs';
import { startHttpFixture } from '../fixtures/http-app.mjs';

const ADMIN_TOKEN = 'sentinel-admin-fixture-secret';
const USER_TOKEN = 'sentinel-user-fixture-secret';

function operation(id, path, overrides = {}) {
  const method = overrides.method ?? 'GET';
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  return {
    id,
    method,
    path,
    summary: null,
    parameters: [],
    requestBody: null,
    responses: { '200': { contentType: 'application/json', schemaId: null } },
    auth: { state: 'public', allowedRoles: [] },
    targetModel: null,
    deleteMode: method === 'DELETE' ? 'soft' : null,
    sideEffects: mutation
      ? { state: 'known', classes: ['test-fixture-write'] }
      : { state: 'known', classes: [] },
    rollback: mutation ? 'restore-test-fixture' : null,
    mutation,
    protocol: 'http',
    sweepable: !mutation,
    risk: { score: mutation ? 25 : 0, level: 'safe', reasons: [] },
    provenance: { adapter: 'openapi-json', file: 'fixture.json', pointer: `/paths/${id}` },
    originId: 'api',
    ...overrides,
  };
}

function manifest() {
  const publicResponse = { '200': { contentType: 'application/json', schemaId: 'schema:ok' } };
  const adminResponse = { '200': { contentType: 'application/json', schemaId: 'schema:health' } };
  return {
    operations: [
      operation('public', '/public', { responses: publicResponse }),
      operation('user', '/user', {
        auth: { state: 'required', allowedRoles: ['admin', 'user'] },
        responses: { '200': { contentType: 'application/json', schemaId: 'schema:user' } },
      }),
      operation('admin', '/admin', {
        auth: { state: 'required', allowedRoles: ['admin'] },
        parameters: [
          {
            name: 'Authorization',
            location: 'header',
            required: false,
            schema: { type: 'string' },
            example: `Bearer ${ADMIN_TOKEN}`,
          },
          {
            name: 'session',
            location: 'cookie',
            required: false,
            schema: { type: 'string' },
            example: 'manifest-session-credential',
          },
        ],
        responses: adminResponse,
      }),
      operation('drift', '/drift', { responses: adminResponse }),
      operation('json-content-type', '/json-text', {
        responses: { '200': { contentType: 'application/json', schemaId: null } },
      }),
      operation('json-malformed', '/json-malformed', {
        responses: { '200': { contentType: 'application/json', schemaId: null } },
      }),
      operation('json-valid', '/json-valid', {
        responses: { '200': { contentType: 'application/json', schemaId: null } },
      }),
      operation('json-problem', '/json-problem', {
        responses: { '200': { contentType: 'application/problem+json', schemaId: null } },
      }),
      operation('same-redirect', '/redirect/same', { responses: publicResponse }),
      operation('cross-redirect', '/redirect/cross', { responses: publicResponse }),
      operation('slow', '/slow', { responses: publicResponse }),
      operation('oversized', '/oversized'),
      operation('post', '/post', {
        method: 'POST',
        responses: { '201': { contentType: 'application/json', schemaId: null } },
      }),
      operation('delete', '/delete', {
        method: 'DELETE',
        responses: { '204': { contentType: null, schemaId: null } },
      }),
    ],
    schemas: {
      'schema:ok': {
        schema: {
          type: 'object',
          required: ['ok'],
          properties: { ok: { type: 'boolean' } },
        },
      },
      'schema:health': {
        schema: {
          type: 'object',
          required: ['healthy'],
          properties: { healthy: { type: 'boolean' } },
        },
      },
      'schema:user': {
        schema: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' } },
        },
      },
    },
  };
}

function config(origin) {
  return {
    approvedOrigins: [origin],
    services: [{ name: 'api', approvedOrigin: origin, sourcePath: '.' }],
    roles: {
      admin: { tokenRef: 'env:SENTINEL_TEST_ADMIN_TOKEN' },
      user: { tokenRef: 'env:SENTINEL_TEST_USER_TOKEN' },
    },
    allowMutations: false,
    mutationAllowlist: ['post', 'delete'],
    targetEnvironment: 'test',
    responseTimeoutMs: 500,
    maxResponseBytes: 256,
  };
}

function find(observations, subjectId, role = null) {
  return observations.find((entry) => entry.subjectId === subjectId && entry.role === role);
}

test('runs live API and RBAC checks while recording denials, drift, limits, and skips safely', async (t) => {
  const fixture = await startHttpFixture({
    adminToken: ADMIN_TOKEN,
    userToken: USER_TOKEN,
    slowDelayMs: 2000,
  });
  t.after(() => fixture.close());
  const apiManifest = manifest();
  const apiConfig = config(fixture.origin);
  const plan = buildExecutionPlan({
    manifest: apiManifest,
    config: apiConfig,
    mode: 'api',
    sandboxAcknowledged: false,
  });

  const observations = await sweepApi({
    manifest: apiManifest,
    plan,
    config: apiConfig,
    env: {
      SENTINEL_TEST_ADMIN_TOKEN: ADMIN_TOKEN,
      SENTINEL_TEST_USER_TOKEN: USER_TOKEN,
    },
  });

  const publicObservation = find(observations, 'public');
  assert.equal(publicObservation.outcome, 'pass', JSON.stringify(publicObservation));
  assert.equal(publicObservation.evidence.status, 200);

  assert.equal(find(observations, 'admin').outcome, 'pass');
  assert.equal(find(observations, 'admin').reasonCode, 'RBAC_DENIAL_EXPECTED');
  assert.equal(find(observations, 'admin').evidence.status, 401);
  assert.equal(find(observations, 'admin', 'user').outcome, 'pass');
  assert.equal(find(observations, 'admin', 'user').evidence.status, 403);
  assert.equal(find(observations, 'admin', 'admin').outcome, 'pass');
  assert.equal(find(observations, 'admin', 'admin').evidence.status, 200);
  const adminRequests = fixture.approvedRequests.filter((request) => request.path === '/admin');
  assert.equal(adminRequests[0].headers.authorization, undefined);
  assert.equal(adminRequests[0].headers.cookie, undefined);

  assert.equal(find(observations, 'user').evidence.status, 401);
  assert.equal(find(observations, 'user', 'user').evidence.status, 200);
  assert.equal(find(observations, 'user', 'admin').evidence.status, 200);

  assert.equal(find(observations, 'drift').outcome, 'fail');
  assert.equal(find(observations, 'drift').reasonCode, 'SCHEMA_VIOLATION');
  assert.deepEqual(find(observations, 'drift').evidence.schemaViolations, [
    { path: '/healthy', keyword: 'type' },
  ]);
  assert.equal(find(observations, 'json-content-type').outcome, 'fail');
  assert.equal(find(observations, 'json-content-type').reasonCode, 'CONTENT_TYPE_MISMATCH');
  assert.equal(find(observations, 'json-content-type').expected, 'application/json');
  assert.equal(find(observations, 'json-content-type').actual, 'text/plain');
  assert.equal(find(observations, 'json-malformed').outcome, 'fail');
  assert.equal(find(observations, 'json-malformed').reasonCode, 'JSON_RESPONSE_INVALID');
  assert.equal(find(observations, 'json-valid').outcome, 'pass');
  assert.equal(find(observations, 'json-valid').reasonCode, 'HTTP_STATUS_EXPECTED');
  assert.equal(find(observations, 'json-problem').outcome, 'pass');
  assert.equal(find(observations, 'json-problem').reasonCode, 'HTTP_STATUS_EXPECTED');
  assert.equal(find(observations, 'same-redirect').evidence.status, 200);
  assert.equal(find(observations, 'same-redirect').evidence.redirects, 1);
  assert.equal(find(observations, 'cross-redirect').reasonCode, 'REDIRECT_ORIGIN_BLOCKED');
  assert.equal(find(observations, 'slow').reasonCode, 'HTTP_TIMEOUT');
  assert.equal(find(observations, 'oversized').reasonCode, 'RESPONSE_TOO_LARGE');

  assert.equal(find(observations, 'post').outcome, 'skip');
  assert.equal(find(observations, 'post').reasonCode, 'MUTATION_BLOCKED_DISABLED');
  assert.equal(find(observations, 'delete').outcome, 'skip');
  assert.deepEqual(fixture.mutations, { post: 0, delete: 0 });
  assert.equal(fixture.receiverRequests.length, 0);

  for (const observation of observations) {
    assert.ok(Object.isFrozen(observation));
    assert.ok(Object.isFrozen(observation.evidence));
    assert.deepEqual(
      Object.keys(observation).sort(),
      [
        'actual', 'category', 'evidence', 'expected', 'message', 'outcome',
        'reasonCode', 'role', 'severity', 'source', 'subjectId',
      ],
    );
    assert.equal(observation.source, 'api');
  }

  const serialized = JSON.stringify(observations);
  assert.equal(serialized.includes(ADMIN_TOKEN), false);
  assert.equal(serialized.includes(USER_TOKEN), false);
  assert.equal(serialized.includes('authorization'), false);
  assert.equal(serialized.includes(fixture.origin), false);
  assert.equal(serialized.includes(fixture.receiverOrigin), false);
});

test('reports an allowed role whose trusted credential mapping is missing', async (t) => {
  const fixture = await startHttpFixture({ adminToken: ADMIN_TOKEN, userToken: USER_TOKEN });
  t.after(() => fixture.close());
  const apiManifest = {
    operations: [operation('admin', '/admin', {
      auth: { state: 'required', allowedRoles: ['admin'] },
      responses: { '200': { contentType: 'application/json', schemaId: null } },
    })],
    schemas: {},
  };
  const apiConfig = {
    ...config(fixture.origin),
    roles: { user: { tokenRef: 'env:SENTINEL_TEST_USER_TOKEN' } },
  };
  const plan = buildExecutionPlan({
    manifest: apiManifest,
    config: apiConfig,
    mode: 'api',
    sandboxAcknowledged: false,
  });

  const observations = await sweepApi({
    manifest: apiManifest,
    plan,
    config: apiConfig,
    env: { SENTINEL_TEST_USER_TOKEN: USER_TOKEN },
  });

  const missingAdmin = find(observations, 'admin', 'admin');
  assert.ok(missingAdmin);
  assert.equal(missingAdmin.outcome, 'fail');
  assert.equal(missingAdmin.reasonCode, 'ROLE_CREDENTIAL_UNCONFIGURED');
  assert.equal(
    fixture.approvedRequests.filter((request) => request.path === '/admin').length,
    2,
  );
});
