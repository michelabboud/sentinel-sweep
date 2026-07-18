import { readFileSync } from 'node:fs';

import { SentinelError } from './errors.mjs';
import { findingId } from './identity.mjs';
import { snapshotJson } from './json-snapshot.mjs';
import { validateAgainstSchema } from './schema.mjs';

const FINDINGS_SCHEMA = JSON.parse(
  readFileSync(new URL('../../schemas/findings.schema.json', import.meta.url), 'utf8'),
);
const SEVERITY_ORDER = new Map([
  ['critical', 0],
  ['error', 1],
  ['warning', 2],
  ['info', 3],
]);
const SUMMARY_KEYS = ['critical', 'error', 'warning', 'info', 'skipped'];
const POLICY_EVIDENCE_KEYS = new Set(['expected', 'actual']);
const API_EVIDENCE_KEYS = new Set([
  'expected', 'actual', 'statusCode', 'durationMs',
]);
const BROWSER_EVIDENCE_KEYS = new Set([
  'expected', 'actual', 'statusCode', 'durationMs', 'viewport', 'screenshotPath',
]);
const BROWSER_SCREENSHOT_BLOCKED_REASONS = new Set([
  'SCREENSHOT_CAPTURE_FAILED',
  'BROWSER_TIMEOUT',
  'BROWSER_RUNTIME_ERROR',
  'ROLE_CREDENTIAL_UNCONFIGURED',
  'SECRET_REF_INVALID',
  'SECRET_UNAVAILABLE',
  'ORIGIN_NOT_APPROVED',
  'ORIGIN_INVALID',
  'ORIGIN_SCHEME',
  'ORIGIN_USERINFO',
  'ORIGIN_QUERY',
  'ORIGIN_FRAGMENT',
  'ORIGIN_BASE_PATH',
  'ORIGIN_NON_LOOPBACK_BLOCKED',
]);
const API_STATUS_AND_DURATION_REASONS = new Set([
  'RBAC_ACCESS_GRANTED',
  'RBAC_DENIAL_NOT_PROVEN',
  'RBAC_ACCESS_DENIED',
  'HTTP_STATUS_UNEXPECTED',
  'BODY_INSPECTION_FAILED',
  'CONTENT_TYPE_MISMATCH',
  'JSON_RESPONSE_INVALID',
  'SCHEMA_NOT_FOUND',
  'SCHEMA_VIOLATION',
  'REDIRECT_LIMIT_EXCEEDED',
  'REDIRECT_SOURCE_INVALID',
  'REDIRECT_SCHEME',
  'REDIRECT_LOCATION_INVALID',
  'APPROVED_ORIGINS_INVALID',
  'REDIRECT_INVALID',
  'REDIRECT_METHOD_MISMATCH',
  'REDIRECT_TARGET_MISMATCH',
  'REDIRECT_ORIGIN_BLOCKED',
  'RESPONSE_TOO_LARGE',
]);
const API_DURATION_ONLY_REASONS = new Set([
  'REQUEST_INVALID',
  'ORIGIN_INVALID',
  'ORIGIN_SCHEME',
  'ORIGIN_USERINFO',
  'ORIGIN_QUERY',
  'ORIGIN_FRAGMENT',
  'ORIGIN_BASE_PATH',
  'ORIGIN_NON_LOOPBACK_BLOCKED',
  'PATH_ABSOLUTE_URL',
  'PATH_RELATIVE_REQUIRED',
  'METHOD_INVALID',
  'HEADERS_INVALID',
]);
const API_OPTIONAL_STATUS_REASONS = new Set([
  'HTTP_TIMEOUT',
  'HTTP_NETWORK_ERROR',
]);
const API_EXACT_TEXT_REASONS = new Set([
  'SECRET_REF_INVALID',
  'SECRET_UNAVAILABLE',
  'ROLE_CREDENTIAL_UNCONFIGURED',
  'HTTP_RUNTIME_ERROR',
]);
const API_REDIRECT_REASONS = new Set([
  'REDIRECT_LIMIT_EXCEEDED',
  'REDIRECT_SOURCE_INVALID',
  'REDIRECT_SCHEME',
  'REDIRECT_LOCATION_INVALID',
  'APPROVED_ORIGINS_INVALID',
  'REDIRECT_INVALID',
  'REDIRECT_METHOD_MISMATCH',
  'REDIRECT_TARGET_MISMATCH',
  'REDIRECT_ORIGIN_BLOCKED',
]);
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
  '[REDACTED]',
]);
const BROWSER_PREATTEMPT_REASONS = new Set([
  'ORIGIN_NOT_APPROVED',
  'ORIGIN_INVALID',
  'ORIGIN_SCHEME',
  'ORIGIN_USERINFO',
  'ORIGIN_QUERY',
  'ORIGIN_FRAGMENT',
  'ORIGIN_BASE_PATH',
  'ORIGIN_NON_LOOPBACK_BLOCKED',
  'ROLE_CREDENTIAL_UNCONFIGURED',
  'SECRET_REF_INVALID',
  'SECRET_UNAVAILABLE',
]);
const DENIAL_STATUS_CODES = new Set([401, 403]);
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

function parameterScalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Materializes the exact relative transport target represented by an immutable decision. */
export function materializeRequestTarget(subject, parameterValues) {
  let target = subject.path;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(parameterValues)) {
    const separator = key.indexOf(':');
    if (separator < 1) continue;
    const location = key.slice(0, separator);
    const name = key.slice(separator + 1);
    if (location === 'path') {
      target = target.split(`{${name}}`).join(encodeURIComponent(parameterScalar(value)));
    } else if (location === 'query') {
      query.append(name, parameterScalar(value));
    }
  }
  const suffix = query.toString();
  if (suffix.length > 0) target += `${target.includes('?') ? '&' : '?'}${suffix}`;
  return target;
}

/** Materializes non-value evidence from the manifest template and parameter locations. */
export function materializeTargetPath(subject, parameterValues) {
  const declaredPath = typeof subject?.path === 'string' ? subject.path : '/';
  const queryStart = declaredPath.indexOf('?');
  const pathTemplate = queryStart < 0 ? declaredPath : declaredPath.slice(0, queryStart);
  const hasPlannedQuery = queryStart >= 0 || Object.keys(parameterValues).some(
    (key) => key.startsWith('query:'),
  );
  return hasPlannedQuery ? `${pathTemplate}?[QUERY_PRESENT]` : pathTemplate;
}

/** Returns the manifest-declared access expectation for one planned role. */
export function subjectAccessExpected(subject, role) {
  if (subject.auth?.state === 'public') return role === null;
  return role !== null
    && subject.auth?.state === 'required'
    && subject.auth.allowedRoles.includes(role);
}

function policyContract(entries) {
  return new Map(entries.map(([reasonCode, subjectType, action, operationKind = null]) => [
    reasonCode,
    Object.freeze({ subjectType, action, operationKind }),
  ]));
}

const POLICY_DECISIONS = policyContract([
  ['READ_APPROVED', 'operation', 'execute', 'read'],
  ['READ_BLOCKED_UNKNOWN_EFFECTS', 'operation', 'skip', 'read'],
  ['READ_BLOCKED_ORIGIN', 'operation', 'skip', 'read'],
  ['READ_BLOCKED_PARAMETERS', 'operation', 'skip', 'read'],
  ['READ_BLOCKED_UNKNOWN_AUTH', 'operation', 'skip', 'read'],
  ['READ_BLOCKED_RESPONSES', 'operation', 'skip', 'read'],
  ['MUTATION_APPROVED', 'operation', 'execute', 'mutation'],
  ['MUTATION_BLOCKED_DISABLED', 'operation', 'skip', 'mutation'],
  ['MUTATION_BLOCKED_ALLOWLIST', 'operation', 'skip', 'mutation'],
  ['MUTATION_BLOCKED_UNKNOWN_EFFECTS', 'operation', 'skip', 'mutation'],
  ['MUTATION_BLOCKED_ROLLBACK', 'operation', 'skip', 'mutation'],
  ['MUTATION_BLOCKED_ENVIRONMENT', 'operation', 'skip', 'mutation'],
  ['MUTATION_BLOCKED_ORIGIN', 'operation', 'skip', 'mutation'],
  ['MUTATION_BLOCKED_ACKNOWLEDGEMENT', 'operation', 'skip', 'mutation'],
  ['MUTATION_BLOCKED_UNKNOWN_AUTH', 'operation', 'skip', 'mutation'],
  ['MUTATION_BLOCKED_PARAMETERS', 'operation', 'skip', 'mutation'],
  ['ROUTE_APPROVED', 'route', 'execute'],
  ['ROUTE_BLOCKED_ORIGIN', 'route', 'skip'],
  ['ROUTE_BLOCKED_PARAMETERS', 'route', 'skip'],
  ['ROUTE_BLOCKED_UNKNOWN_AUTH', 'route', 'skip'],
]);

