import assert from 'node:assert/strict';
import test from 'node:test';

import { sweepApi } from '../../runtime/api/sweep.mjs';
import {
  buildExecutionPlan,
  planOperation,
} from '../../runtime/policy/execution.mjs';
import {
  HTTP_REDIRECT_QUERY_CANARY,
  startHttpFixture,
} from '../fixtures/http-app.mjs';

const ADMIN_TOKEN = 'sentinel-admin-fixture-secret';
const USER_TOKEN = 'sentinel-user-fixture-secret';
const PLANNED_PATH_CANARY = 'sentinel-planned-api-path-secret';
const PLANNED_QUERY_CANARY = 'q7';

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
      operation('public-login-redirect', '/public-login-redirect', {
        responses: { '200': { contentType: 'application/json', schemaId: null } },
      }),
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
      operation('admin-login-redirect', '/admin-login-redirect', {
        auth: { state: 'required', allowedRoles: ['admin'] },
        responses: { '200': { contentType: 'application/json', schemaId: null } },
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
  const publicLoginRedirect = find(observations, 'public-login-redirect');
  assert.equal(publicLoginRedirect.outcome, 'fail');
  assert.equal(publicLoginRedirect.reasonCode, 'REDIRECT_TARGET_MISMATCH');
  assert.equal(publicLoginRedirect.evidence.path, '/public-login-redirect');

  assert.equal(find(observations, 'admin').outcome, 'pass');
  assert.equal(find(observations, 'admin').reasonCode, 'RBAC_DENIAL_EXPECTED');
  assert.equal(find(observations, 'admin').evidence.status, 401);
  assert.equal(find(observations, 'admin', 'user').outcome, 'pass');
  assert.equal(find(observations, 'admin', 'user').evidence.status, 403);
  assert.equal(find(observations, 'admin', 'admin').outcome, 'pass');
  assert.equal(find(observations, 'admin', 'admin').evidence.status, 200);
  assert.equal(
    find(observations, 'admin-login-redirect', 'admin').reasonCode,
    'REDIRECT_TARGET_MISMATCH',
  );
  assert.equal(find(observations, 'admin-login-redirect', 'admin').outcome, 'fail');
  const adminRequests = fixture.approvedRequests.filter((request) => request.path === '/admin');
  assert.equal(adminRequests[0].headers.authorization, undefined);
  assert.equal(adminRequests[0].headers.cookie, undefined);

  assert.equal(find(observations, 'user').evidence.status, 401);
  assert.equal(find(observations, 'user', 'user').evidence.status, 200);
  assert.equal(find(observations, 'user', 'admin').evidence.status, 200);

  assert.equal(find(observations, 'drift').outcome, 'fail');
  assert.equal(find(observations, 'drift').reasonCode, 'SCHEMA_VIOLATION');
  assert.deepEqual(find(observations, 'drift').evidence.schemaViolations, [
    { path: '/[SCHEMA_PATH_REDACTED]', keyword: 'type' },
  ]);
  assert.equal(find(observations, 'json-content-type').outcome, 'fail');
  assert.equal(find(observations, 'json-content-type').reasonCode, 'CONTENT_TYPE_MISMATCH');
  assert.equal(find(observations, 'json-content-type').expected, 'application/json');
  assert.equal(find(observations, 'json-content-type').actual, 'different valid media type');
  assert.equal(find(observations, 'json-malformed').outcome, 'fail');
  assert.equal(find(observations, 'json-malformed').reasonCode, 'JSON_RESPONSE_INVALID');
  assert.equal(find(observations, 'json-valid').outcome, 'pass');
  assert.equal(find(observations, 'json-valid').reasonCode, 'HTTP_STATUS_EXPECTED');
  assert.equal(find(observations, 'json-problem').outcome, 'pass');
  assert.equal(find(observations, 'json-problem').reasonCode, 'HTTP_STATUS_EXPECTED');
  assert.equal(find(observations, 'same-redirect').reasonCode, 'REDIRECT_TARGET_MISMATCH');
  assert.equal(find(observations, 'same-redirect').evidence.status, 302);
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
  assert.equal(serialized.includes(HTTP_REDIRECT_QUERY_CANARY), false);
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

test('ignores inherited and accessor response definitions for real HTTP results', async () => {
  const apiManifest = {
    operations: [operation('prototype-status', '/prototype-status')],
    schemas: {},
  };
  const apiConfig = config('http://127.0.0.1:4317');
  const plan = buildExecutionPlan({
    manifest: apiManifest,
    config: apiConfig,
    mode: 'api',
  });
  let accessorReads = 0;

  const run = () => sweepApi({
    manifest: apiManifest,
    plan,
    config: apiConfig,
    fetchImpl: async () => new Response('{"error":true}', {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }),
  });

  try {
    Object.defineProperty(Object.prototype, '500', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: { contentType: 'application/json', schemaId: null },
    });
    assert.equal(find(await run(), 'prototype-status').reasonCode, 'HTTP_STATUS_UNEXPECTED');

    delete Object.prototype['500'];
    Object.defineProperty(Object.prototype, '500', {
      configurable: true,
      enumerable: false,
      get() {
        accessorReads += 1;
        return { contentType: 'application/json', schemaId: null };
      },
    });
    assert.equal(find(await run(), 'prototype-status').reasonCode, 'HTTP_STATUS_UNEXPECTED');
    assert.equal(accessorReads, 0);
  } finally {
    delete Object.prototype['500'];
  }
});

test('ignores inherited and accessor schema registry records', async () => {
  const schemaId = 'schema:prototype-only';
  const apiManifest = {
    operations: [operation('prototype-schema', '/prototype-schema', {
      responses: { '200': { contentType: 'application/json', schemaId } },
    })],
    schemas: {},
  };
  const apiConfig = config('http://127.0.0.1:4317');
  let plan = buildExecutionPlan({
    manifest: apiManifest,
    config: apiConfig,
    mode: 'api',
  });
  let accessorReads = 0;
  const run = () => sweepApi({
    manifest: apiManifest,
    plan,
    config: apiConfig,
    fetchImpl: async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });
  const prototypeRecord = {
    schema: {
      type: 'object',
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    },
  };

  try {
    Object.defineProperty(Object.prototype, schemaId, {
      configurable: true,
      enumerable: false,
      value: prototypeRecord,
    });
    assert.equal(find(await run(), 'prototype-schema').reasonCode, 'SCHEMA_NOT_FOUND');

    delete Object.prototype[schemaId];
    Object.defineProperty(Object.prototype, schemaId, {
      configurable: true,
      enumerable: false,
      get() {
        accessorReads += 1;
        return prototypeRecord;
      },
    });
    assert.equal(find(await run(), 'prototype-schema').reasonCode, 'SCHEMA_NOT_FOUND');
    assert.equal(accessorReads, 0);

    delete Object.prototype[schemaId];
    apiManifest.schemas = {
      'schema:root': {
        schema: { $ref: schemaId },
      },
    };
    apiManifest.operations[0].responses = {
      '200': { contentType: 'application/json', schemaId: 'schema:root' },
    };
    plan = buildExecutionPlan({
      manifest: apiManifest,
      config: apiConfig,
      mode: 'api',
    });
    Object.defineProperty(Object.prototype, schemaId, {
      configurable: true,
      enumerable: false,
      value: prototypeRecord,
    });
    assert.equal(find(await run(), 'prototype-schema').reasonCode, 'SCHEMA_VIOLATION');

    delete Object.prototype[schemaId];
    Object.defineProperty(Object.prototype, schemaId, {
      configurable: true,
      enumerable: false,
      get() {
        accessorReads += 1;
        return prototypeRecord;
      },
    });
    assert.equal(find(await run(), 'prototype-schema').reasonCode, 'SCHEMA_VIOLATION');
    assert.equal(accessorReads, 0);
  } finally {
    delete Object.prototype[schemaId];
  }
});

test('rejects a protected redirect that rewrites the planned HTTP method', async () => {
  const protectedMutation = operation('post-redirect', '/post-redirect', {
    method: 'POST',
    auth: { state: 'required', allowedRoles: ['admin'] },
    responses: { '200': { contentType: 'application/json', schemaId: null } },
  });
  const apiManifest = { operations: [protectedMutation], schemas: {} };
  const apiConfig = {
    ...config('http://127.0.0.1:4317'),
    roles: { admin: { tokenRef: 'env:SENTINEL_TEST_ADMIN_TOKEN' } },
    allowMutations: true,
    mutationAllowlist: ['post-redirect'],
  };
  const plan = buildExecutionPlan({
    manifest: apiManifest,
    config: apiConfig,
    mode: 'api',
    sandboxAcknowledged: true,
  });
  const observations = await sweepApi({
    manifest: apiManifest,
    plan,
    config: apiConfig,
    env: { SENTINEL_TEST_ADMIN_TOKEN: ADMIN_TOKEN },
    fetchImpl: async (_url, request) => {
      if (request.method === 'POST') {
        return new Response(null, {
          status: 303,
          headers: { location: '/post-redirect' },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(find(observations, 'post-redirect').outcome, 'fail');
  assert.equal(
    find(observations, 'post-redirect').reasonCode,
    'REDIRECT_METHOD_MISMATCH',
  );
  assert.equal(find(observations, 'post-redirect', 'admin').outcome, 'fail');
  assert.equal(
    find(observations, 'post-redirect', 'admin').reasonCode,
    'REDIRECT_METHOD_MISMATCH',
  );
});

test('binds the exact target and query for denied API attempts without leaking redirect data', async () => {
  const deniedRedirect = operation('denied-redirect', '/denied-redirect', {
    auth: { state: 'required', allowedRoles: ['admin'] },
  });
  const apiManifest = { operations: [deniedRedirect], schemas: {} };
  const apiConfig = {
    ...config('http://127.0.0.1:4317'),
    roles: { admin: { tokenRef: 'env:SENTINEL_TEST_ADMIN_TOKEN' } },
  };
  const plan = buildExecutionPlan({ manifest: apiManifest, config: apiConfig, mode: 'api' });
  const calls = [];
  const observations = await sweepApi({
    manifest: apiManifest,
    plan,
    config: apiConfig,
    env: { SENTINEL_TEST_ADMIN_TOKEN: ADMIN_TOKEN },
    fetchImpl: async (url, request) => {
      calls.push({ url: String(url), authorization: request.headers.get('authorization') });
      if (!request.headers.has('authorization')) {
        return new Response(null, {
          status: 302,
          headers: { location: `/login?token=${encodeURIComponent(PLANNED_QUERY_CANARY)}` },
        });
      }
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(find(observations, 'denied-redirect').reasonCode, 'REDIRECT_TARGET_MISMATCH');
  assert.equal(calls.length, 2, JSON.stringify(calls));
  assert.equal(calls.some((call) => call.url.includes('/login')), false);
  assert.equal(JSON.stringify(observations).includes(PLANNED_QUERY_CANARY), false);
});

test('rejects forged, partial, cloned, direct, and empty-role plans before API I/O', async () => {
  const forgedDelete = operation('forged-delete', '/forged-delete', {
    method: 'DELETE',
    auth: { state: 'required', allowedRoles: ['admin'] },
    responses: { '204': { contentType: null, schemaId: null } },
  });
  const apiManifest = { operations: [forgedDelete], schemas: {} };
  const apiConfig = {
    ...config('http://127.0.0.1:4317'),
    roles: { admin: { tokenRef: 'env:SENTINEL_TEST_ADMIN_TOKEN' } },
    allowMutations: true,
    mutationAllowlist: ['forged-delete'],
  };
  const trustedPlan = buildExecutionPlan({
    manifest: apiManifest,
    config: apiConfig,
    mode: 'api',
    sandboxAcknowledged: true,
  });
  const forgedPlan = {
    mode: 'api',
    roleUniverse: ['admin'],
    browserViewports: [],
    operations: [{
      subjectId: forgedDelete.id,
      action: 'execute',
      reasonCode: 'MUTATION_APPROVED',
      riskScore: 100,
      riskLevel: 'critical',
      originId: 'api',
      roles: ['admin', 'unauthenticated'],
      parameterValues: {},
    }],
    routes: [],
  };
  const emptyRoles = structuredClone(forgedPlan);
  emptyRoles.operations[0].roles = [];
  const directDecision = planOperation({
    operation: forgedDelete,
    config: apiConfig,
    sandboxAcknowledged: true,
  });
  const candidates = [
    structuredClone(trustedPlan),
    directDecision,
    forgedPlan,
    emptyRoles,
    { mode: 'api', operations: [] },
  ];
  let calls = 0;

  for (const candidate of candidates) {
    await assert.rejects(
      sweepApi({
        manifest: apiManifest,
        plan: candidate,
        config: apiConfig,
        env: { SENTINEL_TEST_ADMIN_TOKEN: ADMIN_TOKEN },
        fetchImpl: async () => {
          calls += 1;
          return new Response(null, { status: 204 });
        },
      }),
      (error) => error?.code === 'EXECUTION_PLAN_UNTRUSTED',
    );
  }

  assert.equal(calls, 0);
});

test('rejects inherited, accessor, and proxy credential environments before API I/O', async () => {
  const apiManifest = {
    operations: [operation('protected-env', '/protected-env', {
      auth: { state: 'required', allowedRoles: ['admin'] },
    })],
    schemas: {},
  };
  const apiConfig = {
    ...config('http://127.0.0.1:4317'),
    roles: { admin: { tokenRef: 'env:SENTINEL_TEST_ADMIN_TOKEN' } },
  };
  const plan = buildExecutionPlan({ manifest: apiManifest, config: apiConfig, mode: 'api' });
  const inherited = Object.create({ SENTINEL_TEST_ADMIN_TOKEN: ADMIN_TOKEN });
  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'SENTINEL_TEST_ADMIN_TOKEN', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return ADMIN_TOKEN;
    },
  });
  let proxyReads = 0;
  const proxy = new Proxy({ SENTINEL_TEST_ADMIN_TOKEN: ADMIN_TOKEN }, {
    get(target, property, receiver) {
      proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      proxyReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });
  let calls = 0;

  for (const env of [inherited, accessor, proxy]) {
    await assert.rejects(
      sweepApi({
        manifest: apiManifest,
        plan,
        config: apiConfig,
        env,
        fetchImpl: async () => {
          calls += 1;
          return new Response('{"ok":true}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
      (error) => error?.code === 'SECRET_ENV_INVALID',
    );
  }

  assert.equal(calls, 0);
  assert.equal(getterReads, 0);
  assert.equal(proxyReads, 0);
});

test('executes the manifest, config, auth, roles, and parameters bound to the plan', async () => {
  const apiManifest = {
    operations: [operation('bound', '/bound/{recordId}', {
      auth: { state: 'required', allowedRoles: ['admin'] },
      responses: { '200': { contentType: 'application/json', schemaId: 'schema:strict' } },
      parameters: [
        {
          name: 'recordId',
          location: 'path',
          required: true,
          schema: { type: 'string' },
          example: PLANNED_PATH_CANARY,
        },
        {
          name: 'view',
          location: 'query',
          required: true,
          schema: { type: 'string' },
          example: PLANNED_QUERY_CANARY,
        },
      ],
    })],
    schemas: {
      'schema:strict': {
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  };
  const originalOrigin = 'http://127.0.0.1:4317';
  const apiConfig = {
    ...config(originalOrigin),
    roles: { admin: { tokenRef: 'env:SENTINEL_TEST_ADMIN_TOKEN' } },
  };
  const plan = buildExecutionPlan({
    manifest: apiManifest,
    config: apiConfig,
    mode: 'api',
  });

  apiManifest.operations[0].method = 'DELETE';
  apiManifest.operations[0].path = '/rebound';
  apiManifest.operations[0].auth = { state: 'public', allowedRoles: [] };
  apiManifest.operations[0].parameters[0].example = 'rebound';
  apiManifest.operations[0].parameters[1].example = 'rebound';
  apiConfig.approvedOrigins[0] = 'http://127.0.0.1:9';
  apiConfig.services[0].approvedOrigin = 'http://127.0.0.1:9';
  apiConfig.roles.admin.tokenRef = 'env:SENTINEL_REBOUND_TOKEN';
  apiConfig.responseTimeoutMs = 1;
  const requests = [];
  const env = {
    SENTINEL_TEST_ADMIN_TOKEN: ADMIN_TOKEN,
    SENTINEL_REBOUND_TOKEN: 'must-not-be-used',
  };

  const observations = await sweepApi({
    manifest: apiManifest,
    plan,
    config: apiConfig,
    env,
    fetchImpl: async (url, request) => {
      requests.push({ url: String(url), method: request.method });
      assert.equal(new URL(url).origin, originalOrigin);
      assert.equal(new URL(url).pathname, `/bound/${PLANNED_PATH_CANARY}`);
      assert.equal(new URL(url).searchParams.get('view'), PLANNED_QUERY_CANARY);
      assert.equal(request.method, 'GET');
      const authorization = request.headers.get('authorization');
      env.SENTINEL_TEST_ADMIN_TOKEN = 'mutated-after-first-await';
      if (authorization === `Bearer ${ADMIN_TOKEN}`) {
        return new Response(JSON.stringify({
          [`${PLANNED_PATH_CANARY}-${PLANNED_QUERY_CANARY}`]: true,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(requests.length, 2);
  assert.equal(find(observations, 'bound').reasonCode, 'RBAC_DENIAL_EXPECTED');
  assert.equal(find(observations, 'bound', 'admin').reasonCode, 'SCHEMA_VIOLATION');
  assert.deepEqual(find(observations, 'bound', 'admin').evidence.schemaViolations, [{
    path: '/[SCHEMA_PATH_REDACTED]',
    keyword: 'additionalProperties',
  }]);
  assert.equal(
    find(observations, 'bound').evidence.path,
    '/bound/{recordId}?[QUERY_PRESENT]',
  );
  assert.equal(JSON.stringify(observations).includes(PLANNED_PATH_CANARY), false);
  assert.equal(JSON.stringify(observations).includes(PLANNED_QUERY_CANARY), false);
  assert.equal(JSON.stringify(observations).includes('rebound'), false);
});

test('redacts planned values reflected into public API schema evidence', async () => {
  const reflected = operation('reflected-parameters', '/reflected/{recordId}', {
    parameters: [
      {
        name: 'recordId', location: 'path', required: true,
        schema: { type: 'string' }, example: PLANNED_PATH_CANARY,
      },
      {
        name: 'view', location: 'query', required: true,
        schema: { type: 'string' }, example: PLANNED_QUERY_CANARY,
      },
    ],
    responses: { '200': { contentType: 'application/json', schemaId: 'schema:strict' } },
  });
  const apiManifest = {
    operations: [reflected],
    schemas: {
      'schema:strict': {
        schema: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
  };
  const apiConfig = config('http://127.0.0.1:4317');
  const plan = buildExecutionPlan({ manifest: apiManifest, config: apiConfig, mode: 'api' });
  const observations = await sweepApi({
    manifest: apiManifest,
    plan,
    config: apiConfig,
    fetchImpl: async () => new Response(JSON.stringify({
      [`${PLANNED_PATH_CANARY}-${PLANNED_QUERY_CANARY}`]: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  });

  assert.deepEqual(find(observations, reflected.id).evidence.schemaViolations, [{
    path: '/[SCHEMA_PATH_REDACTED]',
    keyword: 'additionalProperties',
  }]);
  assert.equal(JSON.stringify(observations).includes(PLANNED_PATH_CANARY), false);
  assert.equal(JSON.stringify(observations).includes(PLANNED_QUERY_CANARY), false);
});

test('does not retain a valid response media type reflected from planned parameters', async () => {
  const pathCanary = 'sentinel-content-path';
  const queryCanary = 'sentinel-content-query';
  const headerCanary = 'sentinel-content-header';
  const reflected = operation('reflected-content-type', '/content/{recordId}', {
    parameters: [
      {
        name: 'recordId', location: 'path', required: true,
        schema: { type: 'string' }, example: pathCanary,
      },
      {
        name: 'view', location: 'query', required: true,
        schema: { type: 'string' }, example: queryCanary,
      },
      {
        name: 'x-view', location: 'header', required: true,
        schema: { type: 'string' }, example: headerCanary,
      },
    ],
  });
  const apiManifest = { operations: [reflected], schemas: {} };
  const apiConfig = config('http://127.0.0.1:4317');
  const plan = buildExecutionPlan({ manifest: apiManifest, config: apiConfig, mode: 'api' });
  const observations = await sweepApi({
    manifest: apiManifest,
    plan,
    config: apiConfig,
    fetchImpl: async (url, request) => {
      assert.equal(new URL(url).pathname, `/content/${pathCanary}`);
      assert.equal(new URL(url).searchParams.get('view'), queryCanary);
      assert.equal(request.headers.get('x-view'), headerCanary);
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          'content-type': `application/${pathCanary}.${queryCanary}.${headerCanary}`,
        },
      });
    },
  });
  const mismatch = find(observations, reflected.id);

  assert.equal(mismatch.reasonCode, 'CONTENT_TYPE_MISMATCH');
  assert.equal(mismatch.expected, 'application/json');
  assert.equal(mismatch.actual, 'different valid media type');
  const serialized = JSON.stringify(observations);
  for (const canary of [pathCanary, queryCanary, headerCanary]) {
    assert.equal(serialized.includes(canary), false, canary);
  }
});
