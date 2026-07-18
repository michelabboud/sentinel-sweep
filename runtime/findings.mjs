import { readFileSync } from 'node:fs';
import { types as utilTypes } from 'node:util';

import { SentinelError } from './lib/errors.mjs';
import {
  materializeTargetPath,
  subjectAccessExpected,
  trustedObservationContract,
  trustedPolicyDecisionContract,
  validateCanonicalFindings,
} from './lib/findings-contract.mjs';
import { findingId } from './lib/identity.mjs';
import { snapshotJson } from './lib/json-snapshot.mjs';
import { validateAgainstSchema } from './lib/schema.mjs';
import {
  identityRedactor,
  isTrustedRedactor,
} from './lib/secrets.mjs';
import { responseDefinition } from './api/http.mjs';

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
const TRUSTED_COVERAGE_CODES = new Set([
  'COVERAGE_PARTIAL_WITHOUT_DIAGNOSTIC',
  'COVERAGE_UNSUPPORTED_WITHOUT_DIAGNOSTIC',
  'OPENAPI_CALLBACK',
  'OPENAPI_EXTERNAL_REF',
  'OPENAPI_INVALID_PATH',
  'OPENAPI_NON_JSON_CONTENT',
  'OPENAPI_UNRESOLVED_REF',
  'OPENAPI_UNTRUSTED_EXTENSION_IGNORED',
  'OPENAPI_VERSION_UNSUPPORTED',
  'OPENAPI_WEBHOOK',
  'VUE_COMPUTED_PATH',
  'VUE_COMPUTED_PROPERTY',
  'VUE_DYNAMIC_ROUTE',
  'VUE_DYNAMIC_ROUTER_CONFIG',
  'VUE_DYNAMIC_ROUTES',
  'VUE_IMPORTED_ROUTES',
  'VUE_INTERPOLATED_TEMPLATE',
  'VUE_INVALID_ALIAS',
  'VUE_INVALID_CHILDREN',
  'VUE_INVALID_LITERAL',
  'VUE_INVALID_PATH',
  'VUE_INVALID_PROPERTY',
  'VUE_INVALID_ROUTE',
  'VUE_INVALID_ROUTE_FIELD',
  'VUE_MISSING_PATH',
  'VUE_ROUTE_CONFLICT',
  'VUE_ROUTES_NOT_FOUND',
  'VUE_SPREAD',
  'VUE_UNSUPPORTED_EXPRESSION',
  'VUE_UNTERMINATED_ARRAY',
  'VUE_UNTERMINATED_EXPRESSION',
  'VUE_UNTERMINATED_OBJECT',
]);
const REQUIRED_COVERAGE_CODE = 'COVERAGE_REQUIRED_INCOMPLETE';
const REQUIRED_COVERAGE_MESSAGE = 'Trusted configuration requires complete coverage';
const BROWSER_STATUS_REASONS = new Set([
  'DOCUMENT_STATUS_EXPECTED',
  'DOCUMENT_STATUS_UNAVAILABLE',
  'DOCUMENT_STATUS_UNEXPECTED',
  'RBAC_ACCESS_DENIED',
  'RBAC_ACCESS_GRANTED',
  'RBAC_DENIAL_EXPECTED',
  'RBAC_DENIAL_NOT_PROVEN',
]);
const BROWSER_SUBJECT_TERMINALS = new Set([
  'ORIGIN_NOT_APPROVED',
  'ORIGIN_INVALID',
  'ORIGIN_SCHEME',
  'ORIGIN_USERINFO',
  'ORIGIN_QUERY',
  'ORIGIN_FRAGMENT',
  'ORIGIN_BASE_PATH',
  'ORIGIN_NON_LOOPBACK_BLOCKED',
]);
const BROWSER_ATTEMPT_TERMINALS = new Set([
  'ROLE_CREDENTIAL_UNCONFIGURED',
  'SECRET_REF_INVALID',
  'SECRET_UNAVAILABLE',
]);
const BROWSER_VIEWPORT_TERMINALS = new Set([
  'NAVIGATION_TARGET_MISMATCH',
]);
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
const PLAN_KEYS = new Set([
  'mode', 'roleUniverse', 'browserViewports', 'operations', 'routes',
]);
const BUILD_KEYS = new Set([
  'runId',
  'manifest',
  'plan',
  'observations',
  'coverage',
  'requireCompleteCoverage',
  'startedAt',
  'finishedAt',
  'redact',
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function fail(stage) {
  throw new SentinelError(
    'FINDINGS_INPUT_INVALID',
    'Findings input does not satisfy the trusted normalization contract',
    { stage },
  );
}

function snapshotBuildOptions(options) {
  if (options === null
      || typeof options !== 'object'
      || Array.isArray(options)
      || utilTypes.isProxy(options)
      || Object.getPrototypeOf(options) !== Object.prototype) {
    fail('arguments');
  }
  const descriptors = Object.getOwnPropertyDescriptors(options);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !BUILD_KEYS.has(key))) fail('arguments');
  const json = {};
  let redact = identityRedactor;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) fail('arguments');
    if (key === 'redact') {
      if (!isTrustedRedactor(descriptor.value)) fail('arguments');
      redact = descriptor.value;
    } else {
      Object.defineProperty(json, key, {
        value: descriptor.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  let snapshot;
  try {
    snapshot = snapshotJson(json, {
      code: 'FINDINGS_INPUT_INVALID',
      message: 'Findings input does not satisfy the trusted normalization contract',
    });
  } catch {
    fail('snapshot');
  }
  return { ...snapshot, redact };
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

function createRedactionSession(redact) {
  const results = new Map();
  const remember = (input, output) => {
    if (results.has(input) && results.get(input) !== output) fail('redaction');
    results.set(input, output);
  };
  return (value, stage) => {
    if (typeof value !== 'string') fail(stage);
    let result;
    let repeated;
    try {
      result = redact(value);
      repeated = typeof result === 'string' ? redact(result) : undefined;
    } catch {
      fail('redaction');
    }
    if (typeof result !== 'string' || repeated !== result) fail('redaction');
    remember(value, result);
    remember(result, result);
    return result;
  };
}

function redactString(value, redact, stage) {
  if (typeof value !== 'string') fail(stage);
  return redact(value, stage);
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

function validateDecision(decision, subject, subjectType, stage) {
  exactKeys(decision, DECISION_KEYS, [...DECISION_KEYS], stage);
  const policy = trustedPolicyDecisionContract(subjectType, decision.reasonCode);
  const operationKind = subjectType === 'operation'
    && ['GET', 'HEAD', 'OPTIONS'].includes(subject.method)
    ? 'read'
    : subjectType === 'operation' ? 'mutation' : null;
  if (decision.subjectId !== subject.id
      || !['execute', 'skip'].includes(decision.action)
      || !REASON_CODE.test(decision.reasonCode)
      || policy === null
      || policy.action !== decision.action
      || policy.operationKind !== operationKind
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

function indexDecisions(decisions, subjects, subjectType, stage) {
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
    validateDecision(decision, subject, subjectType, stage);
    indexed.set(subject.id, { subject, decision });
  }
  return indexed;
}

function validatePlan(plan, manifest) {
  exactKeys(plan, PLAN_KEYS, [...PLAN_KEYS], 'plan');
  if (!['api', 'browser', 'sweep'].includes(plan.mode)) fail('plan');
  validateRoleList(plan.roleUniverse, 'plan-role-universe');
  if (!Array.isArray(plan.browserViewports)
      || plan.browserViewports.some((value) => (
        !Number.isInteger(value) || value < 1 || value > 10_000
      ))
      || new Set(plan.browserViewports).size !== plan.browserViewports.length
      || plan.browserViewports.some((value, index) => (
        index > 0 && plan.browserViewports[index - 1] >= value
      ))) {
    fail('plan-browser-viewports');
  }
  if (plan.roleUniverse.includes('unauthenticated')) fail('plan-role-universe');
  const sortedRoles = [...plan.roleUniverse].sort(compareCodeUnits);
  if (canonicalJson(sortedRoles) !== canonicalJson(plan.roleUniverse)) {
    fail('plan-role-universe');
  }

  const operations = indexDecisions(
    plan.operations,
    manifest.operations,
    'operation',
    'plan-operations',
  );
  const routes = indexDecisions(plan.routes, manifest.routes, 'route', 'plan-routes');
  const universe = new Set(plan.roleUniverse);
  for (const { subject, decision } of [...operations.values(), ...routes.values()]) {
    const authState = subject.auth?.state;
    const allowedRoles = Array.isArray(subject.auth?.allowedRoles)
      ? subject.auth.allowedRoles.filter((role) => role !== 'unauthenticated')
      : [];
    if ((authState === 'public' && allowedRoles.length !== 0)
        || (decision.action === 'execute'
          && (authState === 'required'
            ? allowedRoles.length === 0
            : authState !== 'public'))) {
      fail('plan-auth');
    }
    if (allowedRoles.some((role) => !universe.has(role))) fail('plan-role-universe');
    const expectedRoles = authState === 'public'
      ? ['unauthenticated']
      : [...plan.roleUniverse, 'unauthenticated'];
    if (canonicalJson(decision.roles) !== canonicalJson(expectedRoles)) {
      fail('plan-subject-roles');
    }
  }
  if (['browser', 'sweep'].includes(plan.mode)
      && [...routes.values()].some(({ decision }) => decision.action === 'execute')
      && plan.browserViewports.length === 0) {
    fail('plan-browser-viewports');
  }
  return {
    mode: plan.mode,
    operations,
    routes,
    roleUniverse: universe,
    browserViewports: plan.browserViewports,
  };
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

const DENIAL_STATUSES = new Set([401, 403]);
const API_INSPECTION_REASONS = new Set([
  'BODY_INSPECTION_FAILED',
  'CONTENT_TYPE_MISMATCH',
  'JSON_RESPONSE_INVALID',
  'SCHEMA_NOT_FOUND',
  'SCHEMA_VIOLATION',
]);
const CONTENT_TYPE_MISMATCH_ACTUALS = new Set([
  'different valid media type',
  'missing or invalid content type',
]);

function isSuccessStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function validateApiEvidenceSemantics(observation, subject, decision) {
  const expectedPath = materializeTargetPath(subject, decision.parameterValues, 'api');
  const expectedMethod = subject.method.toUpperCase();
  const { status } = observation.evidence;
  if (observation.evidence.method !== expectedMethod
      || observation.evidence.path !== expectedPath) {
    fail('api-evidence-target');
  }
  if (observation.outcome === 'skip') {
    if (status !== null) fail('api-evidence-status');
    return;
  }

  const accessExpected = subjectAccessExpected(subject, observation.role);
  const definition = Number.isInteger(status)
    ? responseDefinition(subject.responses, status)
    : null;
  if (observation.reasonCode === 'CONTENT_TYPE_MISMATCH'
      && !CONTENT_TYPE_MISMATCH_ACTUALS.has(observation.actual)) {
    fail('api-evidence-inspection');
  }
  switch (observation.reasonCode) {
    case 'HTTP_STATUS_EXPECTED':
      if (!accessExpected || DENIAL_STATUSES.has(status) || definition === null) {
        fail('api-evidence-status');
      }
      break;
    case 'RBAC_DENIAL_EXPECTED':
      if (accessExpected || !DENIAL_STATUSES.has(status)) fail('api-evidence-rbac');
      break;
    case 'RBAC_ACCESS_GRANTED':
      if (accessExpected || !isSuccessStatus(status)) fail('api-evidence-rbac');
      break;
    case 'RBAC_DENIAL_NOT_PROVEN':
      if (accessExpected || !Number.isInteger(status)
          || DENIAL_STATUSES.has(status) || isSuccessStatus(status)) {
        fail('api-evidence-rbac');
      }
      break;
    case 'RBAC_ACCESS_DENIED':
      if (!accessExpected || !DENIAL_STATUSES.has(status)) fail('api-evidence-rbac');
      break;
    case 'HTTP_STATUS_UNEXPECTED':
      if (!accessExpected || !Number.isInteger(status)
          || DENIAL_STATUSES.has(status) || definition !== null) {
        fail('api-evidence-status');
      }
      break;
    default:
      if (API_INSPECTION_REASONS.has(observation.reasonCode)
          && (!accessExpected || !Number.isInteger(status)
            || DENIAL_STATUSES.has(status) || definition === null)) {
        fail('api-evidence-inspection');
      }
  }
}

function validateBrowserEvidenceSemantics(observation, subject, decision) {
  const expectedPath = materializeTargetPath(subject, decision.parameterValues, 'browser');
  const { status } = observation.evidence;
  if (observation.reasonCode === 'NAVIGATION_TARGET_MISMATCH') {
    if (observation.evidence.path !== '/[TARGET_MISMATCH]'
        || observation.evidence.path === expectedPath) {
      fail('browser-evidence-target');
    }
  } else if (observation.evidence.path !== expectedPath) {
    fail('browser-evidence-target');
  }
  if (observation.outcome === 'skip') {
    if (status !== null || observation.evidence.viewport !== null) {
      fail('browser-evidence-status');
    }
    return;
  }

  const accessExpected = subjectAccessExpected(subject, observation.role);
  switch (observation.reasonCode) {
    case 'DOCUMENT_STATUS_EXPECTED':
      if (!accessExpected || !Number.isInteger(status)
          || status < 200 || status >= 300) fail('browser-evidence-status');
      break;
    case 'DOCUMENT_STATUS_UNAVAILABLE':
      if (status !== null) fail('browser-evidence-status');
      break;
    case 'DOCUMENT_STATUS_UNEXPECTED':
      if (!accessExpected || !Number.isInteger(status)
          || DENIAL_STATUSES.has(status) || (status >= 200 && status < 300)) {
        fail('browser-evidence-status');
      }
      break;
    case 'RBAC_DENIAL_EXPECTED':
      if (accessExpected || !DENIAL_STATUSES.has(status)) fail('browser-evidence-rbac');
      break;
    case 'RBAC_ACCESS_GRANTED':
      if (accessExpected || !isSuccessStatus(status)) fail('browser-evidence-rbac');
      break;
    case 'RBAC_DENIAL_NOT_PROVEN':
      if (accessExpected || !Number.isInteger(status)
          || DENIAL_STATUSES.has(status) || isSuccessStatus(status)) {
        fail('browser-evidence-rbac');
      }
      break;
    case 'RBAC_ACCESS_DENIED':
      if (!accessExpected || !DENIAL_STATUSES.has(status)) fail('browser-evidence-rbac');
      break;
    default:
  }
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
    const actual = redactString(observation.actual, redact, 'observation-actual');
    evidence.actual = observation.reasonCode === 'CONTENT_TYPE_MISMATCH'
      && actual !== observation.actual
      ? '[REDACTED]'
      : actual;
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

  const plannedRoles = new Set(decision.roles);
  if (observation.role === null) {
    if (!plannedRoles.has('unauthenticated')) fail('observation-role');
  } else if (!context.roleUniverse.has(observation.role)
      || !plannedRoles.has(observation.role)) {
    fail('observation-role');
  }
  if (observation.outcome === 'skip') {
    if (decision.action !== 'skip'
        || observation.role !== null
        || observation.reasonCode !== decision.reasonCode
        || observation.category !== 'security'
        || observation.severity !== 'info') {
      fail('observation-decision');
    }
  } else {
    if (decision.action !== 'execute') fail('observation-decision');
    const contract = trustedObservationContract(observation.source, observation.reasonCode);
    if (contract === null
        || contract.category !== observation.category
        || contract.severity !== observation.severity
        || contract.outcome !== observation.outcome) {
      fail('observation-contract');
    }
  }

  if (observation.source === 'api') {
    validateApiEvidence(observation.evidence);
    validateApiEvidenceSemantics(observation, subject, decision);
  } else {
    validateBrowserEvidence(observation.evidence);
    validateBrowserEvidenceSemantics(observation, subject, decision);
  }

  const role = observation.role === null
    ? null
    : redactString(observation.role, redact, 'observation-role');
  const service = decision.originId === null || decision.originId === 'default'
    ? null
    : redactString(decision.originId, redact, 'observation-service');
  const category = observation.outcome === 'skip' ? 'policy' : observation.category;
  const severity = observation.outcome === 'skip' ? 'info' : observation.severity;
  const reasonCode = observation.reasonCode;
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
    reasonCode,
    outcome: observation.outcome === 'skip' ? 'skip' : 'fail',
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
    source: observation.source,
    subjectId: observation.subjectId,
    role: observation.role,
    reasonCode: observation.reasonCode,
    outcome: observation.outcome,
    viewport,
    status: observation.evidence.status,
    path: observation.evidence.path,
  };
}

function expectedRole(role) {
  return role === 'unauthenticated' ? null : role;
}

function matchingObservations(observations, source, subjectId) {
  return observations.filter((entry) => (
    entry.source === source && entry.subjectId === subjectId
  ));
}

function validateTerminalObservations(observations, context) {
  const activeSources = new Set(context.mode === 'sweep'
    ? ['api', 'browser']
    : [context.mode]);
  if (observations.some((entry) => !activeSources.has(entry.source))) {
    fail('observation-mode');
  }
  const sources = [];
  if (activeSources.has('api')) sources.push(['api', context.operations]);
  if (activeSources.has('browser')) sources.push(['browser', context.routes]);

  for (const [source, decisions] of sources) {
    for (const { subject, decision } of decisions.values()) {
      const subjectObservations = matchingObservations(observations, source, subject.id);
      if (decision.action === 'skip') {
        if (subjectObservations.filter((entry) => entry.outcome === 'skip').length !== 1) {
          fail('observation-terminal-coverage');
        }
        continue;
      }

      if (source === 'api') {
        for (const role of decision.roles.map(expectedRole)) {
          if (subjectObservations.filter((entry) => entry.role === role).length !== 1) {
            fail('observation-terminal-coverage');
          }
        }
        continue;
      }

      for (const entry of subjectObservations) {
        if (entry.viewport !== null && !context.browserViewports.includes(entry.viewport)) {
          fail('observation-terminal-coverage');
        }
        if (BROWSER_STATUS_REASONS.has(entry.reasonCode) && entry.viewport === null) {
          fail('observation-terminal-coverage');
        }
      }
      for (const role of decision.roles.map(expectedRole)) {
        const roleObservations = subjectObservations.filter((entry) => entry.role === role);
        const blockers = roleObservations.filter((entry) => (
          entry.viewport === null
          && (BROWSER_SUBJECT_TERMINALS.has(entry.reasonCode)
            || BROWSER_ATTEMPT_TERMINALS.has(entry.reasonCode))
        ));
        if (blockers.length > 0) {
          if (blockers.length !== 1
              || roleObservations.some((entry) => BROWSER_STATUS_REASONS.has(entry.reasonCode))) {
            fail('observation-terminal-coverage');
          }
          continue;
        }
        for (const viewport of context.browserViewports) {
          const boundTargetFailures = roleObservations.filter((entry) => (
            entry.viewport === viewport
              && BROWSER_VIEWPORT_TERMINALS.has(entry.reasonCode)
          ));
          const terminals = roleObservations.filter((entry) => (
            entry.viewport === viewport && BROWSER_STATUS_REASONS.has(entry.reasonCode)
          ));
          if (boundTargetFailures.length > 0) {
            if (boundTargetFailures.length !== 1 || terminals.length !== 0) {
              fail('observation-terminal-coverage');
            }
            continue;
          }
          if (terminals.length !== 1
              || roleObservations.some((entry) => (
                entry.viewport === viewport && entry.status !== terminals[0].status
              ))) {
            fail('observation-terminal-coverage');
          }
        }
      }
    }
  }
}

function normalizeDiagnostic(diagnostic, redact) {
  const allowed = new Set(['code', 'message', 'sourcePath', 'pointer']);
  exactKeys(diagnostic, allowed, ['code', 'message'], 'coverage-diagnostic');
  if (!isNonBlank(diagnostic.code)
      || !REASON_CODE.test(diagnostic.code)
      || diagnostic.code === REQUIRED_COVERAGE_CODE
      || typeof diagnostic.message !== 'string'
      || diagnostic.message.trim().length === 0) {
    fail('coverage-diagnostic');
  }
  const sourcePath = hasOwn(diagnostic, 'sourcePath') ? diagnostic.sourcePath : null;
  const pointer = hasOwn(diagnostic, 'pointer') ? diagnostic.pointer : null;
  validateNullableString(sourcePath, 'coverage-diagnostic');
  validateNullableString(pointer, 'coverage-diagnostic');
  if (redactString(diagnostic.code, redact, 'coverage-diagnostic-code') !== diagnostic.code
      && !TRUSTED_COVERAGE_CODES.has(diagnostic.code)) {
    fail('coverage-diagnostic-code');
  }
  return {
    code: diagnostic.code,
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
  const requiredByPolicy = diagnostic.code === REQUIRED_COVERAGE_CODE;
  const severity = requiredByPolicy
    ? 'error'
    : status === 'unsupported'
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
      reasonCode: diagnostic.code,
      outcome: 'fail',
      severity,
      category: 'coverage',
      message: diagnostic.message,
      service: null,
      subject: { type: 'run', id: 'coverage' },
      role: null,
      evidence: {},
      provenance: [{
        source: requiredByPolicy ? 'policy' : 'manifest',
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

function terminalDurations(observations) {
  const durations = new Map();
  for (const entry of observations) {
    if (typeof entry.durationMs !== 'number'
        || (entry.source === 'browser' && !BROWSER_STATUS_REASONS.has(entry.reasonCode))) {
      continue;
    }
    const key = canonicalJson([
      entry.source, entry.subjectId, entry.role, entry.viewport,
    ]);
    durations.set(key, Math.max(durations.get(key) ?? 0, entry.durationMs));
  }
  return [...durations.values()];
}

/** Normalizes strict API/browser observations into the canonical v2 findings document. */
export function buildFindings(options = {}) {
  const {
    runId,
    manifest,
    plan,
    observations,
    coverage,
    requireCompleteCoverage = false,
    startedAt,
    finishedAt,
    redact: suppliedRedact,
  } = snapshotBuildOptions(options);
  if (!isTrustedRedactor(suppliedRedact)
      || !isNonBlank(runId)
      || !isNonBlank(startedAt)
      || !isNonBlank(finishedAt)
      || typeof requireCompleteCoverage !== 'boolean'
      || !Array.isArray(observations)) {
    fail('arguments');
  }
  const redact = createRedactionSession(suppliedRedact);
  validateManifest(manifest);
  const planContext = validatePlan(plan, manifest);
  const normalizedCoverage = normalizeCoverage(coverage, redact);
  const manifestCoverage = normalizeCoverage(manifest.coverage, redact);
  if (canonicalJson(normalizedCoverage) !== canonicalJson(manifestCoverage)) {
    fail('coverage-authority');
  }
  const effectiveCoverage = requireCompleteCoverage && normalizedCoverage.status !== 'complete'
    ? {
      status: normalizedCoverage.status,
      diagnostics: [{
        code: REQUIRED_COVERAGE_CODE,
        message: REQUIRED_COVERAGE_MESSAGE,
        sourcePath: null,
        pointer: null,
      }, ...normalizedCoverage.diagnostics].sort(
        (left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right)),
      ),
    }
    : normalizedCoverage;
  const normalizedObservations = observations.map(
    (entry) => normalizeObservation(entry, planContext, redact),
  );
  validateTerminalObservations(normalizedObservations, planContext);
  const durations = terminalDurations(normalizedObservations);
  const candidates = mergeCandidates([
    ...normalizedObservations.filter((entry) => !entry.omitted),
    ...effectiveCoverage.diagnostics.map(
      (diagnostic) => diagnosticCandidate(diagnostic, effectiveCoverage.status),
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
    coverage: effectiveCoverage,
    summary: summarize(candidates),
    findings: candidates.map((entry) => entry.finding),
  };
  const percentiles = responsePercentiles(durations);
  if (percentiles !== null) document.responseTimePercentiles = percentiles;

  try {
    return validateCanonicalFindings(document, {
      code: 'FINDINGS_INPUT_INVALID',
      message: 'Findings input does not satisfy the trusted normalization contract',
    });
  } catch {
    fail('completed-findings');
  }
}