/** Returns the immutable trusted tuple for one policy reason, if any. */
export function trustedPolicyDecisionContract(subjectType, reasonCode) {
  const contract = POLICY_DECISIONS.get(reasonCode) ?? null;
  return contract?.subjectType === subjectType ? contract : null;
}

function observationContract(entries) {
  return new Map(entries.map(([reasonCode, category, severity, outcome]) => [
    reasonCode,
    Object.freeze({ category, severity, outcome }),
  ]));
}

const API_OBSERVATIONS = observationContract([
  ['RBAC_DENIAL_EXPECTED', 'rbac', 'info', 'pass'],
  ['HTTP_STATUS_EXPECTED', 'health', 'info', 'pass'],
  ['RBAC_ACCESS_GRANTED', 'rbac', 'critical', 'fail'],
  ['RBAC_DENIAL_NOT_PROVEN', 'rbac', 'error', 'fail'],
  ['RBAC_ACCESS_DENIED', 'rbac', 'error', 'fail'],
  ['HTTP_STATUS_UNEXPECTED', 'health', 'error', 'fail'],
  ['BODY_INSPECTION_FAILED', 'schema', 'error', 'fail'],
  ['CONTENT_TYPE_MISMATCH', 'schema', 'error', 'fail'],
  ['JSON_RESPONSE_INVALID', 'schema', 'error', 'fail'],
  ['SCHEMA_NOT_FOUND', 'schema', 'error', 'fail'],
  ['SCHEMA_VIOLATION', 'schema', 'error', 'fail'],
  ['SECRET_REF_INVALID', 'security', 'error', 'fail'],
  ['SECRET_UNAVAILABLE', 'security', 'error', 'fail'],
  ['ROLE_CREDENTIAL_UNCONFIGURED', 'security', 'error', 'fail'],
  ['ORIGIN_NOT_APPROVED', 'security', 'error', 'fail'],
  ['REQUEST_INVALID', 'security', 'error', 'fail'],
  ['ORIGIN_INVALID', 'security', 'error', 'fail'],
  ['ORIGIN_SCHEME', 'security', 'error', 'fail'],
  ['ORIGIN_USERINFO', 'security', 'error', 'fail'],
  ['ORIGIN_QUERY', 'security', 'error', 'fail'],
  ['ORIGIN_FRAGMENT', 'security', 'error', 'fail'],
  ['ORIGIN_BASE_PATH', 'security', 'error', 'fail'],
  ['ORIGIN_NON_LOOPBACK_BLOCKED', 'security', 'error', 'fail'],
  ['PATH_ABSOLUTE_URL', 'security', 'error', 'fail'],
  ['PATH_RELATIVE_REQUIRED', 'security', 'error', 'fail'],
  ['METHOD_INVALID', 'security', 'error', 'fail'],
  ['HEADERS_INVALID', 'security', 'error', 'fail'],
  ['REDIRECT_LIMIT_EXCEEDED', 'security', 'error', 'fail'],
  ['REDIRECT_SOURCE_INVALID', 'security', 'error', 'fail'],
  ['REDIRECT_SCHEME', 'security', 'error', 'fail'],
  ['REDIRECT_LOCATION_INVALID', 'security', 'error', 'fail'],
  ['APPROVED_ORIGINS_INVALID', 'security', 'error', 'fail'],
  ['REDIRECT_INVALID', 'security', 'error', 'fail'],
  ['REDIRECT_METHOD_MISMATCH', 'security', 'error', 'fail'],
  ['REDIRECT_TARGET_MISMATCH', 'security', 'error', 'fail'],
  ['REDIRECT_ORIGIN_BLOCKED', 'security', 'critical', 'fail'],
  ['HTTP_TIMEOUT', 'network', 'error', 'fail'],
  ['HTTP_NETWORK_ERROR', 'network', 'error', 'fail'],
  ['RESPONSE_TOO_LARGE', 'network', 'error', 'fail'],
  ['HTTP_RUNTIME_ERROR', 'network', 'error', 'fail'],
]);

