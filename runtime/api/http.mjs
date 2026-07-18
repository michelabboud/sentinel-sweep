import {
  parseApprovedOrigin,
  resolveRequestUrl,
  validateRedirect,
} from '../lib/origin.mjs';
import { checkJsonSchema } from './schema-check.mjs';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const INSPECTION_REASON_CODES = new Set([
  'BODY_INSPECTION_FAILED',
  'CONTENT_TYPE_MISMATCH',
  'JSON_RESPONSE_INVALID',
  'SCHEMA_NOT_FOUND',
  'SCHEMA_VIOLATION',
]);
const SCHEMA_VIOLATION_KEYWORDS = new Set([
  '$ref',
  'additionalProperties',
  'anyOf',
  'const',
  'enum',
  'maximum',
  'minimum',
  'minItems',
  'minLength',
  'oneOf',
  'parse',
  'pattern',
  'required',
  'type',
]);
const MAX_SCHEMA_VIOLATIONS = 100;
const MAX_SCHEMA_PATH_LENGTH = 1024;
const REDACTED_SCHEMA_PATH = '/[SCHEMA_PATH_REDACTED]';
const VALID_MEDIA_TYPE = 'valid';

function elapsedSince(startedAt) {
  return Math.max(0, performance.now() - startedAt);
}

function httpObservation(fields) {
  return Object.freeze({
    outcome: fields.outcome,
    reasonCode: fields.reasonCode,
    status: fields.status ?? null,
    durationMs: fields.durationMs,
    bytes: fields.bytes ?? null,
    redirects: fields.redirects,
    contentType: fields.contentType ?? null,
    inspection: fields.inspection ?? null,
  });
}

function failure(startedAt, redirects, outcome, reasonCode, fields = {}) {
  return httpObservation({
    outcome,
    reasonCode,
    status: fields.status ?? null,
    durationMs: elapsedSince(startedAt),
    bytes: fields.bytes ?? null,
    redirects,
    contentType: fields.contentType ?? null,
    inspection: null,
  });
}

function isJsonPointer(value) {
  return value.length <= MAX_SCHEMA_PATH_LENGTH
    && /^(?:\/(?:[^~\u0000-\u001f\u007f]|~[01])*)*$/u.test(value);
}

