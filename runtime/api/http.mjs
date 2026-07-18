import {
  parseApprovedOrigin,
  resolveRequestUrl,
  validateRedirect,
} from '../lib/origin.mjs';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const INSPECTION_REASON_CODES = new Set([
  'BODY_INSPECTION_FAILED',
  'CONTENT_TYPE_MISMATCH',
  'JSON_RESPONSE_INVALID',
  'SCHEMA_NOT_FOUND',
  'SCHEMA_VIOLATION',
]);

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

function normalizedSchemaViolations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((violation) => (
      violation !== null
      && typeof violation === 'object'
      && typeof violation.path === 'string'
      && typeof violation.keyword === 'string'
    ))
    .map(({ path, keyword }) => Object.freeze({ path, keyword }));
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
    schemaViolations: Object.freeze(normalizedSchemaViolations(value.schemaViolations)),
  });
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
  inspectBody,
  fetchImpl = globalThis.fetch,
} = {}) {
  const startedAt = performance.now();
  let redirects = 0;

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1
      || !Number.isInteger(maxBytes) || maxBytes < 1
      || (inspectBody !== undefined && typeof inspectBody !== 'function')
      || typeof fetchImpl !== 'function') {
    return failure(startedAt, redirects, 'blocked', 'REQUEST_INVALID');
  }

  let normalizedOrigin;
  let currentUrl;
  try {
    normalizedOrigin = parseApprovedOrigin(origin, { allowNonLoopback });
    const approved = normalizedApprovedOrigins(approvedOrigins, allowNonLoopback);
    if (approved === null || !approved.has(normalizedOrigin)) {
      return failure(startedAt, redirects, 'blocked', 'ORIGIN_NOT_APPROVED');
    }
    currentUrl = resolveRequestUrl(normalizedOrigin, path);
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

      const contentType = response.headers.get('content-type');
      if (REDIRECT_STATUSES.has(response.status) && response.headers.has('location')) {
        redirects += 1;
        await response.body?.cancel().catch(() => {});
        if (redirects > MAX_REDIRECTS) {
          return failure(
            startedAt,
            redirects,
            'blocked',
            'REDIRECT_LIMIT_EXCEEDED',
            { status: response.status, contentType },
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
            { status: response.status, contentType },
          );
        }

        ({
          method: currentMethod,
          body: currentBody,
          headers: currentHeaders,
        } = redirectedRequest(response.status, currentMethod, currentBody, currentHeaders));
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
          { status: response.status, contentType },
        );
      }

      if (bounded.exceeded) {
        return failure(
          startedAt,
          redirects,
          'oversized',
          'RESPONSE_TOO_LARGE',
          { status: response.status, bytes: bounded.bytes, contentType },
        );
      }

      let inspection = null;
      if (inspectBody !== undefined) {
        try {
          inspection = normalizedInspection(await inspectBody({
            text: bounded.text,
            status: response.status,
            contentType,
          }));
        } catch {
          inspection = normalizedInspection(null);
        }
        if (controller.signal.aborted) {
          return failure(startedAt, redirects, 'timeout', 'HTTP_TIMEOUT', {
            status: response.status,
            bytes: bounded.bytes,
            contentType,
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
        contentType,
        inspection,
      });
    }
  } finally {
    clearTimeout(timeout);
  }
}
