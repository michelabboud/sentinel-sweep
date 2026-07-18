import { readFileSync } from 'node:fs';

import { SentinelError } from './lib/errors.mjs';
import { findingId } from './lib/identity.mjs';
import { validateAgainstSchema } from './lib/schema.mjs';

const FINDINGS_SCHEMA = JSON.parse(
  readFileSync(new URL('../schemas/findings.schema.json', import.meta.url), 'utf8'),
);
const MANIFEST_SCHEMA = JSON.parse(
  readFileSync(new URL('../schemas/sentinel-manifest.schema.json', import.meta.url), 'utf8'),
);

const SEVERITIES = new Set(['critical', 'error', 'warning', 'info']);
const SEVERITY_ORDER = new Map([
  ['critical', 0],
  ['error', 1],
  ['warning', 2],
  ['info', 3],
]);
const CATEGORIES = new Set([
  'health',
  'rbac',
  'schema',
  'security',
  'policy',
  'coverage',
  'configuration',
  'console',
  'network',
  'layout',
  'content',
  'visual',
  'runtime',
]);
const OUTCOMES = new Set(['pass', 'fail', 'skip']);
const COVERAGE_STATUSES = new Set(['complete', 'partial', 'unsupported']);
const REASON_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const OBSERVATION_KEYS = new Set([
  'source',
  'subjectId',
  'category',
  'severity',
  'outcome',
  'role',
  'reasonCode',
  'message',
  'expected',
  'actual',
  'evidence',
]);
const API_EVIDENCE_KEYS = new Set([
  'method',
  'path',
  'status',
  'durationMs',
  'bytes',
  'redirects',
  'schemaViolations',
]);
const BROWSER_EVIDENCE_KEYS = new Set([
  'path',
  'status',
  'durationMs',
  'viewport',
  'screenshotPath',
]);
const DECISION_KEYS = new Set([
  'subjectId',
  'action',
  'reasonCode',
  'riskScore',
  'riskLevel',
  'originId',
  'roles',
  'parameterValues',
]);
const PLAN_KEYS = new Set(['mode', 'roleUniverse', 'operations', 'routes']);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(stage) {
  throw new SentinelError(
    'FINDINGS_INPUT_INVALID',
    'Findings input does not satisfy the trusted normalization contract',
    { stage },
  );
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonBlank(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0;
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort(compareCodeUnits).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) fail('canonical-json');
  return serialized;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactKeys(value, allowed, required, stage) {
  if (!isPlainObject(value)) fail(stage);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) fail(stage);
  if (required.some((key) => !hasOwn(value, key))) fail(stage);
}

function redactString(value, redact, stage) {
  if (typeof value !== 'string') fail(stage);
  let result;
  try {
    result = redact(value);
  } catch {
    fail('redaction');
  }
  if (typeof result !== 'string') fail('redaction');
  return result;
}

function redactDocument(value, redact) {
  if (typeof value === 'string') return redactString(value, redact, 'redaction');
  if (Array.isArray(value)) return value.map((entry) => redactDocument(entry, redact));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(
      ([key, entry]) => [key, redactDocument(entry, redact)],
    ));
  }
  return value;
}

function validateManifest(manifest) {
  try {
    validateAgainstSchema(manifest, MANIFEST_SCHEMA, { name: 'manifest' });
  } catch {
    fail('manifest');
  }
}

function validateRoleList(roles, stage) {
  if (!Array.isArray(roles)
      || roles.some((role) => !isNonBlank(role))
      || new Set(roles).size !== roles.length) {
    fail(stage);
  }
}

function validateDecision(decision, expectedId, stage) {
  exactKeys(decision, DECISION_KEYS, [...DECISION_KEYS], stage);
  if (decision.subjectId !== expectedId
      || !['execute', 'skip'].includes(decision.action)
      || !REASON_CODE.test(decision.reasonCode)
      || !Number.isInteger(decision.riskScore)
      || decision.riskScore < 0
      || decision.riskScore > 100
      || !['safe', 'medium', 'high', 'critical'].includes(decision.riskLevel)
      || (decision.originId !== null && !isNonBlank(decision.originId))
      || !isPlainObject(decision.parameterValues)) {
    fail(stage);
  }
  validateRoleList(decision.roles, stage);
}

