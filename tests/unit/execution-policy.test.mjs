import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExecutionPlan,
  computeRisk,
  planOperation,
} from '../../runtime/policy/execution.mjs';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function operation(overrides = {}) {
  const method = overrides.method ?? 'GET';
  const mutation = !READ_METHODS.has(method);
  return {
    id: `op:${method.toLowerCase()}:/api/example`,
    method,
    path: '/api/example',
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
    rollback: mutation ? 'delete-test-fixture' : null,
    mutation,
    protocol: 'http',
    sweepable: !mutation,
    risk: mutation
      ? { score: 25, level: 'safe', reasons: ['source-claims-safe'] }
      : { score: 0, level: 'safe', reasons: [] },
    provenance: { adapter: 'openapi-json', file: 'openapi.json', pointer: '#/paths' },
    ...overrides,
  };
}

function route(overrides = {}) {
  return {
    id: 'route:/public',
    path: '/public',
    name: 'public',
    component: 'PublicView',
    aliases: [],
    auth: { state: 'public', allowedRoles: [] },
    parameters: [],
    provenance: { adapter: 'vue-router-static', file: 'router.js', pointer: '/routes/0' },
    ...overrides,
  };
}

function config(overrides = {}) {
  return {
    schemaVersion: '2.0',
    requireConfigPath: true,
    reportDir: 'sentinel-reports',
    approvedOrigins: ['http://127.0.0.1:4317'],
    roles: {},
    allowMutations: true,
    mutationAllowlist: [],
    allowNonLoopback: false,
    targetEnvironment: 'test',
    requireCompleteCoverage: true,
    responseTimeoutMs: 5000,
    viewports: [375],
    services: [{
      name: 'api',
      approvedOrigin: 'http://127.0.0.1:4317',
      sourcePath: '.',
    }],
    ...overrides,
  };
}

test('classifies only GET, HEAD, and OPTIONS as read-only across every HTTP method', () => {
  const methods = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE'];

  for (const method of methods) {
    const candidate = operation({ method, id: `op:${method.toLowerCase()}:/api/example` });
    const trusted = config({
      allowMutations: false,
      mutationAllowlist: [candidate.id],
    });
    const decision = planOperation({
      operation: candidate,
      config: trusted,
      sandboxAcknowledged: true,
    });

    assert.equal(
      decision.action,
      READ_METHODS.has(method) ? 'execute' : 'skip',
      method,
    );
    assert.equal(
      decision.reasonCode,
      READ_METHODS.has(method) ? 'READ_APPROVED' : 'MUTATION_BLOCKED_DISABLED',
      method,
    );
  }
});

test('blocks read methods with unknown side effects while allowing known empty effects', () => {
  for (const method of READ_METHODS) {
    const id = `op:${method.toLowerCase()}:/api/read`;
    const unknown = planOperation({
      operation: operation({
        id,
        method,
        sideEffects: { state: 'unknown', classes: [] },
      }),
      config: config(),
      sandboxAcknowledged: false,
    });
    assert.equal(unknown.action, 'skip', method);
    assert.equal(unknown.reasonCode, 'READ_BLOCKED_UNKNOWN_EFFECTS', method);
    assert.equal(unknown.riskLevel, 'critical', method);

    const knownEmpty = planOperation({
      operation: operation({
        id,
        method,
        sideEffects: { state: 'known', classes: [] },
      }),
      config: config(),
      sandboxAcknowledged: false,
    });
    assert.equal(knownEmpty.action, 'execute', method);
    assert.equal(knownEmpty.reasonCode, 'READ_APPROVED', method);
  }
});

test('computes risk monotonically and never trusts a source-declared safe mutation', () => {
  const safeRead = computeRisk(operation());
  assert.deepEqual(safeRead, { score: 0, level: 'safe', reasons: [] });

  const sourceClaimsSafe = computeRisk(operation({
    method: 'POST',
    id: 'op:post:/api/example',
    risk: { score: 0, level: 'safe', reasons: ['source-declared-safe'] },
  }));
  assert.ok(sourceClaimsSafe.score > safeRead.score);
  assert.notEqual(sourceClaimsSafe.level, 'safe');
  assert.ok(sourceClaimsSafe.reasons.includes('method:POST'));

  const sourceRaisesRead = computeRisk(operation({
    risk: { score: 88, level: 'critical', reasons: ['source-declared-critical'] },
  }));
  assert.equal(sourceRaisesRead.score, 88);
  assert.equal(sourceRaisesRead.level, 'critical');
  assert.ok(sourceRaisesRead.reasons.includes('source:source-declared-critical'));

  const unknownEffects = computeRisk(operation({
    method: 'POST',
    id: 'op:post:/api/example',
    sideEffects: { state: 'unknown', classes: [] },
  }));
  assert.equal(unknownEffects.score, 100);
  assert.equal(unknownEffects.level, 'critical');
});

