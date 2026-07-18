import { requestApproved } from './http.mjs';
import { checkJsonSchema } from './schema-check.mjs';
import { resolveSecret } from '../lib/secrets.mjs';

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
    path: typeof operation?.path === 'string' ? operation.path : '/',
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

function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function materializeRequest(operation, parameterValues) {
  let path = operation.path;
  const headers = {};
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(parameterValues ?? {})) {
    const separator = key.indexOf(':');
    if (separator < 1) continue;
    const location = key.slice(0, separator);
    const name = key.slice(separator + 1);
    if (location === 'path') {
      path = path.split(`{${name}}`).join(encodeURIComponent(scalar(value)));
    } else if (location === 'query') {
      query.append(name, scalar(value));
    } else if (location === 'header' && !RESERVED_AUTH_HEADERS.has(name.toLowerCase())) {
      headers[name] = scalar(value);
    }
  }

  const suffix = query.toString();
  if (suffix.length > 0) path += `${path.includes('?') ? '&' : '?'}${suffix}`;
  return { path, headers };
}

function configuredRoles(config) {
  if (config?.roles === null || typeof config?.roles !== 'object'
      || Array.isArray(config.roles)) return [];
  return Object.keys(config.roles).sort();
}

function attemptsFor(operation, config) {
  if (operation?.auth?.state === 'public') return [{ role: null, accessExpected: true }];
  const allowed = new Set(
    (Array.isArray(operation?.auth?.allowedRoles) ? operation.auth.allowedRoles : [])
      .filter((role) => typeof role === 'string' && role !== 'unauthenticated'),
  );
  const roles = [...new Set([...allowed, ...configuredRoles(config)])].sort();
  return [
    { role: null, accessExpected: false },
    ...roles.map((role) => ({ role, accessExpected: allowed.has(role) })),
  ];
}

function responseDefinition(operation, status) {
  const responses = operation?.responses;
  if (responses === null || typeof responses !== 'object' || Array.isArray(responses)) return null;
  const exact = responses[String(status)];
  if (exact !== undefined) return exact;
  const wildcard = responses[`${Math.floor(status / 100)}XX`]
    ?? responses[`${Math.floor(status / 100)}xx`];
  return wildcard ?? responses.default ?? null;
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

function isJsonMediaType(mediaType) {
  return mediaType === 'application/json'
    || (typeof mediaType === 'string'
      && mediaType.startsWith('application/')
      && mediaType.endsWith('+json'));
}

function bodyInspection(reasonCode = null, schemaViolations = []) {
  return { reasonCode, schemaViolations };
}

function responseBodyInspector(operation, registry) {
  return ({ text, status, contentType }) => {
    const definition = responseDefinition(operation, status);
    if (definition === null) return bodyInspection();

    const expectedMediaType = normalizedMediaType(definition.contentType);
    if (!isJsonMediaType(expectedMediaType)) return bodyInspection();
    if (normalizedMediaType(contentType) !== expectedMediaType) {
      return bodyInspection('CONTENT_TYPE_MISMATCH');
    }

    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return bodyInspection(
        'JSON_RESPONSE_INVALID',
        [{ path: '', keyword: 'parse' }],
      );
    }

    if (definition.schemaId === null || definition.schemaId === undefined) {
      return bodyInspection();
    }

    const record = registry?.[definition.schemaId];
    if (record === null || typeof record !== 'object' || Array.isArray(record)
        || record.schema === null || typeof record.schema !== 'object') {
      return bodyInspection('SCHEMA_NOT_FOUND', [{ path: '', keyword: '$ref' }]);
    }

    const violations = checkJsonSchema(value, record.schema, registry);
    return violations.length === 0
      ? bodyInspection()
      : bodyInspection('SCHEMA_VIOLATION', violations);
  };
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
    fields.actual = normalizedMediaType(result.contentType) ?? 'missing or invalid content type';
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

function secretFailure(operation, role, error) {
  return observation(operation, {
    category: 'security',
    severity: 'error',
    outcome: 'fail',
    role,
    reasonCode: error?.code ?? 'SECRET_UNAVAILABLE',
    message: `Credential for role ${role} was unavailable`,
    expected: 'available environment secret reference',
    actual: error?.code ?? 'SECRET_UNAVAILABLE',
  });
}

function roleCredentialUnconfigured(operation, role) {
  return observation(operation, {
    category: 'security',
    severity: 'error',
    outcome: 'fail',
    role,
    reasonCode: 'ROLE_CREDENTIAL_UNCONFIGURED',
    message: `Credential mapping for allowed role ${role} is not configured`,
    expected: 'trusted role token reference',
    actual: 'role credential mapping unavailable',
  });
}

async function executeAttempt({ operation, decision, config, env, fetchImpl, role, accessExpected }) {
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
    });
  }

  const request = materializeRequest(operation, decision.parameterValues);
  if (role !== null) {
    const roleConfig = config?.roles?.[role];
    if (roleConfig === null || typeof roleConfig !== 'object'
        || typeof roleConfig.tokenRef !== 'string') {
      return roleCredentialUnconfigured(operation, role);
    }
    try {
      request.headers.authorization = `Bearer ${resolveSecret(roleConfig.tokenRef, env)}`;
    } catch (error) {
      return secretFailure(operation, role, error);
    }
  }

  let result;
  try {
    result = await requestApproved({
      origin,
      path: request.path,
      method: operation.method,
      headers: request.headers,
      body: undefined,
      timeoutMs: config?.responseTimeoutMs,
      maxBytes: config?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      approvedOrigins: config?.approvedOrigins,
      allowNonLoopback: config?.allowNonLoopback === true,
      inspectBody: responseBodyInspector(operation, config.__manifestSchemas),
      fetchImpl,
    });
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
    });
  }

  if (result.outcome !== 'response') return transportFailure(operation, role, result);
  if (!accessExpected) return denialObservation(operation, role, result);
  if (DENIAL_STATUSES.has(result.status)) return accessDeniedObservation(operation, role, result);

  const definition = responseDefinition(operation, result.status);
  if (definition === null) return statusObservation(operation, role, result);
  return inspectionObservation(operation, role, result, definition)
    ?? accessPassObservation(operation, role, result);
}

/** Executes the immutable policy ledger and returns secret-free API observations. */
export async function sweepApi({ manifest, plan, config, env = process.env, fetchImpl } = {}) {
  const operations = Array.isArray(manifest?.operations) ? manifest.operations : [];
  const decisions = Array.isArray(plan?.operations) ? plan.operations : [];
  const decisionsById = new Map(decisions.map((decision) => [decision.subjectId, decision]));
  const observations = [];
  const runtimeConfig = { ...config, __manifestSchemas: manifest?.schemas ?? {} };

  for (const operation of operations) {
    const decision = decisionsById.get(operation?.id);
    if (decision?.action !== 'execute') {
      observations.push(policySkip(operation, decision));
      continue;
    }

    for (const attempt of attemptsFor(operation, config)) {
      observations.push(await executeAttempt({
        operation,
        decision,
        config: runtimeConfig,
        env,
        fetchImpl,
        ...attempt,
      }));
    }
  }

  return deepFreeze(observations);
}