function indexDecisions(decisions, subjects, stage) {
  if (!Array.isArray(decisions) || decisions.length !== subjects.length) fail(stage);
  const subjectsById = new Map();
  for (const subject of subjects) {
    if (subjectsById.has(subject.id)) fail(stage);
    subjectsById.set(subject.id, subject);
  }
  const indexed = new Map();
  for (const decision of decisions) {
    if (!isPlainObject(decision) || !isNonBlank(decision.subjectId)) fail(stage);
    const subject = subjectsById.get(decision.subjectId);
    if (subject === undefined || indexed.has(decision.subjectId)) fail(stage);
    validateDecision(decision, subject.id, stage);
    indexed.set(subject.id, { subject, decision });
  }
  return indexed;
}

function validatePlan(plan, manifest) {
  exactKeys(plan, PLAN_KEYS, [...PLAN_KEYS], 'plan');
  if (!['api', 'browser', 'sweep'].includes(plan.mode)) fail('plan');
  validateRoleList(plan.roleUniverse, 'plan-role-universe');
  if (plan.roleUniverse.includes('unauthenticated')) fail('plan-role-universe');
  const sortedRoles = [...plan.roleUniverse].sort(compareCodeUnits);
  if (canonicalJson(sortedRoles) !== canonicalJson(plan.roleUniverse)) {
    fail('plan-role-universe');
  }

  const operations = indexDecisions(plan.operations, manifest.operations, 'plan-operations');
  const routes = indexDecisions(plan.routes, manifest.routes, 'plan-routes');
  const universe = new Set(plan.roleUniverse);
  for (const { subject, decision } of [...operations.values(), ...routes.values()]) {
    const knownRoles = [
      ...(Array.isArray(subject.auth?.allowedRoles) ? subject.auth.allowedRoles : []),
      ...decision.roles,
    ].filter((role) => role !== 'unauthenticated');
    if (knownRoles.some((role) => !universe.has(role))) fail('plan-role-universe');
  }
  return { operations, routes, roleUniverse: universe };
}

function validateNullableString(value, stage) {
  if (value !== null && typeof value !== 'string') fail(stage);
}

function validateStatus(value, stage) {
  if (value !== null
      && (!Number.isInteger(value) || value < 100 || value > 599)) {
    fail(stage);
  }
}

function validateDuration(value, stage) {
  if (value !== null
      && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    fail(stage);
  }
}

function validateApiEvidence(evidence) {
  exactKeys(
    evidence,
    API_EVIDENCE_KEYS,
    ['method', 'path', 'status', 'durationMs', 'bytes', 'redirects'],
    'api-evidence',
  );
  if (!isNonBlank(evidence.method)
      || typeof evidence.path !== 'string'
      || (evidence.bytes !== null
        && (!Number.isInteger(evidence.bytes) || evidence.bytes < 0))
      || !Number.isInteger(evidence.redirects)
      || evidence.redirects < 0
      || (hasOwn(evidence, 'schemaViolations') && !Array.isArray(evidence.schemaViolations))) {
    fail('api-evidence');
  }
  validateStatus(evidence.status, 'api-evidence');
  validateDuration(evidence.durationMs, 'api-evidence');
}

function validateBrowserEvidence(evidence) {
  exactKeys(
    evidence,
    BROWSER_EVIDENCE_KEYS,
    [...BROWSER_EVIDENCE_KEYS],
    'browser-evidence',
  );
  if (typeof evidence.path !== 'string'
      || (evidence.viewport !== null
        && (!Number.isInteger(evidence.viewport) || evidence.viewport < 1))
      || (evidence.screenshotPath !== null
        && (typeof evidence.screenshotPath !== 'string'
          || evidence.screenshotPath.length === 0
          || /[\\/\0\r\n]/u.test(evidence.screenshotPath)))) {
    fail('browser-evidence');
  }
  validateStatus(evidence.status, 'browser-evidence');
  validateDuration(evidence.durationMs, 'browser-evidence');
}

