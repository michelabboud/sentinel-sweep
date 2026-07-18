import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SentinelError } from './errors.mjs';
import { loadBundledSchema, validateAgainstSchema } from './schema.mjs';

const READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);
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

export function validateTrustedFileStat(stat, {
  label,
  requirePrivateMode,
  platform = process.platform,
  effectiveUid = effectiveUserId(platform),
} = {}) {
  if (label !== 'CONFIG' && label !== 'DEFAULTS') {
    throw configError('CONFIG_INVALID', 'Trusted file stat policy label is invalid');
  }
  if (stat === null || typeof stat !== 'object' || typeof stat.isFile !== 'function') {
    throw configError(`${label}_NOT_FILE`, `${label} path must be a regular file`);
  }
  if (!stat.isFile()) {
    throw configError(`${label}_NOT_FILE`, `${label} path must be a regular file`);
  }

  if (!requirePrivateMode || platform === 'win32') return;
  if (!Number.isInteger(effectiveUid) || stat.uid !== effectiveUid) {
    throw configError(
      'CONFIG_OWNER_INVALID',
      'CONFIG file must be owned by the effective user',
    );
  }
  const permissions = stat.mode & 0o7777;
  if (permissions !== 0o600 && permissions !== 0o400) {
    throw configError(
      'CONFIG_MODE_INSECURE',
      'CONFIG file permissions must be exactly 0600 or 0400',
    );
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
    stat = await lstat(resolved);
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

  let handle;
  try {
    handle = await open(resolved, READ_FLAGS);
    const descriptorStat = await handle.stat();
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
  const merged = mergeSettings(defaults, settings);
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