test('returns the complete immutable execution decision shape for an approved read', () => {
  const decision = planOperation({
    operation: operation({ id: 'op:get:/api/public', path: '/api/public' }),
    config: config(),
    sandboxAcknowledged: false,
  });

  assert.deepEqual(decision, {
    subjectId: 'op:get:/api/public',
    action: 'execute',
    reasonCode: 'READ_APPROVED',
    riskScore: 0,
    riskLevel: 'safe',
    originId: 'api',
    roles: ['unauthenticated'],
    parameterValues: {},
  });
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.roles));
  assert.ok(Object.isFrozen(decision.parameterValues));
});

test('resolves explicit parameter examples without inventing missing values', () => {
  const approved = planOperation({
    operation: operation({
      id: 'op:get:/api/items/{id}',
      path: '/api/items/{id}',
      parameters: [{
        name: 'id',
        location: 'path',
        required: true,
        schema: { type: 'string' },
        example: 'known-item',
      }],
    }),
    config: config(),
    sandboxAcknowledged: false,
  });
  assert.equal(approved.action, 'execute');
  assert.deepEqual(approved.parameterValues, { 'path:id': 'known-item' });

  const missing = planOperation({
    operation: operation({
      id: 'op:get:/api/items/{id}',
      path: '/api/items/{id}',
      parameters: [{
        name: 'id',
        location: 'path',
        required: true,
        schema: { type: 'string' },
      }],
    }),
    config: config(),
    sandboxAcknowledged: false,
  });
  assert.equal(missing.action, 'skip');
  assert.equal(missing.reasonCode, 'READ_BLOCKED_PARAMETERS');
  assert.deepEqual(missing.parameterValues, {});
});

test('builds an explicit immutable decision for every discovered operation and route', () => {
  const manifest = {
    operations: [
      operation({ id: 'op:get:/api/public', path: '/api/public' }),
      operation({
        id: 'op:get:/api/unknown-auth',
        path: '/api/unknown-auth',
        auth: { state: 'unknown', allowedRoles: [] },
      }),
    ],
    routes: [
      route({ id: 'route:/public', path: '/public' }),
      route({
        id: 'route:/unknown-auth',
        path: '/unknown-auth',
        auth: { state: 'unknown', allowedRoles: [] },
      }),
    ],
  };

  const plan = buildExecutionPlan({
    manifest,
    config: config(),
    mode: 'sweep',
    sandboxAcknowledged: false,
  });

  assert.equal(plan.mode, 'sweep');
  assert.deepEqual(plan.browserViewports, [375]);
  assert.deepEqual(
    plan.operations.map(({ subjectId, action }) => ({ subjectId, action })),
    [
      { subjectId: 'op:get:/api/public', action: 'execute' },
      { subjectId: 'op:get:/api/unknown-auth', action: 'skip' },
    ],
  );
  assert.deepEqual(
    plan.routes.map(({ subjectId, action }) => ({ subjectId, action })),
    [
      { subjectId: 'route:/public', action: 'execute' },
      { subjectId: 'route:/unknown-auth', action: 'skip' },
    ],
  );
  assert.equal(plan.operations.length, manifest.operations.length);
  assert.equal(plan.routes.length, manifest.routes.length);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.operations));
  assert.ok(Object.isFrozen(plan.routes));
  assert.ok(Object.isFrozen(plan.browserViewports));
  assert.ok(plan.operations.every(Object.isFrozen));
  assert.ok(plan.routes.every(Object.isFrozen));
});

test('exposes the trusted role universe for lower-privilege RBAC attempts without secret references', () => {
  const manifest = {
    operations: [operation({
      id: 'op:get:/api/admin',
      path: '/api/admin',
      auth: { state: 'required', allowedRoles: ['operator', 'admin'] },
    })],
    routes: [route({
      id: 'route:/owner',
      path: '/owner',
      auth: { state: 'required', allowedRoles: ['owner'] },
    })],
  };
  const plan = buildExecutionPlan({
    manifest,
    config: config({
      roles: {
        user: { tokenRef: 'env:SENTINEL_USER_TOKEN' },
        admin: { tokenRef: 'env:SENTINEL_ADMIN_TOKEN' },
        unauthenticated: { tokenRef: 'env:SENTINEL_MUST_NOT_APPEAR' },
      },
    }),
    mode: 'sweep',
    sandboxAcknowledged: false,
  });

  assert.deepEqual(plan.roleUniverse, ['admin', 'operator', 'owner', 'user']);
  assert.deepEqual(plan.operations[0].roles, [
    'admin', 'operator', 'owner', 'user', 'unauthenticated',
  ]);
  assert.deepEqual(plan.routes[0].roles, [
    'admin', 'operator', 'owner', 'user', 'unauthenticated',
  ]);
  assert.ok(Object.isFrozen(plan.roleUniverse));
  assert.equal(JSON.stringify(plan).includes('tokenRef'), false);
  assert.equal(JSON.stringify(plan).includes('env:'), false);
  assert.equal(JSON.stringify(plan).includes('SENTINEL_'), false);
});

