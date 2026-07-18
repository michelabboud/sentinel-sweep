import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFindings } from '../../runtime/findings.mjs';
import { loadBundledSchema, validateAgainstSchema } from '../../runtime/lib/schema.mjs';
import { createRedactor } from '../../runtime/lib/secrets.mjs';

const RUN = {
  runId: '2026-07-18T12-00-00-000Z',
  startedAt: '2026-07-18T12:00:00.000Z',
  finishedAt: '2026-07-18T12:00:03.000Z',
};

function operation(id, method, path, overrides = {}) {
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  return {
    id,
    method,
    path,
    summary: null,
    parameters: [],
    requestBody: null,
    responses: { '200': { contentType: 'application/json', schemaId: null } },
    auth: mutation
      ? { state: 'required', allowedRoles: ['admin'] }
      : { state: 'required', allowedRoles: ['admin'] },
    targetModel: null,
    deleteMode: null,
    sideEffects: { state: 'known', classes: mutation ? ['fixture-write'] : [] },
    rollback: mutation ? 'remove fixture' : null,
    mutation,
    protocol: 'http',
    sweepable: true,
    risk: { score: mutation ? 40 : 0, level: mutation ? 'medium' : 'safe', reasons: [] },
    provenance: {
      adapter: 'openapi-json',
      file: 'openapi.json',
      pointer: `#/paths/${path.replaceAll('/', '~1')}/${method.toLowerCase()}`,
    },
    ...overrides,
  };
}

function route(id, path) {
  return {
    id,
    path,
    name: 'dashboard',
    component: 'DashboardView',
    aliases: [],
    auth: { state: 'public', allowedRoles: [] },
    parameters: [],
    provenance: {
      adapter: 'vue-router-static',
      file: 'src/router.js',
      pointer: '/routes/0',
    },
  };
}

function fixture() {
  const read = operation('op:get:/admin', 'GET', '/admin');
  const write = operation('op:post:/items', 'POST', '/items');
  const dashboard = route('route:/dashboard', '/dashboard');
  return {
    manifest: {
      schemaVersion: '2.0',
      generatedAt: '2026-07-18T11:59:59.000Z',
      target: { name: 'report-fixture', root: '.' },
      coverage: { status: 'complete', diagnostics: [] },
      routes: [dashboard],
      operations: [read, write],
      schemas: {},
    },
    plan: {
      mode: 'sweep',
      roleUniverse: ['admin', 'user'],
      operations: [
        {
          subjectId: read.id,
          action: 'execute',
          reasonCode: 'READ_APPROVED',
          riskScore: 0,
          riskLevel: 'safe',
          originId: 'api',
          roles: ['admin', 'unauthenticated'],
          parameterValues: {},
        },
        {
          subjectId: write.id,
          action: 'skip',
          reasonCode: 'MUTATION_BLOCKED_DISABLED',
          riskScore: 40,
          riskLevel: 'medium',
          originId: 'api',
          roles: ['admin', 'unauthenticated'],
          parameterValues: {},
        },
      ],
      routes: [{
        subjectId: dashboard.id,
        action: 'execute',
        reasonCode: 'ROUTE_APPROVED',
        riskScore: 0,
        riskLevel: 'safe',
        originId: 'web',
        roles: ['unauthenticated'],
        parameterValues: {},
      }],
    },
  };
}

function apiObservation(overrides = {}) {
  return {
    source: 'api',
    subjectId: 'op:get:/admin',
    category: 'rbac',
    severity: 'error',
    outcome: 'fail',
    role: 'user',
    reasonCode: 'RBAC_ACCESS_GRANTED',
    message: 'A lower-privilege role reached the admin operation',
    expected: '401 or 403',
    actual: '200',
    evidence: {
      method: 'GET',
      path: '/admin',
      status: 200,
      durationMs: 12,
      bytes: 42,
      redirects: 0,
      schemaViolations: [{ path: '/secret', keyword: 'type' }],
    },
    ...overrides,
  };
}

function browserObservation(overrides = {}) {
  return {
    source: 'browser',
    subjectId: 'route:/dashboard',
    category: 'console',
    severity: 'error',
    outcome: 'fail',
    role: null,
    reasonCode: 'UNCAUGHT_EXCEPTION',
    message: 'The dashboard raised an uncaught exception',
    expected: 'no console errors',
    actual: 'uncaught exception',
    evidence: {
      path: '/dashboard',
      status: 200,
      durationMs: 44,
      viewport: 375,
      screenshotPath: 'dashboard-375.png',
    },
    ...overrides,
  };
}