function provenanceForSubject(subject, redact) {
  const provenance = subject.provenance;
  return {
    source: 'manifest',
    sourcePath: redactString(provenance.file, redact, 'provenance'),
    pointer: redactString(provenance.pointer, redact, 'provenance'),
  };
}

function normalizeEvidence(observation, redact) {
  const evidence = {};
  if (observation.expected !== null) {
    evidence.expected = redactString(observation.expected, redact, 'observation-expected');
  }
  if (observation.actual !== null) {
    evidence.actual = redactString(observation.actual, redact, 'observation-actual');
  }
  if (observation.evidence.status !== null) evidence.statusCode = observation.evidence.status;
  if (observation.evidence.durationMs !== null) {
    evidence.durationMs = observation.evidence.durationMs;
  }
  if (observation.source === 'browser') {
    if (observation.evidence.viewport !== null) evidence.viewport = observation.evidence.viewport;
    if (observation.evidence.screenshotPath !== null) {
      evidence.screenshotPath = redactString(
        observation.evidence.screenshotPath,
        redact,
        'observation-screenshot',
      );
    }
  }
  return evidence;
}

function normalizeObservation(observation, context, redact) {
  exactKeys(observation, OBSERVATION_KEYS, [...OBSERVATION_KEYS], 'observation');
  if (!['api', 'browser'].includes(observation.source)
      || !isNonBlank(observation.subjectId)
      || !CATEGORIES.has(observation.category)
      || !SEVERITIES.has(observation.severity)
      || !OUTCOMES.has(observation.outcome)
      || !REASON_CODE.test(observation.reasonCode)
      || typeof observation.message !== 'string'
      || observation.message.trim().length === 0) {
    fail('observation');
  }
  validateNullableString(observation.role, 'observation-role');
  validateNullableString(observation.expected, 'observation-expected');
  validateNullableString(observation.actual, 'observation-actual');
  if (observation.role !== null && !isNonBlank(observation.role)) fail('observation-role');

  const indexed = observation.source === 'api' ? context.operations : context.routes;
  const subjectType = observation.source === 'api' ? 'operation' : 'route';
  const record = indexed.get(observation.subjectId);
  if (record === undefined) fail('observation-subject');
  const { subject, decision } = record;

  if (observation.role !== null && !context.roleUniverse.has(observation.role)) {
    fail('observation-role');
  }
  if (subject.auth?.state === 'public' && observation.role !== null) {
    fail('observation-role');
  }
  if (observation.outcome === 'skip') {
    if (decision.action !== 'skip'
        || observation.role !== null
        || observation.reasonCode !== decision.reasonCode) {
      fail('observation-decision');
    }
  } else if (decision.action !== 'execute') {
    fail('observation-decision');
  }

  if (observation.source === 'api') validateApiEvidence(observation.evidence);
  else validateBrowserEvidence(observation.evidence);

  const role = observation.role === null
    ? null
    : redactString(observation.role, redact, 'observation-role');
  const service = decision.originId === null || decision.originId === 'default'
    ? null
    : redactString(decision.originId, redact, 'observation-service');
  const category = observation.outcome === 'skip' ? 'policy' : observation.category;
  const severity = observation.outcome === 'skip' ? 'info' : observation.severity;
  const reasonCode = redactString(observation.reasonCode, redact, 'observation-reason');
  const viewport = observation.source === 'browser' ? observation.evidence.viewport : null;
  const identity = {
    subjectType,
    subjectId: redactString(observation.subjectId, redact, 'observation-subject'),
    service,
    role,
    category,
    reasonCode,
    viewport,
    diagnosticSourcePath: null,
    diagnosticPointer: null,
  };
  const source = observation.outcome === 'skip' ? 'policy' : observation.source;
  const finding = {
    id: findingId(identity),
    severity,
    category,
    message: redactString(observation.message, redact, 'observation-message'),
    service,
    subject: { type: subjectType, id: identity.subjectId },
    role,
    evidence: normalizeEvidence(observation, redact),
    provenance: [
      provenanceForSubject(subject, redact),
      { source, sourcePath: null, pointer: null },
    ],
  };
  return {
    finding,
    skipped: observation.outcome === 'skip',
    durationMs: observation.evidence.durationMs,
    omitted: observation.outcome === 'pass',
  };
}

