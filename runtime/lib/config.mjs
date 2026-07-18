import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { SentinelError } from './errors.mjs';
import { loadBundledSchema, validateAgainstSchema } from './schema.mjs';

const READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);

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

async function readTrustedJson(filePath, targetRoot, label) {
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
    if (!(await handle.stat()).isFile()) {
      throw configError(`${label}_NOT_FILE`, `${label} path must be a regular file`);
    }
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
  const settings = await readTrustedJson(configPath, target, 'CONFIG');
  const defaults = await readTrustedJson(defaultsPath, target, 'DEFAULTS');
  const merged = mergeSettings(defaults, settings);
  const schema = await loadBundledSchema('settings');
  validateAgainstSchema(merged, schema, { name: 'trusted config' });
  return merged;
}