function normalizedSchemaViolations(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  const seen = new Set();
  let examined = 0;
  for (const violation of value) {
    if (examined >= MAX_SCHEMA_VIOLATIONS) break;
    examined += 1;
    if (violation === null
        || typeof violation !== 'object'
        || typeof violation.path !== 'string'
        || typeof violation.keyword !== 'string'
        || !isJsonPointer(violation.path)
        || !SCHEMA_VIOLATION_KEYWORDS.has(violation.keyword)) {
      continue;
    }
    const path = violation.path === '' ? '' : REDACTED_SCHEMA_PATH;
    const identity = `${path}\u0000${violation.keyword}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    normalized.push(Object.freeze({
      path,
      keyword: violation.keyword,
    }));
  }
  return normalized;
}

function normalizedInspection(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return Object.freeze({
      reasonCode: 'BODY_INSPECTION_FAILED',
      schemaViolations: Object.freeze([]),
    });
  }
  const reasonCode = value.reasonCode === null
    ? null
    : (INSPECTION_REASON_CODES.has(value.reasonCode)
      ? value.reasonCode
      : 'BODY_INSPECTION_FAILED');
  return Object.freeze({
    reasonCode,
    schemaViolations: Object.freeze(
      normalizedSchemaViolations(value.schemaViolations),
    ),
  });
}

function ownDataValue(record, key) {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return { found: false, value: undefined };
  if (!Object.hasOwn(descriptor, 'value')) return { found: true, value: undefined };
  return { found: true, value: descriptor.value };
}

/** Resolves only own data response definitions; inherited/accessor values are untrusted. */
export function responseDefinition(responses, status) {
  if (responses === null || typeof responses !== 'object' || Array.isArray(responses)) {
    return null;
  }
  const exact = ownDataValue(responses, String(status));
  if (exact.found) return exact.value ?? null;
  const statusClass = Math.floor(status / 100);
  for (const key of [`${statusClass}XX`, `${statusClass}xx`, 'default']) {
    const candidate = ownDataValue(responses, key);
    if (candidate.found) return candidate.value ?? null;
  }
  return null;
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

function registryRecord(registry, schemaId) {
  if (registry instanceof Map) {
    try {
      return Map.prototype.get.call(registry, schemaId);
    } catch {
      return undefined;
    }
  }
  if (registry === null || typeof registry !== 'object' || Array.isArray(registry)) {
    return undefined;
  }
  const record = ownDataValue(registry, schemaId);
  return record.found ? record.value : undefined;
}

function inspectResponse({ text, status, contentType, responses, schemaRegistry }) {
  const definition = responseDefinition(responses, status);
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    return bodyInspection();
  }

  const expectedMediaType = normalizedMediaType(definition.contentType);
  if (!isJsonMediaType(expectedMediaType)) return bodyInspection();
  if (normalizedMediaType(contentType) !== expectedMediaType) {
    return bodyInspection('CONTENT_TYPE_MISMATCH');
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return bodyInspection('JSON_RESPONSE_INVALID', [{ path: '', keyword: 'parse' }]);
  }

  if (definition.schemaId === null || definition.schemaId === undefined) {
    return bodyInspection();
  }

  const record = registryRecord(schemaRegistry, definition.schemaId);
  if (record === null || typeof record !== 'object' || Array.isArray(record)
      || record.schema === null || typeof record.schema !== 'object'
      || Array.isArray(record.schema)) {
    return bodyInspection('SCHEMA_NOT_FOUND', [{ path: '', keyword: '$ref' }]);
  }

  const violations = checkJsonSchema(value, record.schema, schemaRegistry);
  return violations.length === 0
    ? bodyInspection()
    : bodyInspection('SCHEMA_VIOLATION', violations);
}

function normalizedApprovedOrigins(approvedOrigins, allowNonLoopback) {
  if (!Array.isArray(approvedOrigins) && !(approvedOrigins instanceof Set)) return null;
  try {
    return new Set([...approvedOrigins].map((candidate) => (
      parseApprovedOrigin(candidate, { allowNonLoopback })
    )));
  } catch {
    return null;
  }
}

function requestHeaders(headers) {
  if (headers === undefined) return new Headers();
  try {
    return new Headers(headers);
  } catch {
    return null;
  }
}

async function readBounded(response, maxBytes) {
  if (response.body === null) return { exceeded: false, bytes: 0, text: '' };

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isSafeInteger(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel().catch(() => {});
    return { exceeded: true, bytes: declaredLength };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytes;
      if (value.byteLength > remaining) {
        bytes += value.byteLength;
        await reader.cancel().catch(() => {});
        return { exceeded: true, bytes };
      }
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }

  return {
    exceeded: false,
    bytes,
    text: Buffer.concat(chunks, bytes).toString('utf8'),
  };
}

function redirectedRequest(status, method, body, headers) {
  const switchToGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
  if (!switchToGet || method === 'HEAD') return { method, body, headers };

  const nextHeaders = new Headers(headers);
  nextHeaders.delete('content-length');
  nextHeaders.delete('content-type');
  return { method: 'GET', body: undefined, headers: nextHeaders };
}

function relativeTarget(value) {
  const url = value instanceof URL ? value : new URL(value);
  return `${url.pathname}${url.search}`;
}

/** Performs one approved, bounded HTTP request without automatic redirects. */
export async function requestApproved({
  origin,
  path,
  method,
  headers,
  body,
  timeoutMs,
  maxBytes,
  approvedOrigins,
  allowNonLoopback = false,
  bindPath = false,
  responses,
  schemaRegistry = {},
  inspectBody,
  fetchImpl = globalThis.fetch,
} = {}) {
  const startedAt = performance.now();
  let redirects = 0;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1
      || !Number.isInteger(maxBytes) || maxBytes < 1
      || typeof bindPath !== 'boolean'
      || inspectBody !== undefined
      || (responses !== undefined
        && (responses === null || typeof responses !== 'object' || Array.isArray(responses)))
      || (schemaRegistry === null
        || (typeof schemaRegistry !== 'object')
        || Array.isArray(schemaRegistry))
      || typeof fetchImpl !== 'function') {
    return failure(startedAt, redirects, 'blocked', 'REQUEST_INVALID');
  }

  let normalizedOrigin;
  let currentUrl;
  let targetPath;
  try {
    normalizedOrigin = parseApprovedOrigin(origin, { allowNonLoopback });
    const approved = normalizedApprovedOrigins(approvedOrigins, allowNonLoopback);
    if (approved === null || !approved.has(normalizedOrigin)) {
      return failure(startedAt, redirects, 'blocked', 'ORIGIN_NOT_APPROVED');
    }
    currentUrl = resolveRequestUrl(normalizedOrigin, path);
    targetPath = relativeTarget(currentUrl);
  } catch (error) {
    return failure(startedAt, redirects, 'blocked', error?.code ?? 'REQUEST_INVALID');
  }

  if (typeof method !== 'string' || !/^[A-Z]+$/u.test(method.toUpperCase())) {
    return failure(startedAt, redirects, 'blocked', 'METHOD_INVALID');
  }
  let currentMethod = method.toUpperCase();
  let currentBody = body;
  let currentHeaders = requestHeaders(headers);
  if (currentHeaders === null) {
    return failure(startedAt, redirects, 'blocked', 'HEADERS_INVALID');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    while (true) {
      let response;
      try {
        response = await fetchImpl(currentUrl, {
          method: currentMethod,
          headers: currentHeaders,
          body: currentMethod === 'GET' || currentMethod === 'HEAD' ? undefined : currentBody,
          redirect: 'manual',
          signal: controller.signal,
        });
      } catch {
        return failure(
          startedAt,
          redirects,
          controller.signal.aborted ? 'timeout' : 'network-error',
          controller.signal.aborted ? 'HTTP_TIMEOUT' : 'HTTP_NETWORK_ERROR',
        );
      }

      const rawContentType = response.headers.get('content-type');
      const evidenceContentType = normalizedMediaType(rawContentType) === null
        ? null
        : VALID_MEDIA_TYPE;
      if (REDIRECT_STATUSES.has(response.status) && response.headers.has('location')) {
        redirects += 1;
        await response.body?.cancel().catch(() => {});
        if (redirects > MAX_REDIRECTS) {
          return failure(
            startedAt,
            redirects,
            'blocked',
            'REDIRECT_LIMIT_EXCEEDED',
            { status: response.status, contentType: evidenceContentType },
          );
        }

        let destination;
        try {
          destination = validateRedirect(
            currentUrl,
            response.headers.get('location'),
            [normalizedOrigin],
          );
        } catch (error) {
          return failure(
            startedAt,
            redirects,
            'blocked',
            error?.code ?? 'REDIRECT_INVALID',
            { status: response.status, contentType: evidenceContentType },
          );
        }
        if (bindPath && relativeTarget(destination) !== targetPath) {
          return failure(
            startedAt,
            redirects,
            'blocked',
            'REDIRECT_TARGET_MISMATCH',
            { status: response.status, contentType: evidenceContentType },
          );
        }

        const nextRequest = redirectedRequest(
          response.status,
          currentMethod,
          currentBody,
          currentHeaders,
        );
        if (bindPath && nextRequest.method !== currentMethod) {
          return failure(
            startedAt,
            redirects,
            'blocked',
            'REDIRECT_METHOD_MISMATCH',
            { status: response.status, contentType: evidenceContentType },
          );
        }

        ({
          method: currentMethod,
          body: currentBody,
          headers: currentHeaders,
        } = nextRequest);
        currentUrl = destination;
        continue;
      }

      let bounded;
      try {
        bounded = await readBounded(response, maxBytes);
      } catch {
        return failure(
          startedAt,
          redirects,
          controller.signal.aborted ? 'timeout' : 'network-error',
          controller.signal.aborted ? 'HTTP_TIMEOUT' : 'HTTP_NETWORK_ERROR',
          { status: response.status, contentType: evidenceContentType },
        );
      }

      if (bounded.exceeded) {
        return failure(
          startedAt,
          redirects,
          'oversized',
          'RESPONSE_TOO_LARGE',
          { status: response.status, bytes: bounded.bytes, contentType: evidenceContentType },
        );
      }

      let inspection = null;
      if (responses !== undefined) {
        try {
          inspection = normalizedInspection(inspectResponse({
            text: bounded.text,
            status: response.status,
            contentType: rawContentType,
            responses,
            schemaRegistry,
          }));
        } catch {
          inspection = normalizedInspection(null);
        }
        if (controller.signal.aborted) {
          return failure(startedAt, redirects, 'timeout', 'HTTP_TIMEOUT', {
            status: response.status,
            bytes: bounded.bytes,
            contentType: evidenceContentType,
          });
        }
      }

      return httpObservation({
        outcome: 'response',
        reasonCode: 'HTTP_RESPONSE',
        status: response.status,
        durationMs: elapsedSince(startedAt),
        bytes: bounded.bytes,
        redirects,
        contentType: evidenceContentType,
        inspection,
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}
