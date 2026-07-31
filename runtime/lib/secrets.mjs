import { types as utilTypes } from 'node:util';

import { SentinelError } from './errors.mjs';

const SECRET_REF = /^env:([A-Z][A-Z0-9_]{1,127})$/;
const BEARER_TOKEN = /^[A-Za-z0-9._~+\/-]+=*$/u;
const TRUSTED_REDACTORS = new WeakSet();

function secretError(code, message, details = {}) {
  return new SentinelError(code, message, details);
}

export function parseSecretRef(ref) {
  if (typeof ref !== 'string') {
    throw secretError('SECRET_REF_INVALID', 'Secret reference must use the env scheme');
  }
  const match = SECRET_REF.exec(ref);
  if (!match) {
    throw secretError('SECRET_REF_INVALID', 'Secret reference must use the env scheme');
  }
  return { kind: 'env', name: match[1] };
}

export function resolveSecret(ref, env = process.env) {
  const { name } = parseSecretRef(ref);
  if (env === null
      || typeof env !== 'object'
      || Array.isArray(env)
      || utilTypes.isProxy(env)) {
    throw secretError('SECRET_ENV_INVALID', 'Secret environment must be an own-data record');
  }
  let descriptor;
  let inherited = false;
  try {
    descriptor = Object.getOwnPropertyDescriptor(env, name);
    let prototype = Object.getPrototypeOf(env);
    while (descriptor === undefined && prototype !== null) {
      if (utilTypes.isProxy(prototype)) {
        throw secretError('SECRET_ENV_INVALID', 'Secret environment prototype is untrusted');
      }
      if (Object.getOwnPropertyDescriptor(prototype, name) !== undefined) {
        inherited = true;
        break;
      }
      prototype = Object.getPrototypeOf(prototype);
    }
  } catch (error) {
    if (error?.code === 'SECRET_ENV_INVALID') throw error;
    throw secretError('SECRET_ENV_INVALID', 'Secret environment must be an own-data record');
  }
  if (inherited
      || (descriptor !== undefined
        && (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true))) {
    throw secretError('SECRET_ENV_INVALID', 'Secret must be an own enumerable data property');
  }
  if (descriptor === undefined) {
    throw secretError(
      'SECRET_UNAVAILABLE',
      `Secret reference ${name} is unavailable`,
      { ref: name },
    );
  }
  const value = descriptor.value;
  if (typeof value !== 'string' || value.length < 4 || !BEARER_TOKEN.test(value)) {
    throw secretError(
      'SECRET_INVALID',
      `Secret reference ${name} is present but is not a supported bearer token`,
      { ref: name },
    );
  }
  return value;
}

function ownEnumerableData(record, key) {
  if (record === null
      || typeof record !== 'object'
      || Array.isArray(record)
      || utilTypes.isProxy(record)) return { valid: false, found: false };
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) return { valid: true, found: false };
  if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
    return { valid: false, found: true };
  }
  return { valid: true, found: true, value: descriptor.value };
}

/** Captures every planned role token synchronously before a sweep can perform I/O. */
export function captureRoleCredentials(roleNames, roles, env = process.env) {
  if (!Array.isArray(roleNames)) {
    throw secretError('ROLE_CONFIG_INVALID', 'Planned role names must be an array');
  }
  const captured = new Map();
  for (const role of [...new Set(roleNames)]) {
    if (typeof role !== 'string' || role.length === 0 || role === 'unauthenticated') {
      throw secretError('ROLE_CONFIG_INVALID', 'Planned role name is invalid');
    }
    const configured = ownEnumerableData(roles, role);
    if (!configured.valid) {
      throw secretError('ROLE_CONFIG_INVALID', 'Role configuration must use own data records');
    }
    if (!configured.found) {
      captured.set(role, Object.freeze({ token: null, error: 'ROLE_CREDENTIAL_UNCONFIGURED' }));
      continue;
    }
    const tokenRef = ownEnumerableData(configured.value, 'tokenRef');
    if (!tokenRef.valid) {
      throw secretError('ROLE_CONFIG_INVALID', 'Role token reference must be own data');
    }
    if (!tokenRef.found || typeof tokenRef.value !== 'string') {
      captured.set(role, Object.freeze({ token: null, error: 'ROLE_CREDENTIAL_UNCONFIGURED' }));
      continue;
    }
    try {
      captured.set(role, Object.freeze({ token: resolveSecret(tokenRef.value, env), error: null }));
    } catch (error) {
      if (error?.code === 'SECRET_ENV_INVALID') throw error;
      captured.set(role, Object.freeze({
        token: null,
        error: error?.code === 'SECRET_INVALID'
          ? 'SECRET_UNAVAILABLE'
          : error?.code ?? 'SECRET_UNAVAILABLE',
      }));
    }
  }
  return captured;
}

function replaceAllLiteral(text, search, replacement) {
  return text.split(search).join(replacement);
}

function trustedRedactor(redact) {
  TRUSTED_REDACTORS.add(redact);
  return Object.freeze(redact);
}

/** The branded deterministic identity transform for runs with no configured secrets. */
export const identityRedactor = trustedRedactor((input) => {
  if (typeof input !== 'string') {
    throw secretError('REDACTION_INPUT_INVALID', 'Redaction input must be a string');
  }
  return input;
});