function normalizeDiagnostic(diagnostic, redact) {
  const allowed = new Set(['code', 'message', 'sourcePath', 'pointer']);
  exactKeys(diagnostic, allowed, ['code', 'message'], 'coverage-diagnostic');
  if (!isNonBlank(diagnostic.code)
      || typeof diagnostic.message !== 'string'
      || diagnostic.message.trim().length === 0) {
    fail('coverage-diagnostic');
  }
  const sourcePath = hasOwn(diagnostic, 'sourcePath') ? diagnostic.sourcePath : null;
  const pointer = hasOwn(diagnostic, 'pointer') ? diagnostic.pointer : null;
  validateNullableString(sourcePath, 'coverage-diagnostic');
  validateNullableString(pointer, 'coverage-diagnostic');
  return {
    code: redactString(diagnostic.code, redact, 'coverage-diagnostic'),
    message: redactString(diagnostic.message, redact, 'coverage-diagnostic'),
    sourcePath: sourcePath === null
      ? null
      : redactString(sourcePath, redact, 'coverage-diagnostic'),
    pointer: pointer === null
      ? null
      : redactString(pointer, redact, 'coverage-diagnostic'),
  };
}

function normalizeCoverage(coverage, redact) {
  const allowed = new Set(['status', 'diagnostics']);
  exactKeys(coverage, allowed, [...allowed], 'coverage');
  if (!COVERAGE_STATUSES.has(coverage.status) || !Array.isArray(coverage.diagnostics)) {
    fail('coverage');
  }
  let diagnostics = coverage.diagnostics.map((entry) => normalizeDiagnostic(entry, redact));
  if (coverage.status !== 'complete' && diagnostics.length === 0) {
    diagnostics = [{
      code: `COVERAGE_${coverage.status.toUpperCase()}_WITHOUT_DIAGNOSTIC`,
      message: `Coverage is ${coverage.status} but no adapter diagnostic was provided`,
      sourcePath: null,
      pointer: null,
    }];
  }
  diagnostics.sort((left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right)));
  diagnostics = diagnostics.filter((entry, index) => (
    index === 0 || canonicalJson(entry) !== canonicalJson(diagnostics[index - 1])
  ));
  return { status: coverage.status, diagnostics };
}

function diagnosticCandidate(diagnostic, status) {
  const severity = status === 'unsupported'
    ? 'error'
    : status === 'partial'
      ? 'warning'
      : 'info';
  const identity = {
    subjectType: 'run',
    subjectId: 'coverage',
    service: null,
    role: null,
    category: 'coverage',
    reasonCode: diagnostic.code,
    viewport: null,
    diagnosticSourcePath: diagnostic.sourcePath,
    diagnosticPointer: diagnostic.pointer,
  };
  return {
    finding: {
      id: findingId(identity),
      severity,
      category: 'coverage',
      message: diagnostic.message,
      service: null,
      subject: { type: 'run', id: 'coverage' },
      role: null,
      evidence: {},
      provenance: [{
        source: 'manifest',
        sourcePath: diagnostic.sourcePath,
        pointer: diagnostic.pointer,
      }],
    },
    skipped: false,
    omitted: false,
  };
}

function mergeProvenance(left, right) {
  const indexed = new Map();
  for (const entry of [...left, ...right]) indexed.set(canonicalJson(entry), entry);
  return [...indexed.entries()]
    .sort(([leftKey], [rightKey]) => compareCodeUnits(leftKey, rightKey))
    .map(([, entry]) => entry);
}