test('executes every protected subject across the complete trusted role universe', () => {
  const manifest = {
    operations: [
      operation({
        id: 'op:get:/api/public',
        path: '/api/public',
      }),
      operation({
        id: 'op:get:/api/admin',
        path: '/api/admin',
        auth: { state: 'required', allowedRoles: ['admin'] },
      }),
    ],
    routes: [
      route({ id: 'route:/public', path: '/public' }),
      route({
        id: 'route:/audit',
        path: '/audit',
        auth: { state: 'required', allowedRoles: ['auditor'] },
      }),
    ],
  };
  const plan = buildExecutionPlan({
    manifest,
    config: config({
      roles: { user: { tokenRef: 'env:SENTINEL_USER_TOKEN' } },
    }),
    mode: 'sweep',
  });

  assert.deepEqual(plan.roleUniverse, ['admin', 'auditor', 'user']);
  assert.deepEqual(plan.operations[0].roles, ['unauthenticated']);
  assert.deepEqual(plan.routes[0].roles, ['unauthenticated']);
  assert.deepEqual(
    plan.operations[1].roles,
    ['admin', 'auditor', 'user', 'unauthenticated'],
  );
  assert.deepEqual(
    plan.routes[1].roles,
    ['admin', 'auditor', 'user', 'unauthenticated'],
  );
});

test('never executes required-auth subjects with an empty allowed-role contract', () => {
  const protectedOperation = operation({
    auth: { state: 'required', allowedRoles: [] },
  });
  const plan = buildExecutionPlan({
    manifest: {
      operations: [protectedOperation],
      routes: [route({ auth: { state: 'required', allowedRoles: [] } })],
    },
    config: config({
      roles: { user: { tokenRef: 'env:SENTINEL_USER_TOKEN' } },
    }),
    mode: 'sweep',
  });

  assert.deepEqual(
    plan.operations.map(({ action, reasonCode }) => ({ action, reasonCode })),
    [{ action: 'skip', reasonCode: 'READ_BLOCKED_UNKNOWN_AUTH' }],
  );
  assert.deepEqual(
    plan.routes.map(({ action, reasonCode }) => ({ action, reasonCode })),
    [{ action: 'skip', reasonCode: 'ROUTE_BLOCKED_UNKNOWN_AUTH' }],
  );
  assert.deepEqual(plan.operations[0].roles, ['user', 'unauthenticated']);
  assert.deepEqual(plan.routes[0].roles, ['user', 'unauthenticated']);
});

test('rejects inherited, accessor, and proxy role configuration without invoking traps', () => {
  const manifest = {
    operations: [operation({
      auth: { state: 'required', allowedRoles: ['admin'] },
    })],
    routes: [],
  };
  let getterReads = 0;
  let proxyReads = 0;
  const accessorRoles = {};
  Object.defineProperty(accessorRoles, 'admin', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return { tokenRef: 'env:SENTINEL_ADMIN_TOKEN' };
    },
  });
  const accessorRecord = {};
  Object.defineProperty(accessorRecord, 'tokenRef', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return 'env:SENTINEL_ADMIN_TOKEN';
    },
  });
  const proxyRoles = new Proxy({
    admin: { tokenRef: 'env:SENTINEL_ADMIN_TOKEN' },
  }, {
    ownKeys(target) {
      proxyReads += 1;
      return Reflect.ownKeys(target);
    },
    get(target, property, receiver) {
      proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  const candidates = [
    Object.create({ admin: { tokenRef: 'env:SENTINEL_ADMIN_TOKEN' } }),
    accessorRoles,
    { admin: accessorRecord },
    proxyRoles,
  ];

  for (const roles of candidates) {
    assert.throws(
      () => buildExecutionPlan({
        manifest,
        config: config({ roles }),
        mode: 'api',
      }),
      (error) => error?.code === 'EXECUTION_INPUT_INVALID',
    );
  }
  assert.equal(getterReads, 0);
  assert.equal(proxyReads, 0);
});
