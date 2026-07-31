import assert from 'node:assert/strict';
import test from 'node:test';

import { planOperation } from '../../runtime/policy/execution.mjs';

function mutation(overrides = {}) {
  return {
    id: 'op:post:/api/test-fixtures',
    method: 'POST',
    path: '/api/test-fixtures',
    summary: null,
    parameters: [],
    requestBody: null,
    responses: { '201': { contentType: 'application/json', schemaId: null } },
    auth: { state: 'public', allowedRoles: [] },
    targetModel: 'TestFixture',
    deleteMode: null,
    sideEffects: { state: 'known', classes: ['test-fixture-write'] },
    rollback: 'delete-test-fixture',
    mutation: true,
    protocol: 'http',
    sweepable: false,
    risk: { score: 0, level: 'safe', reasons: ['source-claims-safe'] },
    provenance: { adapter: 'openapi-json', file: 'openapi.json', pointer: '#/paths' },
    ...overrides,
  };
}

function approvedConfig(operationId, overrides = {}) {
  return {
    schemaVersion: '2.0',
    requireConfigPath: true,
    reportDir: 'sentinel-reports',
    approvedOrigins: ['http://127.0.0.1:4317'],
    roles: {},
    allowMutations: true,
    mutationAllowlist: [operationId],
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

function plan(candidate, configOverrides = {}, sandboxAcknowledged = true) {
  return planOperation({
    operation: candidate,
    config: approvedConfig(candidate.id, configOverrides),
    sandboxAcknowledged,
  });
}

test('blocks mutations unless every trusted sandbox condition is approved', () => {
  const approved = mutation();
  const cases = [
    {
      name: 'mutations disabled',
      candidate: approved,
      config: { allowMutations: false },
      acknowledged: true,
      reasonCode: 'MUTATION_BLOCKED_DISABLED',
    },
    {
      name: 'stable ID absent from allowlist',
      candidate: approved,
      config: { mutationAllowlist: [] },
      acknowledged: true,
      reasonCode: 'MUTATION_BLOCKED_ALLOWLIST',
    },
    {
      name: 'unknown side effects',
      candidate: mutation({ sideEffects: { state: 'unknown', classes: [] } }),
      config: {},
      acknowledged: true,
      reasonCode: 'MUTATION_BLOCKED_UNKNOWN_EFFECTS',
    },
    {
      name: 'missing rollback',
      candidate: mutation({ rollback: null }),
      config: {},
      acknowledged: true,
      reasonCode: 'MUTATION_BLOCKED_ROLLBACK',
    },
    {
      name: 'whitespace-only rollback',
      candidate: mutation({ rollback: ' \t\n' }),
      config: {},
      acknowledged: true,
      reasonCode: 'MUTATION_BLOCKED_ROLLBACK',
    },
    {
      name: 'production environment',
      candidate: approved,
      config: { targetEnvironment: 'production' },
      acknowledged: true,
      reasonCode: 'MUTATION_BLOCKED_ENVIRONMENT',
    },
    {
      name: 'unknown origin',
      candidate: approved,
      config: { approvedOrigins: [], services: [] },
      acknowledged: true,
      reasonCode: 'MUTATION_BLOCKED_ORIGIN',
    },
    {
      name: 'missing sandbox acknowledgement',
      candidate: approved,
      config: {},
      acknowledged: false,
      reasonCode: 'MUTATION_BLOCKED_ACKNOWLEDGEMENT',
    },
  ];

  for (const entry of cases) {
    const decision = plan(entry.candidate, entry.config, entry.acknowledged);
    assert.equal(decision.action, 'skip', entry.name);
    assert.equal(decision.reasonCode, entry.reasonCode, entry.name);
    assert.deepEqual(decision.parameterValues, {}, entry.name);
    assert.ok(Object.isFrozen(decision), entry.name);
  }
});

test('rejects malformed mutation IDs even when the allowlist contains the same value', () => {
  const cases = [
    { name: 'missing', value: undefined },
    { name: 'null', value: null },
    { name: 'empty', value: '' },
    { name: 'blank', value: '   ' },
    { name: 'not trimmed', value: ' op:post:/api/test-fixtures ' },
  ];

  for (const entry of cases) {
    const candidate = mutation({ id: entry.value });
    if (entry.name === 'missing') delete candidate.id;
    const decision = planOperation({
      operation: candidate,
      config: approvedConfig(entry.value),
      sandboxAcknowledged: true,
    });

    assert.equal(decision.action, 'skip', entry.name);
    assert.equal(decision.reasonCode, 'MUTATION_BLOCKED_ALLOWLIST', entry.name);
  }
});

test('unknown authorization and required parameter values fail closed for reads and mutations', () => {
  const unknownAuth = plan(mutation({ auth: { state: 'unknown', allowedRoles: [] } }));
  assert.equal(unknownAuth.action, 'skip');
  assert.equal(unknownAuth.reasonCode, 'MUTATION_BLOCKED_UNKNOWN_AUTH');

  const missingParameter = plan(mutation({
    parameters: [{
      name: 'id',
      location: 'path',
      required: true,
      schema: { type: 'string' },
    }],
  }));
  assert.equal(missingParameter.action, 'skip');
  assert.equal(missingParameter.reasonCode, 'MUTATION_BLOCKED_PARAMETERS');
});

test('source-declared safe metadata cannot authorize a mutation', () => {
  const sourceClaimsSafe = mutation({
    risk: { score: 0, level: 'safe', reasons: ['safe'] },
  });
  const decision = plan(sourceClaimsSafe, { allowMutations: false });

  assert.equal(decision.action, 'skip');
  assert.equal(decision.reasonCode, 'MUTATION_BLOCKED_DISABLED');
  assert.notEqual(decision.riskLevel, 'safe');
});

test('unknown side effects produce the required stable critical skip decision', () => {
  const candidate = mutation({
    id: 'op:post:/api/unknown',
    path: '/api/unknown',
    sideEffects: { state: 'unknown', classes: [] },
  });
  const decision = plan(candidate);

  assert.deepEqual({
    action: decision.action,
    reasonCode: decision.reasonCode,
    riskLevel: decision.riskLevel,
  }, {
    action: 'skip',
    reasonCode: 'MUTATION_BLOCKED_UNKNOWN_EFFECTS',
    riskLevel: 'critical',
  });
});

test('executes a fully approved test mutation and exposes no transport material', () => {
  const decision = plan(mutation({
    auth: { state: 'required', allowedRoles: ['editor'] },
  }));

  assert.equal(decision.action, 'execute');
  assert.equal(decision.reasonCode, 'MUTATION_APPROVED');
  assert.equal(decision.originId, 'api');
  assert.deepEqual(decision.roles, ['editor', 'unauthenticated']);
  assert.deepEqual(decision.parameterValues, {});
  assert.deepEqual(Object.keys(decision).sort(), [
    'action',
    'originId',
    'parameterValues',
    'reasonCode',
    'riskLevel',
    'riskScore',
    'roles',
    'subjectId',
  ]);
});
