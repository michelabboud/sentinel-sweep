import { SentinelError } from './errors.mjs';

function originError(code, message) {
  return new SentinelError(code, message);
}

function parseUrl(text, code = 'ORIGIN_INVALID') {
  if (typeof text !== 'string' || text.length === 0 || text !== text.trim()) {
    throw originError(code, 'URL must be a non-empty string without surrounding whitespace');
  }
  try {
    return new URL(text);
  } catch {
    throw originError(code, 'URL is invalid');
  }
}

function requireHttp(url, code = 'ORIGIN_SCHEME') {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw originError(code, 'Only HTTP and HTTPS origins are allowed');
  }
}

function rejectUserInfo(url) {
  if (url.username !== '' || url.password !== '') {
    throw originError('ORIGIN_USERINFO', 'Origins must not contain credentials');
  }
}

function isLoopback(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1';
}

export function parseApprovedOrigin(text, policy = {}) {
  const url = parseUrl(text);
  requireHttp(url);
  rejectUserInfo(url);

  if (url.search !== '') {
    throw originError('ORIGIN_QUERY', 'Approved origins must not contain a query');
  }
  if (url.hash !== '') {
    throw originError('ORIGIN_FRAGMENT', 'Approved origins must not contain a fragment');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw originError('ORIGIN_BASE_PATH', 'Approved origins must not contain a base path');
  }
  if (!isLoopback(url.hostname) && policy.allowNonLoopback !== true) {
    throw originError(
      'ORIGIN_NON_LOOPBACK_BLOCKED',
      'Non-loopback origins require explicit approval',
    );
  }
  return url.origin;
}

export function resolveRequestUrl(origin, relativePath) {
  const base = parseUrl(origin);
  requireHttp(base);
  rejectUserInfo(base);
  if (base.origin !== origin && `${base.origin}/` !== origin) {
    throw originError('ORIGIN_INVALID', 'Request origin must be a normalized origin');
  }
  if (typeof relativePath !== 'string'
      || !relativePath.startsWith('/')
      || relativePath.startsWith('//')
      || relativePath.includes('\\')) {
    throw originError(
      relativePath?.startsWith('//') ? 'PATH_ABSOLUTE_URL' : 'PATH_RELATIVE_REQUIRED',
      'Request path must begin with exactly one slash',
    );
  }

  const resolved = new URL(relativePath, `${base.origin}/`);
  if (resolved.origin !== base.origin) {
    throw originError('PATH_ABSOLUTE_URL', 'Request path must remain on the approved origin');
  }
  return resolved.href;
}

export function validateRedirect(from, location, approvedOrigins) {
  const source = parseUrl(from, 'REDIRECT_SOURCE_INVALID');
  requireHttp(source, 'REDIRECT_SCHEME');
  rejectUserInfo(source);
  if (typeof location !== 'string' || location.length === 0 || location !== location.trim()) {
    throw originError('REDIRECT_LOCATION_INVALID', 'Redirect location is invalid');
  }

  let destination;
  try {
    destination = new URL(location, source);
  } catch {
    throw originError('REDIRECT_LOCATION_INVALID', 'Redirect location is invalid');
  }
  requireHttp(destination, 'REDIRECT_SCHEME');
  rejectUserInfo(destination);

  const candidates = approvedOrigins instanceof Set
    ? [...approvedOrigins]
    : approvedOrigins;
  if (!Array.isArray(candidates)) {
    throw originError('APPROVED_ORIGINS_INVALID', 'Approved origins must be an array or set');
  }
  const approved = new Set(candidates.map((candidate) => {
    const url = parseUrl(candidate);
    requireHttp(url);
    rejectUserInfo(url);
    return url.origin;
  }));

  if (!approved.has(destination.origin)) {
    throw originError('REDIRECT_ORIGIN_BLOCKED', 'Redirect origin is not approved');
  }
  return destination.href;
}
