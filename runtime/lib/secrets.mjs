import { SentinelError } from './errors.mjs';

const SECRET_REF = /^env:([A-Z][A-Z0-9_]{1,127})$/;

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
  const value = env?.[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw secretError(
      'SECRET_UNAVAILABLE',
      `Secret reference ${name} is unavailable`,
      { ref: name },
    );
  }
  return value;
}

function replaceAllLiteral(text, search, replacement) {
  return text.split(search).join(replacement);
}

export function createRedactor(refs, env = process.env) {
  if (!Array.isArray(refs)) {
    throw secretError('SECRET_REFS_INVALID', 'Secret references must be an array');
  }

  const values = [...new Set(refs.map((ref) => resolveSecret(ref, env)))]
    .filter((value) => value.length >= 4)
    .sort((left, right) => right.length - left.length);
  const encodedValues = [...new Set(values.flatMap((value) => [
    Buffer.from(value).toString('base64'),
    Buffer.from(`:${value}`).toString('base64'),
  ]))].filter((value) => value.length >= 4);

  return (input) => {
    if (typeof input !== 'string') {
      throw secretError('REDACTION_INPUT_INVALID', 'Redaction input must be a string');
    }

    let redacted = input
      .replace(
        /((?:proxy-)?authorization["']?\s*:\s*["']?\s*bearer\s+)[^\s,;"'}]+/giu,
        '$1[REDACTED]',
      )
      .replace(
        /((?:proxy-)?authorization["']?\s*:\s*["']?\s*basic\s+)[^\s,;"'}]+/giu,
        '$1[REDACTED]',
      );
    for (const value of [...values, ...encodedValues]) {
      redacted = replaceAllLiteral(redacted, value, '[REDACTED]');
    }
    return redacted;
  };
}