const BROWSER_OBSERVATIONS = observationContract([
  ['RBAC_DENIAL_EXPECTED', 'rbac', 'info', 'pass'],
  ['DOCUMENT_STATUS_EXPECTED', 'health', 'info', 'pass'],
  ['RBAC_ACCESS_GRANTED', 'rbac', 'critical', 'fail'],
  ['RBAC_DENIAL_NOT_PROVEN', 'rbac', 'error', 'fail'],
  ['RBAC_ACCESS_DENIED', 'rbac', 'error', 'fail'],
  ['DOCUMENT_STATUS_UNAVAILABLE', 'health', 'error', 'fail'],
  ['DOCUMENT_STATUS_UNEXPECTED', 'health', 'error', 'fail'],
  ['BROWSER_EVENT_HANDLER_FAILED', 'runtime', 'error', 'fail'],
  ['SCREENSHOT_CAPTURE_FAILED', 'runtime', 'error', 'fail'],
  ['BROWSER_RUNTIME_ERROR', 'runtime', 'error', 'fail'],
  ['WORKER_BLOCKED', 'security', 'critical', 'fail'],
  ['SERVICE_WORKER_BLOCKED', 'security', 'critical', 'fail'],
  ['UNEXPECTED_TARGET_BLOCKED', 'security', 'critical', 'fail'],
  ['BROWSER_TARGET_POLICY_FAILED', 'security', 'critical', 'fail'],
  ['FRAME_MUTATION_BLOCKED', 'security', 'critical', 'fail'],
  ['BROWSER_MUTATION_BLOCKED', 'security', 'critical', 'fail'],
  ['NAVIGATION_ORIGIN_BLOCKED', 'security', 'critical', 'fail'],
  ['NAVIGATION_TARGET_MISMATCH', 'security', 'error', 'fail'],
  ['BROWSER_WEBSOCKET_BLOCKED', 'security', 'critical', 'fail'],
  ['RESOURCE_STATUS_ERROR', 'network', 'error', 'fail'],
  ['RESOURCE_LOAD_FAILED', 'network', 'error', 'fail'],
  ['NAVIGATION_FAILED', 'network', 'error', 'fail'],
  ['BROWSER_TIMEOUT', 'network', 'error', 'fail'],
  ['CONSOLE_ERROR', 'console', 'error', 'fail'],
  ['UNCAUGHT_EXCEPTION', 'console', 'error', 'fail'],
  ['BROWSER_LOG_ERROR', 'console', 'error', 'fail'],
  ['HORIZONTAL_OVERFLOW', 'layout', 'error', 'fail'],
  ['EMPTY_SELECTOR_INVALID', 'configuration', 'error', 'fail'],
  ['EMPTY_CONTAINER', 'content', 'error', 'fail'],
  ['ROLE_CREDENTIAL_UNCONFIGURED', 'security', 'error', 'fail'],
  ['SECRET_REF_INVALID', 'security', 'error', 'fail'],
  ['SECRET_UNAVAILABLE', 'security', 'error', 'fail'],
  ['ORIGIN_NOT_APPROVED', 'security', 'error', 'fail'],
  ['ORIGIN_INVALID', 'security', 'error', 'fail'],
  ['ORIGIN_SCHEME', 'security', 'error', 'fail'],
  ['ORIGIN_USERINFO', 'security', 'error', 'fail'],
  ['ORIGIN_QUERY', 'security', 'error', 'fail'],
  ['ORIGIN_FRAGMENT', 'security', 'error', 'fail'],
  ['ORIGIN_BASE_PATH', 'security', 'error', 'fail'],
  ['ORIGIN_NON_LOOPBACK_BLOCKED', 'security', 'error', 'fail'],
]);