function mergeCandidates(candidates) {
  const merged = new Map();
  for (const candidate of candidates) {
    const existing = merged.get(candidate.finding.id);
    if (existing === undefined) {
      merged.set(candidate.finding.id, candidate);
      continue;
    }
    const candidateRank = SEVERITY_ORDER.get(candidate.finding.severity);
    const existingRank = SEVERITY_ORDER.get(existing.finding.severity);
    const candidateBody = { ...candidate.finding, provenance: [] };
    const existingBody = { ...existing.finding, provenance: [] };
    const selectCandidate = candidateRank < existingRank
      || (candidateRank === existingRank
        && compareCodeUnits(canonicalJson(candidateBody), canonicalJson(existingBody)) < 0);
    const selected = selectCandidate ? candidate : existing;
    const provenance = mergeProvenance(
      existing.finding.provenance,
      candidate.finding.provenance,
    );
    merged.set(candidate.finding.id, {
      ...selected,
      skipped: existing.skipped || candidate.skipped,
      finding: { ...selected.finding, provenance },
    });
  }
  return [...merged.values()];
}

function compareNullableRole(left, right) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareCodeUnits(left, right);
}

function sortFindings(left, right) {
  return SEVERITY_ORDER.get(left.severity) - SEVERITY_ORDER.get(right.severity)
    || compareCodeUnits(left.category, right.category)
    || compareCodeUnits(left.subject.type, right.subject.type)
    || compareCodeUnits(left.subject.id, right.subject.id)
    || compareNullableRole(left.role, right.role)
    || compareCodeUnits(left.id, right.id);
}

function summarize(candidates) {
  const summary = { critical: 0, error: 0, warning: 0, info: 0, skipped: 0 };
  for (const candidate of candidates) {
    if (candidate.skipped) summary.skipped += 1;
    else summary[candidate.finding.severity] += 1;
  }
  return summary;
}

function percentile(sorted, quantile) {
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function responsePercentiles(durations) {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((left, right) => left - right);
  const average = Number(
    (sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(3),
  );
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    average,
  };
}

function validateCompleted(document) {
  try {
    validateAgainstSchema(document, FINDINGS_SCHEMA, { name: 'findings' });
  } catch {
    fail('completed-findings');
  }
}

/** Normalizes strict API/browser observations into the canonical v2 findings document. */
export function buildFindings({
  runId,
  manifest,
  plan,
  observations,
  coverage,
  startedAt,
  finishedAt,
  redact = (value) => value,
} = {}) {
  if (typeof redact !== 'function'
      || !isNonBlank(runId)
      || !isNonBlank(startedAt)
      || !isNonBlank(finishedAt)
      || !Array.isArray(observations)) {
    fail('arguments');
  }
  validateManifest(manifest);
  const planContext = validatePlan(plan, manifest);
  const normalizedCoverage = normalizeCoverage(coverage, redact);
  const normalizedObservations = observations.map(
    (entry) => normalizeObservation(entry, planContext, redact),
  );
  const durations = normalizedObservations
    .map((entry) => entry.durationMs)
    .filter((value) => typeof value === 'number');
  const candidates = mergeCandidates([
    ...normalizedObservations.filter((entry) => !entry.omitted),
    ...normalizedCoverage.diagnostics.map(
      (diagnostic) => diagnosticCandidate(diagnostic, normalizedCoverage.status),
    ),
  ]);
  candidates.sort((left, right) => sortFindings(left.finding, right.finding));

  const document = {
    schemaVersion: '2.0',
    runId: redactString(runId, redact, 'run-id'),
    startedAt: redactString(startedAt, redact, 'started-at'),
    finishedAt: redactString(finishedAt, redact, 'finished-at'),
    manifestGeneratedAt: manifest.generatedAt === null || manifest.generatedAt === undefined
      ? null
      : redactString(manifest.generatedAt, redact, 'manifest-generated-at'),
    coverage: normalizedCoverage,
    summary: summarize(candidates),
    findings: candidates.map((entry) => entry.finding),
  };
  const percentiles = responsePercentiles(durations);
  if (percentiles !== null) document.responseTimePercentiles = percentiles;

  const completed = redactDocument(document, redact);
  validateCompleted(completed);
  return deepFreeze(completed);
}