function skipObservation() {
  return {
    source: 'api',
    subjectId: 'op:post:/items',
    category: 'security',
    severity: 'info',
    outcome: 'skip',
    role: null,
    reasonCode: 'MUTATION_BLOCKED_DISABLED',
    message: 'Policy skipped POST /items',
    expected: 'policy approval',
    actual: 'MUTATION_BLOCKED_DISABLED',
    evidence: {
      method: 'POST',
      path: '/items',
      status: null,
      durationMs: null,
      bytes: null,
      redirects: 0,
    },
  };
}

function build(overrides = {}) {
  const { manifest, plan } = fixture();
  return buildFindings({
    ...RUN,
    manifest,
    plan,
    observations: [],
    coverage: { status: 'complete', diagnostics: [] },
    redact: (value) => value,
    ...overrides,
  });
}

test('normalizes, de-duplicates, escalates, sorts, whitelists, and summarizes once', async () => {
  const pass = apiObservation({
    category: 'health',
    severity: 'info',
    outcome: 'pass',
    role: 'admin',
    reasonCode: 'HTTP_STATUS_EXPECTED',
    message: 'Declared status returned',
    evidence: {
      method: 'GET', path: '/admin', status: 200, durationMs: 5, bytes: 8, redirects: 0,
    },
  });
  const lowerSeverity = apiObservation({
    evidence: {
      method: 'GET', path: '/admin', status: 500, durationMs: 10, bytes: 9, redirects: 1,
    },
  });
  const escalated = apiObservation({
    severity: 'critical',
    message: 'User could access admin data',
    evidence: {
      method: 'GET', path: '/admin', status: 200, durationMs: 20, bytes: 999, redirects: 0,
    },
  });
  const coverage = {
    status: 'partial',
    diagnostics: [{
      code: 'VUE_DYNAMIC_ROUTE',
      message: 'One dynamic route was not executed',
      sourcePath: 'src/router.js',
      pointer: '/routes/3',
    }],
  };

  const first = build({
    observations: [lowerSeverity, browserObservation(), pass, skipObservation(), escalated],
    coverage,
  });
  const second = build({
    observations: [escalated, skipObservation(), pass, browserObservation(), lowerSeverity],
    coverage: { ...coverage, diagnostics: [...coverage.diagnostics].reverse() },
  });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.summary, {
    critical: 1,
    error: 1,
    warning: 1,
    info: 0,
    skipped: 1,
  });
  assert.equal(first.findings.length, 4);
  assert.deepEqual(first.findings.map((entry) => entry.severity), [
    'critical', 'error', 'warning', 'info',
  ]);
  assert.deepEqual(first.findings.map((entry) => entry.category), [
    'rbac', 'console', 'coverage', 'policy',
  ]);
  const rbac = first.findings[0];
  assert.equal(rbac.message, 'User could access admin data');
  assert.equal(rbac.service, 'api');
  assert.deepEqual(rbac.subject, { type: 'operation', id: 'op:get:/admin' });
  assert.deepEqual(rbac.evidence, {
    expected: '401 or 403',
    actual: '200',
    statusCode: 200,
    durationMs: 20,
  });
  assert.deepEqual(rbac.provenance, [
    { source: 'manifest', sourcePath: 'openapi.json', pointer: '#/paths/~1admin/get' },
    { source: 'api', sourcePath: null, pointer: null },
  ]);
  assert.deepEqual(first.responseTimePercentiles, {
    p50: 10,
    p95: 44,
    p99: 44,
    average: 19.75,
  });
  assert.equal(JSON.stringify(first).includes('schemaViolations'), false);
  assert.equal(JSON.stringify(first).includes('bytes'), false);
  assert.equal(JSON.stringify(first).includes('redirects'), false);
  assert.equal(JSON.stringify(first).includes('"method"'), false);
  assert.equal(JSON.stringify(first).includes('"path"'), false);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.findings));
  assert.ok(first.findings.every(Object.isFrozen));
  validateAgainstSchema(first, await loadBundledSchema('findings'), { name: 'findings' });
});

test('keeps identity stable across severity, status, and timing changes but varies by viewport', () => {
  const baseline = build({ observations: [browserObservation()] }).findings[0];
  const changedDetails = build({ observations: [browserObservation({
    severity: 'critical',
    message: 'Different safe wording',
    evidence: {
      path: '/dashboard',
      status: 503,
      durationMs: 999,
      viewport: 375,
      screenshotPath: 'different.png',
    },
  })] }).findings[0];
  const changedViewport = build({ observations: [browserObservation({
    evidence: {
      path: '/dashboard',
      status: 200,
      durationMs: 44,
      viewport: 768,
      screenshotPath: 'dashboard-768.png',
    },
  })] }).findings[0];

  assert.equal(baseline.id, changedDetails.id);
  assert.notEqual(baseline.id, changedViewport.id);
  assert.match(baseline.id, /^[a-f0-9]{64}$/u);
});

