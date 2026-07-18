import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFindings } from '../../runtime/findings.mjs';
import {
  materializeRequestTarget,
  materializeTargetPath,
  validateCanonicalFindings,
} from '../../runtime/lib/findings-contract.mjs';
import { findingId } from '../../runtime/lib/identity.mjs';
import { loadBundledSchema, validateAgainstSchema } from '../../runtime/lib/schema.mjs';
import {
  createRedactor,
  identityRedactor,
} from '../../runtime/lib/secrets.mjs';
import { summaryExitCode } from '../../runtime/report.mjs';

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
      browserViewports: [375, 768],
      operations: [
        {
          subjectId: read.id,
          action: 'execute',
          reasonCode: 'READ_APPROVED',
          riskScore: 0,
          riskLevel: 'safe',
          originId: 'api',
          roles: ['admin', 'user', 'unauthenticated'],
          parameterValues: {},
        },
        {
          subjectId: write.id,
          action: 'skip',
          reasonCode: 'MUTATION_BLOCKED_DISABLED',
          riskScore: 40,
          riskLevel: 'medium',
          originId: 'api',
          roles: ['admin', 'user', 'unauthenticated'],
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
    severity: 'critical',
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
      screenshotPath: 'browser-0123456789abcdef01234567.png',
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

function dataValue(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function terminalObservations(existing = []) {
  const apiPass = (role, accessExpected) => apiObservation({
    category: accessExpected ? 'health' : 'rbac',
    severity: 'info',
    outcome: 'pass',
    role,
    reasonCode: accessExpected ? 'HTTP_STATUS_EXPECTED' : 'RBAC_DENIAL_EXPECTED',
    message: accessExpected ? 'Declared status returned' : 'Unauthorized access was denied',
    evidence: {
      method: 'GET',
      path: '/admin',
      status: accessExpected ? 200 : 403,
      durationMs: 5,
      bytes: 8,
      redirects: 0,
    },
  });
  const defaults = [
    apiPass('admin', true),
    apiPass('user', false),
    apiPass(null, false),
    skipObservation(),
    browserObservation({
      category: 'health',
      severity: 'info',
      outcome: 'pass',
      reasonCode: 'DOCUMENT_STATUS_EXPECTED',
      message: 'The dashboard returned an expected document status',
    }),
    browserObservation({
      category: 'health',
      severity: 'info',
      outcome: 'pass',
      reasonCode: 'DOCUMENT_STATUS_EXPECTED',
      message: 'The dashboard returned an expected document status',
      evidence: {
        path: '/dashboard',
        status: 200,
        durationMs: 44,
        viewport: 768,
        screenshotPath: 'browser-89abcdef0123456789abcdef.png',
      },
    }),
  ];
  const matchesAttempt = (observation, expected) => {
    if (dataValue(observation, 'source') !== expected.source
        || dataValue(observation, 'subjectId') !== expected.subjectId
        || dataValue(observation, 'role') !== expected.role) return false;
    if (expected.outcome === 'skip') return dataValue(observation, 'outcome') === 'skip';
    if (expected.source !== 'browser') return true;
    const evidence = dataValue(observation, 'evidence');
    return dataValue(evidence, 'viewport') === expected.evidence.viewport
      && [
        'DOCUMENT_STATUS_EXPECTED',
        'DOCUMENT_STATUS_UNAVAILABLE',
        'DOCUMENT_STATUS_UNEXPECTED',
        'RBAC_ACCESS_DENIED',
        'RBAC_ACCESS_GRANTED',
        'RBAC_DENIAL_EXPECTED',
        'RBAC_DENIAL_NOT_PROVEN',
      ].includes(dataValue(observation, 'reasonCode'));
  };
  return [
    ...existing,
    ...defaults.filter((expected) => !existing.some(
      (observation) => matchesAttempt(observation, expected),
    )),
  ];
}

function build(overrides = {}) {
  const { manifest, plan } = fixture();
  if (overrides.coverage !== undefined && overrides.manifest === undefined) {
    manifest.coverage = structuredClone(overrides.coverage);
  }
  return buildFindings({
    ...RUN,
    manifest,
    plan,
    coverage: { status: 'complete', diagnostics: [] },
    redact: identityRedactor,
    ...overrides,
    observations: terminalObservations(overrides.observations ?? []),
  });
}

test('normalizes, sorts, whitelists, and summarizes once', async () => {
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
  const duplicate = apiObservation({
    message: 'User could access admin data',
    evidence: {
      method: 'GET', path: '/admin', status: 200, durationMs: 10, bytes: 9, redirects: 1,
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
    observations: [duplicate, browserObservation(), pass, skipObservation()],
    coverage,
  });
  const second = build({
    observations: [skipObservation(), pass, browserObservation(), duplicate],
    coverage: { ...coverage, diagnostics: [...coverage.diagnostics].reverse() },
  });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual({ ...first.summary }, {
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
  assert.deepEqual(first.findings.map((entry) => entry.outcome), [
    'fail', 'fail', 'fail', 'skip',
  ]);
  assert.deepEqual(first.findings.map((entry) => entry.reasonCode), [
    'RBAC_ACCESS_GRANTED', 'UNCAUGHT_EXCEPTION', 'VUE_DYNAMIC_ROUTE',
    'MUTATION_BLOCKED_DISABLED',
  ]);
  const rbac = first.findings[0];
  assert.equal(rbac.message, 'User could access admin data');
  assert.equal(rbac.service, 'api');
  assert.deepEqual({ ...rbac.subject }, { type: 'operation', id: 'op:get:/admin' });
  assert.deepEqual({ ...rbac.evidence }, {
    expected: '401 or 403',
    actual: '200',
    statusCode: 200,
    durationMs: 10,
  });
  assert.deepEqual(rbac.provenance.map((entry) => ({ ...entry })), [
    { source: 'manifest', sourcePath: 'openapi.json', pointer: '#/paths/~1admin/get' },
    { source: 'api', sourcePath: null, pointer: null },
  ]);
  assert.deepEqual({ ...first.responseTimePercentiles }, {
    p50: 10,
    p95: 44,
    p99: 44,
    average: 21.6,
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

test('keeps identity stable across safe wording and timing changes but varies by viewport', () => {
  const baseline = build({ observations: [browserObservation()] }).findings[0];
  const changedDetails = build({ observations: [browserObservation({
    message: 'Different safe wording',
    evidence: {
      path: '/dashboard',
      status: 200,
      durationMs: 999,
      viewport: 375,
      screenshotPath: 'browser-aaaaaaaaaaaaaaaaaaaaaaaa.png',
    },
  })] }).findings[0];
  const changedViewport = build({ observations: [browserObservation({
    evidence: {
      path: '/dashboard',
      status: 200,
      durationMs: 44,
      viewport: 768,
      screenshotPath: 'browser-bbbbbbbbbbbbbbbbbbbbbbbb.png',
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
  assert.deepEqual({ ...findings.coverage.diagnostics[0] }, {
    code: 'COVERAGE_UNSUPPORTED_WITHOUT_DIAGNOSTIC',
    message: 'Coverage is unsupported but no adapter diagnostic was provided',
    sourcePath: null,
    pointer: null,
  });
  assert.equal(findings.findings[0].severity, 'error');
  assert.equal(findings.findings[0].category, 'coverage');
  assert.deepEqual({ ...findings.summary }, {
    critical: 0, error: 1, warning: 0, info: 0, skipped: 1,
  });
});

test('promotes incomplete coverage to a canonical error when trusted policy requires completeness', () => {
  const findings = build({
    coverage: {
      status: 'partial',
      diagnostics: [{
        code: 'VUE_DYNAMIC_ROUTE',
        message: 'One route cannot be discovered statically',
        sourcePath: 'src/router.js',
        pointer: '/routes/1',
      }],
    },
    requireCompleteCoverage: true,
  });

  assert.deepEqual(findings.coverage.diagnostics.map((entry) => entry.code), [
    'COVERAGE_REQUIRED_INCOMPLETE',
    'VUE_DYNAMIC_ROUTE',
  ]);
  const policyFinding = findings.findings.find(
    (entry) => entry.reasonCode === 'COVERAGE_REQUIRED_INCOMPLETE',
  );
  assert.equal(policyFinding.severity, 'error');
  assert.equal(policyFinding.category, 'coverage');
  assert.deepEqual(policyFinding.provenance.map((entry) => ({ ...entry })), [{
    source: 'policy', sourcePath: null, pointer: null,
  }]);
  assert.equal(findings.summary.error, 1);
  assert.equal(findings.summary.warning, 1);
  assert.doesNotThrow(() => validateCanonicalFindings(findings));
});

test('does not add the coverage policy finding when completeness is not required or is achieved', () => {
  const partial = build({
    coverage: {
      status: 'partial',
      diagnostics: [{
        code: 'VUE_DYNAMIC_ROUTE',
        message: 'One route cannot be discovered statically',
      }],
    },
    requireCompleteCoverage: false,
  });
  const complete = build({ requireCompleteCoverage: true });

  assert.equal(
    partial.findings.some((entry) => entry.reasonCode === 'COVERAGE_REQUIRED_INCOMPLETE'),
    false,
  );
  assert.equal(
    complete.findings.some((entry) => entry.reasonCode === 'COVERAGE_REQUIRED_INCOMPLETE'),
    false,
  );
  assert.throws(
    () => build({ requireCompleteCoverage: 'true' }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});

test('rejects untrusted attempts to inject the reserved coverage policy diagnostic', () => {
  assert.throws(
    () => build({
      coverage: {
        status: 'partial',
        diagnostics: [{
          code: 'COVERAGE_REQUIRED_INCOMPLETE',
          message: 'forged policy decision',
        }],
      },
      requireCompleteCoverage: false,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});

test('rejects persisted coverage policy findings whose fixed provenance or wording is forged', () => {
  const canonical = build({
    coverage: {
      status: 'partial',
      diagnostics: [{
        code: 'VUE_DYNAMIC_ROUTE',
        message: 'One route cannot be discovered statically',
      }],
    },
    requireCompleteCoverage: true,
  });
  const policyIndex = canonical.findings.findIndex(
    (entry) => entry.reasonCode === 'COVERAGE_REQUIRED_INCOMPLETE',
  );

  const forgedSource = structuredClone(canonical);
  forgedSource.findings[policyIndex].provenance[0].source = 'manifest';
  assert.throws(() => validateCanonicalFindings(forgedSource));

  const forgedMessage = structuredClone(canonical);
  forgedMessage.coverage.diagnostics[0].message = 'target supplied this policy';
  forgedMessage.findings[policyIndex].message = 'target supplied this policy';
  assert.throws(() => validateCanonicalFindings(forgedMessage));

  const forgedStatus = structuredClone(canonical);
  forgedStatus.coverage.status = 'complete';
  assert.throws(() => validateCanonicalFindings(forgedStatus));
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

test('binds API and browser evidence to the planned target, auth expectation, and status contract', () => {
  const apiPass = apiObservation({
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
  const invalidApi = [
    { ...apiPass, evidence: { ...apiPass.evidence, method: 'POST' } },
    { ...apiPass, evidence: { ...apiPass.evidence, path: '/login' } },
    { ...apiPass, evidence: { ...apiPass.evidence, status: 500 } },
    apiObservation({
      category: 'rbac',
      severity: 'info',
      outcome: 'pass',
      role: 'user',
      reasonCode: 'RBAC_DENIAL_EXPECTED',
      message: 'Unauthorized role was denied',
      evidence: {
        method: 'GET', path: '/admin', status: 200, durationMs: 5, bytes: 8, redirects: 0,
      },
    }),
  ];
  for (const candidate of invalidApi) {
    assert.throws(
      () => build({ observations: [candidate] }),
      (error) => error?.code === 'FINDINGS_INPUT_INVALID',
    );
  }

  const browserPass = browserObservation({
    category: 'health',
    severity: 'info',
    outcome: 'pass',
    reasonCode: 'DOCUMENT_STATUS_EXPECTED',
    message: 'Expected document returned',
  });
  for (const candidate of [
    { ...browserPass, evidence: { ...browserPass.evidence, path: '/login' } },
    { ...browserPass, evidence: { ...browserPass.evidence, status: 302 } },
    { ...browserPass, evidence: { ...browserPass.evidence, status: 500 } },
    { ...browserPass, role: 'admin' },
  ]) {
    assert.throws(
      () => build({ observations: [candidate] }),
      (error) => error?.code === 'FINDINGS_INPUT_INVALID',
    );
  }
});

test('binds persisted content-type mismatch evidence to finite engine phrases', () => {
  const observation = (actual) => apiObservation({
    category: 'schema',
    severity: 'error',
    role: 'admin',
    reasonCode: 'CONTENT_TYPE_MISMATCH',
    message: 'GET /admin returned an unexpected media type',
    expected: 'application/json',
    actual,
    evidence: {
      method: 'GET', path: '/admin', status: 200,
      durationMs: 12, bytes: 42, redirects: 0,
    },
  });

  for (const actual of [
    'different valid media type',
    'missing or invalid content type',
  ]) {
    const document = build({ observations: [observation(actual)] });
    assert.equal(document.findings[0].evidence.actual, actual);
  }

  assert.throws(
    () => build({ observations: [observation('sentinel-reflected-media-canary')] }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
  assert.throws(
    () => build({ observations: [observation('[REDACTED]')] }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );

  const redact = createRedactor(['env:SENTINEL_MEDIA_PHRASE'], {
    SENTINEL_MEDIA_PHRASE: 'valid media',
  });
  const redacted = build({
    observations: [observation('different valid media type')],
    redact,
  });
  assert.equal(redacted.findings[0].evidence.actual, '[REDACTED]');
});

test('binds parameterized evidence to a non-value template and rejects the raw transport target', () => {
  const pathCanary = 'sentinel-findings-path-secret';
  const queryCanary = 'q3';
  const parameterized = operation(
    'op:get:/records/{recordId}',
    'GET',
    '/records/{recordId}',
    {
      auth: { state: 'public', allowedRoles: [] },
      parameters: [
        {
          name: 'recordId', location: 'path', required: true,
          schema: { type: 'string' }, example: pathCanary,
        },
        {
          name: 'view', location: 'query', required: true,
          schema: { type: 'string' }, example: queryCanary,
        },
      ],
    },
  );
  const { manifest } = fixture();
  manifest.operations = [parameterized];
  manifest.routes = [];
  const parameterValues = {
    'path:recordId': pathCanary,
    'query:view': queryCanary,
  };
  const plan = {
    mode: 'api',
    roleUniverse: [],
    browserViewports: [],
    operations: [{
      subjectId: parameterized.id,
      action: 'execute',
      reasonCode: 'READ_APPROVED',
      riskScore: 0,
      riskLevel: 'safe',
      originId: 'api',
      roles: ['unauthenticated'],
      parameterValues,
    }],
    routes: [],
  };
  const evidencePath = materializeTargetPath(parameterized, parameterValues);
  const rawTarget = materializeRequestTarget(parameterized, parameterValues);
  const pass = {
    source: 'api',
    subjectId: parameterized.id,
    category: 'health',
    severity: 'info',
    outcome: 'pass',
    role: null,
    reasonCode: 'HTTP_STATUS_EXPECTED',
    message: 'Declared status returned',
    expected: '200',
    actual: '200',
    evidence: {
      method: 'GET', path: evidencePath, status: 200,
      durationMs: 5, bytes: 8, redirects: 0,
    },
  };
  const options = {
    ...RUN,
    manifest,
    plan,
    observations: [pass],
    coverage: manifest.coverage,
    redact: identityRedactor,
  };

  assert.equal(rawTarget, `/records/${pathCanary}?view=${queryCanary}`);
  assert.equal(evidencePath, '/records/{recordId}?[QUERY_PRESENT]');
  assert.equal(JSON.stringify(pass).includes(pathCanary), false);
  assert.equal(JSON.stringify(pass).includes(queryCanary), false);
  assert.doesNotThrow(() => buildFindings(options));
  assert.throws(
    () => buildFindings({
      ...options,
      observations: [{ ...pass, evidence: { ...pass.evidence, path: rawTarget } }],
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
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
      redact: identityRedactor,
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
      redact: identityRedactor,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});

test('rejects policy reason codes outside the finite action and subject taxonomy', () => {
  const forgedCases = [
    {
      name: 'invented operation skip',
      mutate(plan) {
        plan.operations[1].reasonCode = 'INVENTED_POLICY_REASON';
      },
      observations: [skipObservation()],
      mutateObservation(observation) {
        observation.reasonCode = 'INVENTED_POLICY_REASON';
        observation.actual = 'INVENTED_POLICY_REASON';
      },
    },
    {
      name: 'mutation approval on a read',
      mutate(plan) {
        plan.operations[0].reasonCode = 'MUTATION_APPROVED';
      },
      observations: [],
    },
    {
      name: 'operation approval on a route',
      mutate(plan) {
        plan.routes[0].reasonCode = 'READ_APPROVED';
      },
      observations: [],
    },
  ];

  for (const candidate of forgedCases) {
    const { manifest, plan } = fixture();
    candidate.mutate(plan);
    const observations = structuredClone(candidate.observations);
    if (candidate.mutateObservation) candidate.mutateObservation(observations[0]);
    assert.throws(
      () => buildFindings({
        ...RUN,
        manifest,
        plan,
        observations: terminalObservations(observations),
        coverage: manifest.coverage,
      }),
      (error) => error?.code === 'FINDINGS_INPUT_INVALID',
      candidate.name,
    );
  }
});

test('persists a fail-closed policy skip for required auth with no allowed roles', () => {
  const { manifest } = fixture();
  const protectedOperation = operation('op:get:/unresolved-auth', 'GET', '/unresolved-auth', {
    auth: { state: 'required', allowedRoles: [] },
  });
  manifest.operations = [protectedOperation];
  manifest.routes = [];
  const plan = {
    mode: 'api',
    roleUniverse: ['user'],
    browserViewports: [],
    operations: [{
      subjectId: protectedOperation.id,
      action: 'skip',
      reasonCode: 'READ_BLOCKED_UNKNOWN_AUTH',
      riskScore: 0,
      riskLevel: 'safe',
      originId: 'api',
      roles: ['user', 'unauthenticated'],
      parameterValues: {},
    }],
    routes: [],
  };
  const observations = [{
    source: 'api',
    subjectId: protectedOperation.id,
    category: 'security',
    severity: 'info',
    outcome: 'skip',
    role: null,
    reasonCode: 'READ_BLOCKED_UNKNOWN_AUTH',
    message: 'Policy skipped GET /unresolved-auth',
    expected: 'policy approval',
    actual: 'READ_BLOCKED_UNKNOWN_AUTH',
    evidence: {
      method: 'GET',
      path: '/unresolved-auth',
      status: null,
      durationMs: null,
      bytes: null,
      redirects: 0,
    },
  }];

  const findings = buildFindings({
    ...RUN,
    manifest,
    plan,
    observations,
    coverage: manifest.coverage,
  });

  assert.equal(findings.findings.length, 1);
  assert.equal(findings.findings[0].outcome, 'skip');
  assert.equal(findings.findings[0].reasonCode, 'READ_BLOCKED_UNKNOWN_AUTH');
});

test('rejects a persisted policy finding with an invented reason even after identity recomputation', () => {
  const persisted = structuredClone(build());
  const policy = persisted.findings.find((finding) => finding.outcome === 'skip');
  policy.reasonCode = 'INVENTED_POLICY_REASON';
  policy.id = findingId({
    subjectType: policy.subject.type,
    subjectId: policy.subject.id,
    service: policy.service ?? null,
    role: policy.role,
    category: policy.category,
    reasonCode: policy.reasonCode,
    viewport: null,
    diagnosticSourcePath: null,
    diagnosticPointer: null,
  });

  assert.throws(
    () => validateCanonicalFindings(persisted),
    (error) => error?.code === 'FINDINGS_DOCUMENT_INVALID',
  );
});

for (const [name, observation] of [
  ['invented reason code', apiObservation({ reasonCode: 'INVENTED_REASON' })],
  ['fail/info tuple', apiObservation({ severity: 'info' })],
  ['pass/error tuple', apiObservation({ outcome: 'pass', severity: 'error' })],
  ['reason/category mismatch', apiObservation({ category: 'health' })],
]) {
  test(`rejects the finite observation contract violation: ${name}`, () => {
    assert.throws(
      () => build({ observations: [observation] }),
      (error) => error?.code === 'FINDINGS_INPUT_INVALID',
    );
  });
}

test('requires each role and unauthenticated attempt in the exact subject decision', () => {
  const { manifest, plan } = fixture();
  plan.roleUniverse = ['admin', 'auditor', 'user'];

  assert.throws(
    () => buildFindings({
      ...RUN,
      manifest,
      plan,
      observations: [apiObservation({ role: 'auditor' })],
      coverage: manifest.coverage,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );

  const withoutUnauthenticated = structuredClone(plan);
  withoutUnauthenticated.operations[0].roles = ['admin', 'user'];
  assert.throws(
    () => buildFindings({
      ...RUN,
      manifest,
      plan: withoutUnauthenticated,
      observations: [apiObservation({
        role: null,
        category: 'health',
        severity: 'info',
        outcome: 'pass',
        reasonCode: 'HTTP_STATUS_EXPECTED',
      })],
      coverage: manifest.coverage,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});

test('rejects forged plan role sets before terminal observation normalization', () => {
  const missingRole = fixture();
  missingRole.plan.operations[0].roles = ['admin', 'unauthenticated'];
  assert.throws(
    () => buildFindings({
      ...RUN,
      ...missingRole,
      observations: terminalObservations().filter((entry) => !(
        entry.source === 'api'
          && entry.subjectId === 'op:get:/admin'
          && entry.role === 'user'
      )),
      coverage: missingRole.manifest.coverage,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
    'protected operation omitted a trusted role',
  );

  const publicWithRole = fixture();
  publicWithRole.plan.routes[0].roles = ['admin', 'unauthenticated'];
  const adminBrowserStatuses = [375, 768].map((viewport) => browserObservation({
    category: 'health',
    severity: 'info',
    outcome: 'pass',
    role: 'admin',
    reasonCode: 'DOCUMENT_STATUS_EXPECTED',
    message: 'The dashboard returned an expected document status',
    evidence: {
      path: '/dashboard', status: 200, durationMs: 44, viewport, screenshotPath: null,
    },
  }));
  assert.throws(
    () => buildFindings({
      ...RUN,
      ...publicWithRole,
      observations: terminalObservations(adminBrowserStatuses),
      coverage: publicWithRole.manifest.coverage,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
    'public route accepted an authenticated attempt',
  );

  const emptyAllowedRoles = fixture();
  emptyAllowedRoles.manifest.operations[0].auth.allowedRoles = [];
  assert.throws(
    () => buildFindings({
      ...RUN,
      ...emptyAllowedRoles,
      observations: terminalObservations(),
      coverage: emptyAllowedRoles.manifest.coverage,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
    'required auth executed with no allowed roles',
  );
});

test('never lets an independent coverage argument improve or erase manifest coverage', () => {
  const { manifest, plan } = fixture();
  manifest.coverage = {
    status: 'unsupported',
    diagnostics: [{
      code: 'OPENAPI_VERSION_UNSUPPORTED',
      message: 'The API contract version is unsupported',
      sourcePath: 'openapi.json',
      pointer: null,
    }],
  };

  assert.throws(
    () => buildFindings({
      ...RUN,
      manifest,
      plan,
      observations: [],
      coverage: { status: 'complete', diagnostics: [] },
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});

test('rejects a non-idempotent redactor before generating persisted identities', () => {
  const prefix = 'A lower-privilege role reached';
  const nonIdempotent = (value) => (value.startsWith(prefix) ? `${value}!` : value);
  assert.throws(
    () => build({ observations: [apiObservation()], redact: nonIdempotent }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});

test('rejects arbitrary callbacks even when they appear deterministic and idempotent', () => {
  const unbrandedIdentity = (value) => value;
  assert.throws(
    () => build({ observations: [apiObservation()], redact: unbrandedIdentity }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});

test('does not run a second blanket redaction over trusted canonical enum values', () => {
  const redact = createRedactor([
    'env:SENTINEL_ERROR',
    'env:SENTINEL_HEALTH',
    'env:SENTINEL_MANIFEST',
    'env:SENTINEL_OPERATION',
  ], {
    SENTINEL_ERROR: 'error',
    SENTINEL_HEALTH: 'health',
    SENTINEL_MANIFEST: 'manifest',
    SENTINEL_OPERATION: 'operation',
  });
  const findings = build({
    observations: [apiObservation({
      category: 'health',
      severity: 'error',
      role: 'admin',
      reasonCode: 'HTTP_STATUS_UNEXPECTED',
      actual: '500',
      evidence: {
        method: 'GET', path: '/admin', status: 500, durationMs: 12, bytes: 42, redirects: 0,
      },
    })],
    redact,
  });

  assert.equal(findings.findings[0].severity, 'error');
  assert.equal(findings.findings[0].category, 'health');
  assert.equal(findings.findings[0].subject.type, 'operation');
  assert.equal(findings.findings[0].provenance[0].source, 'manifest');
});

test('preserves finite machine reason codes when a secret has the same text', () => {
  const coverage = {
    status: 'partial',
    diagnostics: [{
      code: 'VUE_DYNAMIC_ROUTE',
      message: 'One route is dynamic',
      sourcePath: 'src/router.js',
      pointer: '/routes/0',
    }],
  };
  const redact = createRedactor([
    'env:SENTINEL_RBAC_REASON',
    'env:SENTINEL_COVERAGE_REASON',
  ], {
    SENTINEL_RBAC_REASON: 'RBAC_ACCESS_GRANTED',
    SENTINEL_COVERAGE_REASON: 'VUE_DYNAMIC_ROUTE',
  });
  const findings = build({
    observations: [apiObservation()],
    coverage,
    redact,
  });

  assert.deepEqual(findings.findings.map((entry) => entry.reasonCode), [
    'RBAC_ACCESS_GRANTED', 'VUE_DYNAMIC_ROUTE', 'MUTATION_BLOCKED_DISABLED',
  ]);
  assert.equal(findings.coverage.diagnostics[0].code, 'VUE_DYNAMIC_ROUTE');
});

test('accepts a legitimate percentile mean above nearest-rank p99', () => {
  const { manifest, plan } = fixture();
  plan.mode = 'browser';
  plan.browserViewports = Array.from({ length: 100 }, (_, index) => index + 1);
  const pass = (viewport, durationMs) => browserObservation({
    category: 'health',
    severity: 'info',
    outcome: 'pass',
    role: null,
    reasonCode: 'DOCUMENT_STATUS_EXPECTED',
    evidence: {
      path: '/dashboard', status: 200, durationMs, viewport, screenshotPath: null,
    },
  });
  const findings = buildFindings({
    ...RUN,
    manifest,
    plan,
    observations: plan.browserViewports.map((viewport, index) => (
      pass(viewport, index === 99 ? 1000 : 0)
    )),
    coverage: manifest.coverage,
  });

  assert.deepEqual({ ...findings.responseTimePercentiles }, {
    p50: 0, p95: 0, p99: 0, average: 10,
  });
});

test('rejects accessor, proxy, custom-prototype, symbol, and augmented-array inputs without use', () => {
  const accessor = apiObservation();
  let accessorReads = 0;
  Object.defineProperty(accessor, 'subjectId', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'op:get:/admin';
    },
  });
  assert.throws(
    () => build({ observations: [accessor] }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
  assert.equal(accessorReads, 0);

  let proxyReads = 0;
  const proxy = new Proxy(apiObservation(), {
    get(target, property, receiver) {
      proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(
    () => build({ observations: [proxy] }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
  assert.equal(proxyReads, 0);

  const inherited = apiObservation();
  Object.setPrototypeOf(inherited, { inherited: true });
  assert.throws(
    () => build({ observations: [inherited] }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );

  const symbolBacked = apiObservation();
  symbolBacked[Symbol('hidden')] = true;
  assert.throws(
    () => build({ observations: [symbolBacked] }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );

  const { manifest, plan } = fixture();
  const augmented = [apiObservation()];
  augmented.extra = true;
  assert.throws(
    () => buildFindings({
      ...RUN, manifest, plan, observations: augmented, coverage: manifest.coverage,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});

test('rejects missing terminal observations for every planned API attempt', () => {
  const { manifest, plan } = fixture();
  plan.mode = 'api';

  assert.throws(
    () => buildFindings({
      ...RUN,
      manifest,
      plan,
      observations: [],
      coverage: manifest.coverage,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );

  assert.throws(
    () => buildFindings({
      ...RUN,
      manifest,
      plan,
      observations: [apiObservation({
        role: 'admin',
        category: 'health',
        severity: 'info',
        outcome: 'pass',
        reasonCode: 'HTTP_STATUS_EXPECTED',
      })],
      coverage: manifest.coverage,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );

  const duplicate = terminalObservations().filter((entry) => entry.source === 'api');
  duplicate.push(structuredClone(duplicate.find((entry) => entry.role === 'admin')));
  assert.throws(
    () => buildFindings({
      ...RUN,
      manifest,
      plan,
      observations: duplicate,
      coverage: manifest.coverage,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});

test('requires exactly one browser status terminal per planned role and viewport', () => {
  const { manifest, plan } = fixture();
  plan.mode = 'browser';
  const statuses = terminalObservations().filter((entry) => (
    entry.source === 'browser' && entry.reasonCode === 'DOCUMENT_STATUS_EXPECTED'
  ));

  assert.throws(
    () => buildFindings({
      ...RUN,
      manifest,
      plan,
      observations: statuses.slice(0, 1),
      coverage: manifest.coverage,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
  assert.throws(
    () => buildFindings({
      ...RUN,
      manifest,
      plan,
      observations: [...statuses, structuredClone(statuses[0])],
      coverage: manifest.coverage,
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});

test('accepts one finite null-viewport browser blocker per planned role', () => {
  const { manifest, plan } = fixture();
  plan.mode = 'browser';
  manifest.routes[0].auth = { state: 'required', allowedRoles: ['admin'] };
  plan.routes[0].roles = ['admin', 'user', 'unauthenticated'];
  const blocker = (role) => browserObservation({
    category: 'security',
    severity: 'error',
    outcome: 'fail',
    role,
    reasonCode: 'ORIGIN_NOT_APPROVED',
    message: 'The browser origin is unavailable',
    evidence: {
      path: '/dashboard', status: null, durationMs: null,
      viewport: null, screenshotPath: null,
    },
  });

  const findings = buildFindings({
    ...RUN,
    manifest,
    plan,
    observations: [blocker('admin'), blocker('user'), blocker(null)],
    coverage: manifest.coverage,
  });
  assert.deepEqual({ ...findings.summary }, {
    critical: 0, error: 3, warning: 0, info: 0, skipped: 0,
  });
});

test('turns a protected browser target mismatch into a canonical nonzero result', () => {
  const { manifest, plan } = fixture();
  manifest.operations = [];
  plan.operations = [];
  manifest.routes[0].auth = { state: 'required', allowedRoles: ['admin'] };
  plan.mode = 'browser';
  plan.roleUniverse = ['admin'];
  plan.browserViewports = [375];
  plan.routes[0].roles = ['admin', 'unauthenticated'];
  const mismatch = browserObservation({
    category: 'security',
    severity: 'error',
    outcome: 'fail',
    role: 'admin',
    reasonCode: 'NAVIGATION_TARGET_MISMATCH',
    message: 'Protected route redirected to another same-origin document',
    evidence: {
      path: '/[TARGET_MISMATCH]',
      status: 302,
      durationMs: 20,
      viewport: 375,
      screenshotPath: null,
    },
  });
  const denied = browserObservation({
    category: 'rbac',
    severity: 'info',
    outcome: 'pass',
    role: null,
    reasonCode: 'RBAC_DENIAL_EXPECTED',
    message: 'Unauthenticated access was denied',
    evidence: {
      path: '/dashboard',
      status: 401,
      durationMs: 10,
      viewport: 375,
      screenshotPath: null,
    },
  });

  const findings = buildFindings({
    ...RUN,
    manifest,
    plan,
    observations: [mismatch, denied],
    coverage: manifest.coverage,
  });
  assert.deepEqual({ ...findings.summary }, {
    critical: 0, error: 1, warning: 0, info: 0, skipped: 0,
  });
  assert.equal(summaryExitCode(findings), 2);
});

test('rejects a redactor that changes its mapping for the same raw value', () => {
  let subjectCalls = 0;
  const unstable = (value) => {
    if (value === 'op:get:/admin') {
      subjectCalls += 1;
      return subjectCalls === 1 ? 'masked-a' : 'masked-b';
    }
    return value;
  };

  assert.throws(
    () => build({ observations: [apiObservation()], redact: unstable }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});

test('counts one response duration per terminal attempt despite multiple browser events', () => {
  const baseline = build();
  const withEvents = build({
    observations: [
      browserObservation({
        evidence: {
          path: '/dashboard', status: 200, durationMs: 999,
          viewport: 375, screenshotPath: null,
        },
      }),
      browserObservation({
        category: 'layout',
        severity: 'error',
        reasonCode: 'HORIZONTAL_OVERFLOW',
        evidence: {
          path: '/dashboard', status: 200, durationMs: 999,
          viewport: 375, screenshotPath: null,
        },
      }),
    ],
  });

  assert.deepEqual(
    { ...withEvents.responseTimePercentiles },
    { ...baseline.responseTimePercentiles },
  );
});

test('rejects coverage reason codes that the configured redactor would change', () => {
  const coverage = {
    status: 'partial',
    diagnostics: [{
      code: 'TOPSECRET123',
      message: 'Discovery was partial',
      sourcePath: 'manifest.json',
      pointer: '/routes',
    }],
  };

  assert.throws(
    () => build({
      coverage,
      redact: createRedactor(['env:SENTINEL_COVERAGE_CODE'], {
        SENTINEL_COVERAGE_CODE: 'TOPSECRET123',
      }),
    }),
    (error) => error?.code === 'FINDINGS_INPUT_INVALID',
  );
});