/** Returns true only for deterministic redactors constructed by this module. */
export function isTrustedRedactor(value) {
  return typeof value === 'function' && TRUSTED_REDACTORS.has(value);
}

function snapshotSecretRefs(refs) {
  if (!Array.isArray(refs)
      || utilTypes.isProxy(refs)
      || Object.getPrototypeOf(refs) !== Array.prototype) {
    throw secretError('SECRET_REFS_INVALID', 'Secret references must be an array');
  }
  const keys = Reflect.ownKeys(refs);
  if (keys.length !== refs.length + 1
      || !keys.includes('length')) {
    throw secretError('SECRET_REFS_INVALID', 'Secret references must be an own-data array');
  }
  const snapshot = [];
  for (let index = 0; index < refs.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(refs, String(index));
    if (descriptor === undefined
        || !Object.hasOwn(descriptor, 'value')
        || descriptor.enumerable !== true) {
      throw secretError('SECRET_REFS_INVALID', 'Secret references must be an own-data array');
    }
    snapshot.push(descriptor.value);
  }
  return snapshot;
}

function validateSecretInputs(refs, env) {
  const snapshot = snapshotSecretRefs(refs);
  if (env === null
      || typeof env !== 'object'
      || Array.isArray(env)
      || utilTypes.isProxy(env)) {
    throw secretError('SECRET_ENV_INVALID', 'Secret environment must be an own-data record');
  }
  return snapshot;
}

function escapeRegexLiteral(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function mixedPercentHexPattern(value) {
  let source = '';
  let hasPercentTriplet = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '%'
        && /^[0-9A-F]$/u.test(value[index + 1] ?? '')
        && /^[0-9A-F]$/u.test(value[index + 2] ?? '')) {
      hasPercentTriplet = true;
      source += '%';
      for (const nibble of [value[index + 1], value[index + 2]]) {
        source += /[A-F]/u.test(nibble) ? `[${nibble}${nibble.toLowerCase()}]` : nibble;
      }
      index += 2;
    } else {
      source += escapeRegexLiteral(value[index]);
    }
  }
  return hasPercentTriplet ? source : null;
}

function encodedSecretVariants(value) {
  const transport = [
    value,
    Buffer.from(value).toString('base64'),
    Buffer.from(value).toString('base64url'),
    Buffer.from(`:${value}`).toString('base64'),
    Buffer.from(`:${value}`).toString('base64url'),
  ];
  const literals = new Set(transport);
  const percentPatterns = new Set();
  for (const candidate of transport) {
    try {
      const encoded = encodeURIComponent(candidate);
      const formEncoded = encoded.replace(/%20/gu, '+');
      literals.add(encoded);
      literals.add(formEncoded);
      for (const variant of [encoded, formEncoded]) {
        const pattern = mixedPercentHexPattern(variant);
        if (pattern !== null) percentPatterns.add(pattern);
      }
    } catch {
      // Raw and binary transport forms remain available for malformed Unicode.
    }
  }
  return { literals: [...literals], percentPatterns: [...percentPatterns] };
}

function scrubAuthorization(input) {
  return input.replace(
    /((?:proxy-)?authorization["']?\s*:\s*["']?\s*bearer\s+)[^\r\n\s"'}]+/giu,
    '$1[REDACTED]',
  ).replace(
    /((?:proxy-)?authorization["']?\s*:\s*["']?\s*basic\s+)[^\r\n\s"'}]+/giu,
    '$1[REDACTED]',
  );
}

function redactorForValues(resolvedValues) {
  const values = [...new Set(resolvedValues)]
    .filter((value) => value.length >= 4);
  const encoded = values.map(encodedSecretVariants);
  const encodedValues = [...new Set(encoded.flatMap((entry) => entry.literals))]
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length);
  const percentPatterns = [...new Set(encoded.flatMap((entry) => entry.percentPatterns))]
    .sort((left, right) => right.length - left.length
      || (left < right ? -1 : left > right ? 1 : 0))
    .map((source) => new RegExp(source, 'gu'));

  return trustedRedactor((input) => {
    if (typeof input !== 'string') {
      throw secretError('REDACTION_INPUT_INVALID', 'Redaction input must be a string');
    }

    let redacted = scrubAuthorization(input);
    for (const value of encodedValues) {
      redacted = replaceAllLiteral(redacted, value, '[REDACTED]');
    }
    for (const pattern of percentPatterns) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return scrubAuthorization(redacted);
  });
}

export function createRedactor(refs, env = process.env) {
  const snapshot = validateSecretInputs(refs, env);
  return redactorForValues(snapshot.map((ref) => resolveSecret(ref, env)));
}

/** Builds a trusted redactor from the configured secrets that are currently available. */
export function createAvailableRedactor(refs, env = process.env) {
  const snapshot = validateSecretInputs(refs, env);
  const values = [];
  for (const ref of snapshot) {
    try {
      values.push(resolveSecret(ref, env));
    } catch (error) {
      if (error?.code !== 'SECRET_UNAVAILABLE') throw error;
    }
  }
  return redactorForValues(values);
}