test('redacts raw and base64 canaries before coverage identity generation', () => {
  const secret = 'sentinel-report-secret-canary';
  const encoded = Buffer.from(secret).toString('base64');
  const redact = createRedactor(['env:SENTINEL_REPORT_SECRET'], {
    SENTINEL_REPORT_SECRET: secret,
  });
  const raw = build({
    coverage: {
      status: 'partial',
      diagnostics: [{
        code: 'COVERAGE_SECRET_CANARY',
        message: `blocked ${secret}`,
        sourcePath: `fixtures/${secret}.json`,
        pointer: `/encoded/${encoded}`,
      }],
    },
    redact,
  });
  const alreadyRedacted = build({
    coverage: {
      status: 'partial',
      diagnostics: [{
        code: 'COVERAGE_SECRET_CANARY',
        message: 'blocked [REDACTED]',
        sourcePath: 'fixtures/[REDACTED].json',
        pointer: '/encoded/[REDACTED]',
      }],
    },
    redact,
  });

  assert.equal(raw.findings[0].id, alreadyRedacted.findings[0].id);
  assert.deepEqual(raw, alreadyRedacted);
  assert.equal(JSON.stringify(raw).includes(secret), false);
  assert.equal(JSON.stringify(raw).includes(encoded), false);
});

test('adds a deterministic synthetic diagnostic for non-complete coverage without diagnostics', () => {
  const findings = build({
    coverage: { status: 'unsupported', diagnostics: [] },
  });

  assert.equal(findings.coverage.diagnostics.length, 1);
  assert.deepEqual(findings.coverage.diagnostics[0], {
    code: 'COVERAGE_UNSUPPORTED_WITHOUT_DIAGNOSTIC',
    message: 'Coverage is unsupported but no adapter diagnostic was provided',
    sourcePath: null,
    pointer: null,
  });
  assert.equal(findings.findings[0].severity, 'error');
  assert.equal(findings.findings[0].category, 'coverage');
  assert.deepEqual(findings.summary, {
    critical: 0, error: 1, warning: 0, info: 0, skipped: 0,
  });
});

test('rejects unknown or malformed observation fields, subjects, roles, and enums', () => {
  const invalid = [
    { name: 'top-level field', value: { ...apiObservation(), injected: true } },
    {
      name: 'evidence field',
      value: { ...apiObservation(), evidence: { ...apiObservation().evidence, authorization: 'x' } },
    },
    { name: 'subject', value: apiObservation({ subjectId: 'op:get:/missing' }) },
    { name: 'role', value: apiObservation({ role: 'root-from-observation' }) },
    { name: 'category', value: apiObservation({ category: 'i18n' }) },
    { name: 'severity', value: apiObservation({ severity: 'fatal' }) },
    { name: 'outcome', value: apiObservation({ outcome: 'unknown' }) },
    { name: 'reason code', value: apiObservation({ reasonCode: 'not a code' }) },
    { name: 'source', value: apiObservation({ source: 'shell' }) },
    { name: 'message', value: apiObservation({ message: '   ' }) },
    {
      name: 'status',
      value: apiObservation({ evidence: { ...apiObservation().evidence, status: 99 } }),
    },
    { name: 'source subject mismatch', value: apiObservation({ source: 'browser' }) },
  ];

  for (const candidate of invalid) {
    assert.throws(
      () => build({ observations: [candidate.value] }),
      (error) => error?.code === 'FINDINGS_INPUT_INVALID',
      candidate.name,
    );
  }
});

test('requires observations to agree with the immutable execution decision', () => {
  const { manifest, plan } = fixture();
  const wrongSkip = apiObservation({ outcome: 'skip', severity: 'info' });
  const wrongExecution = skipObservation();

  assert.throws(
    () => buildFindings({
      ...RUN,
      manifest,
      plan,
      observations: [wrongSkip],
      coverage: { status: 'complete', diagnostics: [] },
      redact: (value) => value,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );

  const changedPlan = structuredClone(plan);
  changedPlan.operations[1].action = 'execute';
  assert.throws(
    () => buildFindings({
      ...RUN,
      manifest,
      plan: changedPlan,
      observations: [wrongExecution],
      coverage: { status: 'complete', diagnostics: [] },
      redact: (value) => value,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});