/** Returns the immutable trusted tuple for a raw engine observation, if any. */
export function trustedObservationContract(source, reasonCode) {
  return (source === 'api' ? API_OBSERVATIONS
    : source === 'browser' ? BROWSER_OBSERVATIONS
      : null)?.get(reasonCode) ?? null;
}

export function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(compareCodeUnits).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new SentinelError('FINDINGS_DOCUMENT_INVALID', 'Canonical JSON value is invalid');
  }
  return serialized;
}

function compareNullable(left, right) {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compareCodeUnits(left, right);
}

export function compareFindings(left, right) {
  return SEVERITY_ORDER.get(left.severity) - SEVERITY_ORDER.get(right.severity)
    || compareCodeUnits(left.category, right.category)
    || compareCodeUnits(left.subject.type, right.subject.type)
    || compareCodeUnits(left.subject.id, right.subject.id)
    || compareNullable(left.role, right.role)
    || compareCodeUnits(left.id, right.id);
}

function contractError(code, message) {
  return new SentinelError(code, message);
}

function requireCanonicalOrder(values, comparator, failure) {
  for (let index = 1; index < values.length; index += 1) {
    if (comparator(values[index - 1], values[index]) >= 0) throw failure;
  }
}

function identityFor(finding, coverageDiagnostic = null) {
  return {
    subjectType: finding.subject.type,
    subjectId: finding.subject.id,
    service: finding.service ?? null,
    role: finding.role,
    category: finding.category,
    reasonCode: finding.reasonCode,
    viewport: Object.hasOwn(finding.evidence, 'viewport')
      ? finding.evidence.viewport
      : null,
    diagnosticSourcePath: coverageDiagnostic?.sourcePath ?? null,
    diagnosticPointer: coverageDiagnostic?.pointer ?? null,
  };
}

function matchingCoverageDiagnostic(document, finding) {
  const provenance = finding.provenance[0];
  const matches = document.coverage.diagnostics.filter((diagnostic) => (
    diagnostic.code === finding.reasonCode
    && diagnostic.message === finding.message
    && (diagnostic.sourcePath ?? null) === (provenance?.sourcePath ?? null)
    && (diagnostic.pointer ?? null) === (provenance?.pointer ?? null)
  ));
  return matches.length === 1 ? matches[0] : null;
}

function validateEvidenceKeys(finding, allowedKeys, failure) {
  if (!Object.hasOwn(finding.evidence, 'expected')
      || !Object.hasOwn(finding.evidence, 'actual')) {
    throw failure;
  }
  const keys = Object.keys(finding.evidence);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (!allowedKeys.has(key) || finding.evidence[key] === null) throw failure;
  }
}

function requireEvidence(finding, key, failure) {
  if (!Object.hasOwn(finding.evidence, key)) throw failure;
}

function forbidEvidence(finding, key, failure) {
  if (Object.hasOwn(finding.evidence, key)) throw failure;
}

