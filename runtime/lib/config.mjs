import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types as utilTypes } from 'node:util';

import { SentinelError } from './errors.mjs';
import { loadBundledSchema, validateAgainstSchema } from './schema.mjs';

const READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0);
const BUNDLED_DEFAULTS_PATH = fileURLToPath(new URL('../../settings.json', import.meta.url));

function configError(code, message, details = {}) {
  return new SentinelError(code, message, details);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`));
}

async function canonicalTargetRoot(targetRoot) {
  const resolved = path.resolve(targetRoot);
  let stat;
  try {
    stat = await lstat(resolved);
  } catch {
    throw configError('TARGET_ROOT_INVALID', 'Target root is not accessible');
  }
  if (stat.isSymbolicLink()) {
    throw configError('TARGET_ROOT_SYMLINK', 'Target root must not be a symbolic link');
  }
  if (!stat.isDirectory()) {
    throw configError('TARGET_ROOT_INVALID', 'Target root must be a directory');
  }
  return realpath(resolved);
}

function effectiveUserId(platform) {
  if (platform === 'win32') return null;
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

function sameInteger(left, right) {
  const normalize = (value) => {
    if (typeof value === 'bigint') return value;
    if (Number.isSafeInteger(value)) return BigInt(value);
    return null;
  };
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return normalizedLeft !== null
    && normalizedRight !== null
    && normalizedLeft === normalizedRight;
}

function exactPermissions(mode) {
  if (typeof mode === 'bigint') return mode & 0o7777n;
  if (Number.isSafeInteger(mode)) return mode & 0o7777;
  return null;
}

function validateRegularFileStat(stat, label) {
  if (stat === null || typeof stat !== 'object' || typeof stat.isFile !== 'function') {
    throw configError(`${label}_NOT_FILE`, `${label} path must be a regular file`);
  }
  if (!stat.isFile()) {
    throw configError(`${label}_NOT_FILE`, `${label} path must be a regular file`);
  }
}

export function validateTrustedFileStat(stat, {
  label,
  requirePrivateMode,
  platform = process.platform,
  effectiveUid = effectiveUserId(platform),
} = {}) {
  if (label !== 'CONFIG' && label !== 'DEFAULTS') {
    throw configError('CONFIG_INVALID', 'Trusted file stat policy label is invalid');
  }
  validateRegularFileStat(stat, label);

  if (requirePrivateMode && platform !== 'win32') {
    if (!sameInteger(stat.uid, effectiveUid)) {
      throw configError(
        'CONFIG_OWNER_INVALID',
        'CONFIG file must be owned by the effective user',
      );
    }
    const permissions = exactPermissions(stat.mode);
    if ((typeof permissions === 'bigint'
      && permissions !== 0o600n
      && permissions !== 0o400n)
      || (typeof permissions === 'number'
        && permissions !== 0o600
        && permissions !== 0o400)
      || permissions === null) {
      throw configError(
        'CONFIG_MODE_INSECURE',
        'CONFIG file permissions must be exactly 0600 or 0400',
      );
    }
  }
  if (label === 'CONFIG' && !sameInteger(stat.nlink, 1)) {
    throw configError(
      'CONFIG_LINK_COUNT_INVALID',
      'CONFIG file must have exactly one hard link',
    );
  }
}

function fileIdentity(stat) {
  // Node exposes the platform file ID through dev/ino; a missing or zero ID fails closed.
  const integer = (value) => {
    if (typeof value === 'bigint' && value >= 0n) return value;
    if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
    return null;
  };
  const dev = integer(stat?.dev);
  const ino = integer(stat?.ino);
  if (dev === null || ino === null || ino === 0n) return null;
  return { dev, ino };
}

export function validateOpenedFileIdentity(expectedStat, descriptorStat, {
  label,
  platform = process.platform,
} = {}) {
  if (label !== 'CONFIG' && label !== 'DEFAULTS') {
    throw configError('CONFIG_INVALID', 'Trusted file identity label is invalid');
  }
  const expected = fileIdentity(expectedStat);
  const opened = fileIdentity(descriptorStat);
  if (expected === null
      || opened === null
      || expected.dev !== opened.dev
      || expected.ino !== opened.ino) {
    const platformMessage = platform === 'win32'
      ? 'available Windows file identity changed or is unavailable'
      : 'device and inode identity changed';
    throw configError(
      `${label}_FILE_CHANGED`,
      `${label} ${platformMessage} between path validation and descriptor open`,
    );
  }
}

export async function readVerifiedJsonFile({
  filePath,
  expectedStat,
  label,
  requirePrivateMode,
}) {
  let handle;
  try {
    handle = await open(filePath, READ_FLAGS);
    const descriptorStat = await handle.stat({ bigint: true });
    validateRegularFileStat(descriptorStat, label);
    validateOpenedFileIdentity(expectedStat, descriptorStat, { label });
    validateTrustedFileStat(descriptorStat, { label, requirePrivateMode });
    const text = await handle.readFile('utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    if (error?.code === 'ELOOP') {
      throw configError(`${label}_SYMLINK`, `${label} file must not be a symbolic link`);
    }
    if (error instanceof SyntaxError) {
      throw configError(`${label}_PARSE_FAILED`, `${label} file must contain valid JSON`);
    }
    throw configError(`${label}_READ_FAILED`, `${label} file could not be read`);
  } finally {
    await handle?.close();
  }
}

async function readTrustedJson(filePath, targetRoot, label, { requirePrivateMode }) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw configError(`${label}_PATH_REQUIRED`, `${label} path is required`);
  }

  const resolved = path.resolve(filePath);
  if (isWithin(targetRoot.lexical, resolved)) {
    throw configError(
      label === 'CONFIG' ? 'CONFIG_UNTRUSTED_LOCATION' : 'DEFAULTS_UNTRUSTED_LOCATION',
      `${label} must be outside the target root`,
    );
  }

  let stat;
  try {
    stat = await lstat(resolved, { bigint: true });
  } catch {
    throw configError(`${label}_UNAVAILABLE`, `${label} file is not available`);
  }
  if (stat.isSymbolicLink()) {
    throw configError(`${label}_SYMLINK`, `${label} file must not be a symbolic link`);
  }
  if (!stat.isFile()) {
    throw configError(`${label}_NOT_FILE`, `${label} path must be a regular file`);
  }

  const canonical = await realpath(resolved).catch(() => {
    throw configError(`${label}_UNAVAILABLE`, `${label} file could not be canonicalized`);
  });
  if (isWithin(targetRoot.canonical, canonical)) {
    throw configError(
      label === 'CONFIG' ? 'CONFIG_UNTRUSTED_LOCATION' : 'DEFAULTS_UNTRUSTED_LOCATION',
      `${label} must be outside the target root`,
    );
  }

  return readVerifiedJsonFile({
    filePath: resolved,
    expectedStat: stat,
    label,
    requirePrivateMode,
  });
}

function invalidConfigShape() {
  throw configError(
    'CONFIG_INVALID',
    'Trusted config must contain only recursively plain own-data JSON values',
  );
}

function canonicalizeJsonValue(value, ancestors) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidConfigShape();
    return value;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) {
    invalidConfigShape();
  }
  if (ancestors.has(value)) invalidConfigShape();
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalidConfigShape();
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes('length')) invalidConfigShape();
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined
            || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
            || descriptor.enumerable !== true) {
          invalidConfigShape();
        }
        result.push(canonicalizeJsonValue(descriptor.value, ancestors));
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidConfigShape();
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') invalidConfigShape();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined
          || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
          || descriptor.enumerable !== true) {
        invalidConfigShape();
      }
      Object.defineProperty(result, key, {
        value: canonicalizeJsonValue(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeTrustedConfig(value) {
  const canonical = canonicalizeJsonValue(value, new Set());
  if (canonical === null || typeof canonical !== 'object' || Array.isArray(canonical)) {
    invalidConfigShape();
  }
  return canonical;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeSettings(defaults, settings) {
  if (!isPlainObject(defaults) || !isPlainObject(settings)) {
    throw configError('CONFIG_INVALID', 'Defaults and trusted config must be JSON objects');
  }
  const keys = new Set([...Object.keys(defaults), ...Object.keys(settings)]);
  return Object.fromEntries([...keys].map((key) => {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) {
      return [key, defaults[key]];
    }
    if (isPlainObject(defaults[key]) && isPlainObject(settings[key])) {
      return [key, mergeSettings(defaults[key], settings[key])];
    }
    return [key, settings[key]];
  }));
}

export async function loadTrustedConfig({ configPath, targetRoot, defaultsPath }) {
  if (typeof targetRoot !== 'string' || targetRoot.length === 0) {
    throw configError('TARGET_ROOT_INVALID', 'Target root is required');
  }
  const target = {
    lexical: path.resolve(targetRoot),
    canonical: await canonicalTargetRoot(targetRoot),
  };
  const settings = await readTrustedJson(configPath, target, 'CONFIG', {
    requirePrivateMode: true,
  });
  const selectedDefaultsPath = defaultsPath ?? BUNDLED_DEFAULTS_PATH;
  if (typeof selectedDefaultsPath !== 'string'
      || path.resolve(selectedDefaultsPath) !== BUNDLED_DEFAULTS_PATH) {
    throw configError(
      'DEFAULTS_PATH_INVALID',
      'Bundled defaults must be loaded from the fixed package path',
    );
  }
  const defaults = await readTrustedJson(BUNDLED_DEFAULTS_PATH, target, 'DEFAULTS', {
    requirePrivateMode: false,
  });
  const merged = canonicalizeTrustedConfig(mergeSettings(defaults, settings));
  const schema = await loadBundledSchema('settings');
  validateAgainstSchema(merged, schema, { name: 'trusted config' });
  if (merged.browserSettleMs >= merged.responseTimeoutMs) {
    throw configError(
      'CONFIG_BROWSER_SETTLE_INVALID',
      'Browser settle time must be shorter than the response timeout',
    );
  }
  return merged;
}
