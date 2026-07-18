import { requestApproved, responseDefinition } from './http.mjs';
import {
  materializeRequestTarget,
  materializeTargetPath,
} from '../lib/findings-contract.mjs';
import { requireExecutionContext } from '../policy/execution.mjs';
import { captureRoleCredentials } from '../lib/secrets.mjs';

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DENIAL_STATUSES = new Set([401, 403]);
const RESERVED_AUTH_HEADERS = new Set([
  'api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-access-token',
  'x-api-key',
  'x-auth-token',
]);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function evidence(operation, fields = {}) {
  const value = {
    method: typeof operation?.method === 'string' ? operation.method.toUpperCase() : 'UNKNOWN',
    path: typeof fields.path === 'string'
      ? fields.path
      : (typeof operation?.path === 'string' ? operation.path : '/'),
    status: fields.status ?? null,
    durationMs: fields.durationMs ?? null,
    bytes: fields.bytes ?? null,
    redirects: fields.redirects ?? 0,
  };
  if (fields.schemaViolations !== undefined) {
    value.schemaViolations = fields.schemaViolations;
  }
  return deepFreeze(value);
}

function observation(operation, fields) {
  return deepFreeze({
    source: 'api',
    subjectId: typeof operation?.id === 'string' ? operation.id : 'unknown-operation',
    category: fields.category,
    severity: fields.severity,
    outcome: fields.outcome,
    role: fields.role ?? null,
    reasonCode: fields.reasonCode,
    message: fields.message,
    expected: fields.expected ?? null,
    actual: fields.actual ?? null,
    evidence: evidence(operation, fields.evidence),
  });
}

function policySkip(operation, decision) {
  return observation(operation, {
    category: 'security',
    severity: 'info',
    outcome: 'skip',
    role: null,
    reasonCode: decision?.reasonCode ?? 'POLICY_DECISION_MISSING',
    message: `Policy skipped ${operation?.method ?? 'UNKNOWN'} ${operation?.path ?? '/'}`,
    expected: 'policy approval',
    actual: decision?.reasonCode ?? 'missing decision',
    evidence: {
      path: materializeTargetPath(operation, decision?.parameterValues ?? {}),
    },
  });
}

function resolveOrigin(config, originId) {
  if (originId === 'default'
      && Array.isArray(config?.approvedOrigins)
      && config.approvedOrigins.length === 1) {
    return config.approvedOrigins[0];
  }
  if (!Array.isArray(config?.services)) return null;
  const matching = config.services.filter((service) => service?.name === originId);
  return matching.length === 1 ? matching[0].approvedOrigin : null;
}

function materializeRequest(operation, parameterValues) {
  const values = parameterValues ?? {};
  const path = materializeRequestTarget(operation, values);
  const evidencePath = materializeTargetPath(operation, values);
  const headers = {};

  for (const [key, value] of Object.entries(parameterValues ?? {})) {
    const separator = key.indexOf(':');
    if (separator < 1) continue;
    const location = key.slice(0, separator);
    const name = key.slice(separator + 1);
    if (location === 'header' && !RESERVED_AUTH_HEADERS.has(name.toLowerCase())) {
      const scalar = value === null || value === undefined
        ? ''
        : typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : JSON.stringify(value);
      headers[name] = scalar;
    }
  }
  return { path, evidencePath, headers };
}

function attemptsFor(operation, decision) {
  const allowed = new Set(
    (Array.isArray(operation?.auth?.allowedRoles) ? operation.auth.allowedRoles : [])
      .filter((role) => typeof role === 'string' && role !== 'unauthenticated'),
  );
  const roles = [
    ...decision.roles.filter((role) => role === 'unauthenticated'),
    ...decision.roles.filter((role) => role !== 'unauthenticated'),
  ];
  return roles.map((plannedRole) => {
    const role = plannedRole === 'unauthenticated' ? null : plannedRole;
    return {
      role,
      accessExpected: operation?.auth?.state === 'public' || allowed.has(role),
    };
  });
}

function plannedCredentialRoles(decisions) {
  return decisions
    .filter((decision) => decision.action === 'execute')
    .flatMap((decision) => decision.roles)
    .filter((role) => role !== 'unauthenticated');
}

function declaredStatuses(operation) {
  const keys = Object.keys(operation?.responses ?? {}).sort();
  return keys.length > 0 ? keys.join(', ') : 'a declared response status';
}

