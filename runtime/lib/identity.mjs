import { createHash } from 'node:crypto';

import { SentinelError } from './errors.mjs';

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableJson(value[key])}`,
    ).join(',')}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new SentinelError('IDENTITY_FIELDS_INVALID', 'Identity fields must be JSON values');
  }
  return serialized;
}

function digest(domain, value) {
  return createHash('sha256').update(domain).update('\0').update(value).digest('hex');
}

function normalizeRoute(pathValue) {
  if (typeof pathValue !== 'string' || pathValue.length === 0) {
    throw new SentinelError('IDENTITY_PATH_INVALID', 'Identity path must be a non-empty string');
  }
  let normalized = pathValue.split(/[?#]/u, 1)[0].replace(/\/{2,}/gu, '/');
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  normalized = normalized
    .replace(/\{[^/{}]+\}/gu, '{param}')
    .replace(/:([A-Za-z_][A-Za-z0-9_-]*)/gu, '{param}');
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/u, '');
  return normalized;
}

export function routeId(pathValue) {
  return digest('route', normalizeRoute(pathValue));
}

export function operationId(method, pathValue) {
  if (typeof method !== 'string' || method.trim().length === 0) {
    throw new SentinelError('IDENTITY_METHOD_INVALID', 'HTTP method must be a non-empty string');
  }
  return digest('operation', `${method.trim().toUpperCase()}\0${normalizeRoute(pathValue)}`);
}

export function findingId(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new SentinelError('IDENTITY_FIELDS_INVALID', 'Finding fields must be an object');
  }
  return digest('finding', stableJson(fields));
}