function validateObservedStatus(finding, source, failure) {
  const hasStatus = Object.hasOwn(finding.evidence, 'statusCode');
  const status = finding.evidence.statusCode;
  const reason = finding.reasonCode;
  if (reason === 'CONTENT_TYPE_MISMATCH'
      && !CONTENT_TYPE_MISMATCH_ACTUALS.has(finding.evidence.actual)) {
    throw failure;
  }
  if (source === 'api') {
    if (API_STATUS_AND_DURATION_REASONS.has(reason)) {
      requireEvidence(finding, 'statusCode', failure);
      requireEvidence(finding, 'durationMs', failure);
    } else if (API_DURATION_ONLY_REASONS.has(reason)) {
      requireEvidence(finding, 'durationMs', failure);
      forbidEvidence(finding, 'statusCode', failure);
    } else if (API_OPTIONAL_STATUS_REASONS.has(reason)) {
      requireEvidence(finding, 'durationMs', failure);
    } else if (API_EXACT_TEXT_REASONS.has(reason)) {
      forbidEvidence(finding, 'statusCode', failure);
      forbidEvidence(finding, 'durationMs', failure);
    } else if (reason === 'ORIGIN_NOT_APPROVED') {
      forbidEvidence(finding, 'statusCode', failure);
    } else {
      throw failure;
    }
  } else if (BROWSER_PREATTEMPT_REASONS.has(reason)) {
    forbidEvidence(finding, 'statusCode', failure);
    forbidEvidence(finding, 'durationMs', failure);
    forbidEvidence(finding, 'viewport', failure);
    forbidEvidence(finding, 'screenshotPath', failure);
  } else {
    requireEvidence(finding, 'durationMs', failure);
    requireEvidence(finding, 'viewport', failure);
    if (reason === 'DOCUMENT_STATUS_UNAVAILABLE') forbidEvidence(finding, 'statusCode', failure);
  }

  if (reason === 'RBAC_ACCESS_GRANTED') {
    if (!hasStatus || status < 200 || status >= 300
        || finding.evidence.actual !== String(status)) throw failure;
  } else if (reason === 'RBAC_DENIAL_NOT_PROVEN') {
    if (!hasStatus || (status >= 200 && status < 300)
        || DENIAL_STATUS_CODES.has(status)
        || finding.evidence.actual !== String(status)) throw failure;
  } else if (reason === 'RBAC_ACCESS_DENIED') {
    if (!hasStatus || !DENIAL_STATUS_CODES.has(status)
        || finding.evidence.actual !== String(status)) throw failure;
  } else if (reason === 'HTTP_STATUS_UNEXPECTED'
      || reason === 'DOCUMENT_STATUS_UNEXPECTED') {
    if (!hasStatus || DENIAL_STATUS_CODES.has(status)
        || (source === 'browser' && status >= 200 && status < 300)
        || finding.evidence.actual !== String(status)) throw failure;
  } else if (source === 'api' && API_REDIRECT_REASONS.has(reason)
      && (!hasStatus || !REDIRECT_STATUS_CODES.has(status))) {
    throw failure;
  } else if (source === 'api' && API_INSPECTION_REASONS.has(reason)
      && DENIAL_STATUS_CODES.has(status)) {
    throw failure;
  }
}

function hasExactSourceProvenance(finding, source) {
  if (finding.provenance.length !== 2) return false;
  let manifestCount = 0;
  let sourceCount = 0;
  for (let index = 0; index < finding.provenance.length; index += 1) {
    const entry = finding.provenance[index];
    if (entry.source === 'manifest') manifestCount += 1;
    else if (entry.source === source
        && entry.sourcePath === null
        && entry.pointer === null) sourceCount += 1;
    else return false;
  }
  return manifestCount === 1 && sourceCount === 1;
}

function validateObservationEvidence(finding, source, failure) {
  if (source === 'api') {
    validateEvidenceKeys(finding, API_EVIDENCE_KEYS, failure);
    validateObservedStatus(finding, source, failure);
    return;
  }
  validateEvidenceKeys(finding, BROWSER_EVIDENCE_KEYS, failure);
  if (Object.hasOwn(finding.evidence, 'screenshotPath')
      && (finding.role !== null
        || !Object.hasOwn(finding.evidence, 'viewport')
        || BROWSER_SCREENSHOT_BLOCKED_REASONS.has(finding.reasonCode))) {
    throw failure;
  }
  validateObservedStatus(finding, source, failure);
}