function transportFailure(operation, role, result) {
  let category = 'network';
  let severity = 'error';
  let expected = 'a bounded HTTP response';
  let actual = result.outcome;
  if (result.outcome === 'blocked') {
    category = 'security';
    severity = result.reasonCode === 'REDIRECT_ORIGIN_BLOCKED' ? 'critical' : 'error';
    expected = 'a same-origin approved request';
    actual = result.reasonCode;
  } else if (result.reasonCode === 'HTTP_TIMEOUT') {
    expected = 'response before timeout';
    actual = 'timeout';
  } else if (result.reasonCode === 'RESPONSE_TOO_LARGE') {
    expected = 'response within configured byte limit';
    actual = result.bytes === null ? 'oversized response' : `${result.bytes} bytes`;
  }

  return observation(operation, {
    category,
    severity,
    outcome: 'fail',
    role,
    reasonCode: result.reasonCode,
    message: `${operation.method} ${operation.path} did not produce an approved bounded response`,
    expected,
    actual,
    evidence: result,
  });
}

function denialObservation(operation, role, result) {
  if (DENIAL_STATUSES.has(result.status)) {
    return observation(operation, {
      category: 'rbac',
      severity: 'info',
      outcome: 'pass',
      role,
      reasonCode: 'RBAC_DENIAL_EXPECTED',
      message: `${operation.method} ${operation.path} denied an unauthorized role`,
      expected: '401 or 403',
      actual: String(result.status),
      evidence: result,
    });
  }

  return observation(operation, {
    category: 'rbac',
    severity: result.status >= 200 && result.status < 300 ? 'critical' : 'error',
    outcome: 'fail',
    role,
    reasonCode: result.status >= 200 && result.status < 300
      ? 'RBAC_ACCESS_GRANTED'
      : 'RBAC_DENIAL_NOT_PROVEN',
    message: `${operation.method} ${operation.path} did not prove the expected denial`,
    expected: '401 or 403',
    actual: String(result.status),
    evidence: result,
  });
}

function accessDeniedObservation(operation, role, result) {
  return observation(operation, {
    category: 'rbac',
    severity: 'error',
    outcome: 'fail',
    role,
    reasonCode: 'RBAC_ACCESS_DENIED',
    message: `${operation.method} ${operation.path} denied an authorized role`,
    expected: declaredStatuses(operation),
    actual: String(result.status),
    evidence: result,
  });
}

function statusObservation(operation, role, result) {
  return observation(operation, {
    category: 'health',
    severity: 'error',
    outcome: 'fail',
    role,
    reasonCode: 'HTTP_STATUS_UNEXPECTED',
    message: `${operation.method} ${operation.path} returned an undeclared status`,
    expected: declaredStatuses(operation),
    actual: String(result.status),
    evidence: result,
  });
}

function normalizedMediaType(value) {
  if (typeof value !== 'string') return null;
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
    ? mediaType
    : null;
}

function inspectionObservation(operation, role, result, definition) {
  const reasonCode = result.inspection === null
    ? 'BODY_INSPECTION_FAILED'
    : result.inspection.reasonCode;
  if (reasonCode === null) return null;

  const expectedMediaType = normalizedMediaType(definition?.contentType);
  const violations = result.inspection?.schemaViolations ?? [];
  const fields = {
    category: 'schema',
    severity: 'error',
    outcome: 'fail',
    role,
    reasonCode,
    message: `${operation.method} ${operation.path} response inspection failed`,
    expected: definition?.schemaId ?? expectedMediaType,
    actual: reasonCode,
    evidence: violations.length > 0
      ? { ...result, schemaViolations: violations }
      : result,
  };

  if (reasonCode === 'CONTENT_TYPE_MISMATCH') {
    fields.message = `${operation.method} ${operation.path} returned an unexpected media type`;
    fields.expected = expectedMediaType;
    fields.actual = result.contentType === 'valid'
      ? 'different valid media type'
      : 'missing or invalid content type';
  } else if (reasonCode === 'JSON_RESPONSE_INVALID') {
    fields.message = `${operation.method} ${operation.path} returned invalid declared JSON`;
    fields.expected = expectedMediaType;
    fields.actual = 'invalid JSON';
  } else if (reasonCode === 'SCHEMA_NOT_FOUND') {
    fields.message = `${operation.method} ${operation.path} references an unavailable response schema`;
    fields.expected = definition?.schemaId ?? null;
    fields.actual = 'schema unavailable';
  } else if (reasonCode === 'SCHEMA_VIOLATION') {
    fields.message = `${operation.method} ${operation.path} response drifted from its schema`;
    fields.expected = definition?.schemaId ?? null;
    fields.actual = `${violations.length} schema violation${violations.length === 1 ? '' : 's'}`;
  }

  return observation(operation, fields);
}

function accessPassObservation(operation, role, result) {
  return observation(operation, {
    category: 'health',
    severity: 'info',
    outcome: 'pass',
    role,
    reasonCode: 'HTTP_STATUS_EXPECTED',
    message: `${operation.method} ${operation.path} returned a declared status`,
    expected: declaredStatuses(operation),
    actual: String(result.status),
    evidence: result,
  });
}

function secretFailure(operation, role, error, requestPath) {
  return observation(operation, {
    category: 'security',
    severity: 'error',
    outcome: 'fail',
    role,
    reasonCode: error?.code ?? 'SECRET_UNAVAILABLE',
    message: `Credential for role ${role} was unavailable`,
    expected: 'available environment secret reference',
    actual: error?.code ?? 'SECRET_UNAVAILABLE',
    evidence: { path: requestPath },
  });
}

function roleCredentialUnconfigured(operation, role, requestPath) {
  return observation(operation, {
    category: 'security',
    severity: 'error',
    outcome: 'fail',
    role,
    reasonCode: 'ROLE_CREDENTIAL_UNCONFIGURED',
    message: `Credential mapping for allowed role ${role} is not configured`,
    expected: 'trusted role token reference',
    actual: 'role credential mapping unavailable',
    evidence: { path: requestPath },
  });
}

async function executeAttempt({
  operation,
  decision,
  config,
  credentials,
  fetchImpl,
  role,
  accessExpected,
}) {
  const request = materializeRequest(operation, decision.parameterValues);
  const origin = resolveOrigin(config, decision.originId);
  if (typeof origin !== 'string') {
    return observation(operation, {
      category: 'security',
      severity: 'error',
      outcome: 'fail',
      role,
      reasonCode: 'ORIGIN_NOT_APPROVED',
      message: `${operation.method} ${operation.path} has no approved origin`,
      expected: 'approved service origin',
      actual: 'origin unavailable',
      evidence: { path: request.evidencePath },
    });
  }

  if (role !== null) {
    const credential = credentials.get(role);
    if (credential?.error === 'ROLE_CREDENTIAL_UNCONFIGURED'
        || credential === undefined) {
      return roleCredentialUnconfigured(operation, role, request.evidencePath);
    }
    if (credential.error !== null) {
      return secretFailure(operation, role, { code: credential.error }, request.evidencePath);
    }
    request.headers.authorization = `Bearer ${credential.token}`;
  }

  let result;
  try {
    const transport = await requestApproved({
      origin,
      path: request.path,
      method: operation.method,
      headers: request.headers,
      body: undefined,
      timeoutMs: config?.responseTimeoutMs,
      maxBytes: config?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      approvedOrigins: config?.approvedOrigins,
      allowNonLoopback: config?.allowNonLoopback === true,
      bindPath: true,
      responses: operation.responses,
      schemaRegistry: config.__manifestSchemas,
      fetchImpl,
    });
    result = {
      ...transport,
      path: request.evidencePath,
    };
  } catch {
    return observation(operation, {
      category: 'network',
      severity: 'error',
      outcome: 'fail',
      role,
      reasonCode: 'HTTP_RUNTIME_ERROR',
      message: `${operation.method} ${operation.path} failed inside the HTTP runtime`,
      expected: 'bounded HTTP observation',
      actual: 'runtime error',
      evidence: { path: request.evidencePath },
    });
  }

  if (result.outcome !== 'response') return transportFailure(operation, role, result);
  if (!accessExpected) return denialObservation(operation, role, result);
  if (DENIAL_STATUSES.has(result.status)) return accessDeniedObservation(operation, role, result);

  const definition = responseDefinition(operation.responses, result.status);
  if (definition === null) return statusObservation(operation, role, result);
  return inspectionObservation(operation, role, result, definition)
    ?? accessPassObservation(operation, role, result);
}

/** Executes the immutable policy ledger and returns secret-free API observations. */
export async function sweepApi({ manifest, plan, config, env = process.env, fetchImpl } = {}) {
  ({ manifest, config } = requireExecutionContext(plan, 'api'));
  const trustedPlan = plan;
  const operations = Array.isArray(manifest?.operations) ? manifest.operations : [];
  const decisions = Array.isArray(trustedPlan?.operations) ? trustedPlan.operations : [];
  const decisionsById = new Map(decisions.map((decision) => [decision.subjectId, decision]));
  const credentials = captureRoleCredentials(
    plannedCredentialRoles(decisions),
    config?.roles,
    env,
  );
  const observations = [];
  const schemaRegistry = manifest?.schemas ?? Object.freeze(Object.create(null));
  const runtimeConfig = { ...config, __manifestSchemas: schemaRegistry };

  for (const operation of operations) {
    const decision = decisionsById.get(operation?.id);
    if (decision?.action !== 'execute') {
      observations.push(policySkip(operation, decision));
      continue;
    }

    for (const attempt of attemptsFor(operation, decision)) {
      observations.push(await executeAttempt({
        operation,
        decision,
        config: runtimeConfig,
        credentials,
        fetchImpl,
        ...attempt,
      }));
    }
  }

  return deepFreeze(observations);
}