function validateSemantics(document, failure) {
  requireCanonicalOrder(
    document.coverage.diagnostics,
    (left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right)),
    failure,
  );
  requireCanonicalOrder(document.findings, compareFindings, failure);

  const ids = new Set();
  const summary = { critical: 0, error: 0, warning: 0, info: 0, skipped: 0 };
  const matchedCoverage = new Set();
  let nonPolicyCoverageDiagnostics = 0;
  for (let findingIndex = 0; findingIndex < document.findings.length; findingIndex += 1) {
    const finding = document.findings[findingIndex];
    if (ids.has(finding.id)) throw failure;
    ids.add(finding.id);
    requireCanonicalOrder(
      finding.provenance,
      (left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right)),
      failure,
    );
    if (finding.provenance.length === 0) throw failure;

    if (finding.outcome === 'skip') {
      const policy = trustedPolicyDecisionContract(
        finding.subject.type,
        finding.reasonCode,
      );
      if (policy === null
          || policy.action !== 'skip'
          || finding.severity !== 'info'
          || finding.category !== 'policy'
          || finding.role !== null
          || !['operation', 'route'].includes(finding.subject.type)
          || !hasExactSourceProvenance(finding, 'policy')) {
        throw failure;
      }
      validateEvidenceKeys(finding, POLICY_EVIDENCE_KEYS, failure);
      summary.skipped += 1;
    } else if (finding.outcome === 'fail') {
      summary[finding.severity] += 1;
    } else {
      throw failure;
    }

    let diagnostic = null;
    if (finding.category === 'coverage') {
      diagnostic = matchingCoverageDiagnostic(document, finding);
      const requiredByPolicy = finding.reasonCode === 'COVERAGE_REQUIRED_INCOMPLETE';
      if (diagnostic === null
          || finding.subject.type !== 'run'
          || finding.subject.id !== 'coverage'
          || finding.service !== null
          || finding.role !== null
          || finding.outcome !== 'fail'
          || Object.keys(finding.evidence).length !== 0
          || finding.provenance.length !== 1) {
        throw failure;
      }
      if (requiredByPolicy) {
        if (document.coverage.status === 'complete'
            || diagnostic.message !== 'Trusted configuration requires complete coverage'
            || diagnostic.sourcePath !== null
            || diagnostic.pointer !== null
            || finding.provenance[0].source !== 'policy'
            || finding.severity !== 'error') {
          throw failure;
        }
      } else if (finding.provenance[0].source !== 'manifest') {
        throw failure;
      } else {
        nonPolicyCoverageDiagnostics += 1;
      }
      const expectedSeverity = requiredByPolicy
        ? 'error'
        : document.coverage.status === 'unsupported'
        ? 'error'
        : document.coverage.status === 'partial' ? 'warning' : 'info';
      if (finding.severity !== expectedSeverity) throw failure;
      matchedCoverage.add(canonicalJson(diagnostic));
    } else if (finding.subject.type === 'run' && finding.subject.id === 'coverage') {
      throw failure;
    } else if (finding.outcome === 'fail') {
      const source = finding.subject.type === 'operation'
        ? 'api'
        : finding.subject.type === 'route' ? 'browser' : null;
      const contract = trustedObservationContract(source, finding.reasonCode);
      if (source === null
          || contract === null
          || contract.outcome !== 'fail'
          || contract.category !== finding.category
          || contract.severity !== finding.severity
          || !hasExactSourceProvenance(finding, source)) {
        throw failure;
      }
      validateObservationEvidence(finding, source, failure);
    }

    if (finding.id !== findingId(identityFor(finding, diagnostic))) throw failure;
  }

  if (matchedCoverage.size !== document.coverage.diagnostics.length) throw failure;
  if (document.coverage.status !== 'complete' && nonPolicyCoverageDiagnostics === 0) throw failure;
  for (let keyIndex = 0; keyIndex < SUMMARY_KEYS.length; keyIndex += 1) {
    const key = SUMMARY_KEYS[keyIndex];
    if (document.summary[key] !== summary[key]) throw failure;
  }

  if (Object.hasOwn(document, 'responseTimePercentiles')) {
    const percentiles = document.responseTimePercentiles;
    if (percentiles.p50 > percentiles.p95
        || percentiles.p95 > percentiles.p99) {
      throw failure;
    }
  }
}

/** Snapshots, schema-validates, and semantically validates one canonical findings document. */
export function validateCanonicalFindings(value, {
  code = 'FINDINGS_DOCUMENT_INVALID',
  message = 'Input is not a canonical Sentinel findings document',
} = {}) {
  const failure = contractError(code, message);
  let document;
  try {
    document = snapshotJson(value, { code, message });
    validateAgainstSchema(document, FINDINGS_SCHEMA, { name: 'findings' });
    validateSemantics(document, failure);
  } catch (error) {
    if (error === failure || error?.code === code) throw failure;
    throw failure;
  }
  return document;
}
