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

const FILE_IDENTITY_FIELDS = [
  'dev',
  'ino',
  'birthtimeNs',
  'ctimeNs',
  'size',
  'mtimeNs',
];
const PATH_IDENTITY_FIELDS = ['dev', 'ino', 'birthtimeNs', 'ctimeNs'];
const PATH_STABLE_IDENTITY_FIELDS = ['dev', 'ino', 'birthtimeNs'];
const FIXED_POSIX_TEMP_ROOT = '/tmp';

function statInteger(value) {
  if (typeof value === 'bigint') return value;
  if (Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function statIdentity(stat, fields) {
  const identity = Object.create(null);
  for (const field of fields) {
    const value = statInteger(stat?.[field]);
    if (value === null) return null;
    identity[field] = value;
  }
  if (identity.dev < 0n
      || identity.ino <= 0n
      || (Object.prototype.hasOwnProperty.call(identity, 'size') && identity.size < 0n)) {
    return null;
  }
  for (const field of ['birthtimeNs', 'ctimeNs', 'mtimeNs']) {
    if (Object.prototype.hasOwnProperty.call(identity, field) && identity[field] === 0n) {
      return null;
    }
  }
  return identity;
}

function fileIdentity(stat) {
  // Reading may update atime, so bind all stable file metadata except atime.
  return statIdentity(stat, FILE_IDENTITY_FIELDS);
}

function pathIdentity(stat, bindChangeTime) {
  return statIdentity(
    stat,
    bindChangeTime ? PATH_IDENTITY_FIELDS : PATH_STABLE_IDENTITY_FIELDS,
  );
}

function identitiesMatch(left, right, fields) {
  return left !== null
    && right !== null
    && fields.every((field) => left[field] === right[field]);
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
  if (!identitiesMatch(expected, opened, FILE_IDENTITY_FIELDS)) {
    const platformMessage = platform === 'win32'
      ? 'available Windows file identity changed or is unavailable'
      : 'trusted file identity metadata changed';
    throw configError(
      `${label}_FILE_CHANGED`,
      `${label} ${platformMessage} during verified read`,
    );
  }
}

function trustedLocationCode(label) {
  return label === 'CONFIG' ? 'CONFIG_UNTRUSTED_LOCATION' : 'DEFAULTS_UNTRUSTED_LOCATION';
}

function validateTrustedLocationBoundary(targetRoot) {
  if (targetRoot === null
      || typeof targetRoot !== 'object'
      || typeof targetRoot.lexical !== 'string'
      || typeof targetRoot.canonical !== 'string') {
    throw configError('CONFIG_INVALID', 'Trusted file target boundary is invalid');
  }
  return {
    lexical: path.resolve(targetRoot.lexical),
    canonical: path.resolve(targetRoot.canonical),
  };
}

async function inspectCurrentTrustedPath({ filePath, targetRoot, label }) {
  const boundary = validateTrustedLocationBoundary(targetRoot);
  const resolved = path.resolve(filePath);
  if (isWithin(boundary.lexical, resolved)) {
    throw configError(
      trustedLocationCode(label),
      `${label} must be outside the target root`,
    );
  }

  let stat;
  try {
    stat = await lstat(resolved, { bigint: true });
  } catch {
    throw configError(`${label}_FILE_CHANGED`, `${label} path changed during verified read`);
  }
  if (stat.isSymbolicLink()) {
    throw configError(`${label}_SYMLINK`, `${label} file must not be a symbolic link`);
  }
  validateRegularFileStat(stat, label);

  let canonical;
  try {
    canonical = await realpath(resolved);
  } catch {
    throw configError(`${label}_FILE_CHANGED`, `${label} path changed during verified read`);
  }
  if (isWithin(boundary.canonical, canonical)) {
    throw configError(
      trustedLocationCode(label),
      `${label} must be outside the target root`,
    );
  }
  return { resolved, canonical, stat };
}

function comparablePathComponent(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function commonPathAncestor(leftPath, rightPath) {
  const left = path.resolve(leftPath);
  const right = path.resolve(rightPath);
  const leftRoot = path.parse(left).root;
  const rightRoot = path.parse(right).root;
  if (comparablePathComponent(leftRoot) !== comparablePathComponent(rightRoot)) return null;

  const leftParts = left.slice(leftRoot.length).split(path.sep).filter(Boolean);
  const rightParts = right.slice(rightRoot.length).split(path.sep).filter(Boolean);
  let common = leftRoot;
  const count = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < count; index += 1) {
    if (comparablePathComponent(leftParts[index])
        !== comparablePathComponent(rightParts[index])) {
      break;
    }
    common = path.join(common, leftParts[index]);
  }
  return common;
}

function configBranchAncestors(filePath, targetPath) {
  const parentPath = path.dirname(path.resolve(filePath));
  const root = path.parse(parentPath).root;
  const common = commonPathAncestor(parentPath, targetPath) ?? root;
  const relative = path.relative(common, parentPath);
  if (relative === '') return [];

  const ancestors = [];
  let current = common;
  const components = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    current = path.join(current, component);
    ancestors.push(current);
  }
  return ancestors;
}

async function fixedPosixTempCandidates() {
  if (process.platform === 'win32'
      || typeof process.geteuid !== 'function'
      || process.geteuid() === 0) {
    return new Set();
  }
  const lexical = path.resolve(FIXED_POSIX_TEMP_ROOT);
  const candidates = new Set([lexical]);
  try {
    candidates.add(path.resolve(await realpath(lexical)));
  } catch {
    // The lexical candidate still has to pass the exact stat checks below.
  }
  return candidates;
}

async function isVerifiedFixedPosixTempRoot(candidate, stat, fixedCandidates) {
  const resolved = path.resolve(candidate);
  if (!fixedCandidates.has(resolved) || !stat.isDirectory()) return false;
  const uid = statInteger(stat.uid);
  const mode = statInteger(stat.mode);
  if (uid !== 0n || mode === null || (mode & 0o1000n) === 0n) return false;

  const parent = path.dirname(resolved);
  if (parent === resolved) return false;
  let parentStat;
  try {
    parentStat = await lstat(parent, { bigint: true });
  } catch {
    return false;
  }
  const parentUid = statInteger(parentStat.uid);
  const parentMode = statInteger(parentStat.mode);
  return parentStat.isDirectory()
    && parentUid === 0n
    && parentMode !== null
    && (parentMode & 0o022n) === 0n;
}

async function captureAncestorBindings(resolved, canonical, targetRoot, label) {
  const boundary = validateTrustedLocationBoundary(targetRoot);
  // Bind only each config-side branch. The shared common ancestor (for example
  // /tmp) is excluded so unrelated sibling churn cannot invalidate the read.
  const requestedBindings = new Set([
    ...configBranchAncestors(resolved, boundary.lexical),
    ...configBranchAncestors(canonical, boundary.canonical),
  ]);
  const fixedTempCandidates = await fixedPosixTempCandidates();
  const bindings = [];
  for (const ancestorPath of requestedBindings) {
    let stat;
    try {
      stat = await lstat(ancestorPath, { bigint: true });
    } catch {
      throw configError(
        `${label}_FILE_CHANGED`,
        `${label} ancestor path changed during verified read`,
      );
    }
    // Only the platform-fixed /tmp (or its canonical directory) may omit ctime,
    // and only after filesystem ownership/mode/anchoring proves it is not
    // user-relocatable. Every descendant still binds full change-time identity.
    const bindChangeTime = !(await isVerifiedFixedPosixTempRoot(
      ancestorPath,
      stat,
      fixedTempCandidates,
    ));
    const identity = pathIdentity(stat, bindChangeTime);
    if (identity === null) {
      throw configError(`${label}_FILE_CHANGED`, `${label} ancestor identity is unavailable`);
    }
    bindings.push(Object.freeze({
      path: ancestorPath,
      bindChangeTime,
      identity: Object.freeze(identity),
    }));
  }
  return Object.freeze(bindings);
}

function ancestorBindingsMatch(expected, current) {
  return Array.isArray(expected)
    && expected.length === current.length
    && expected.every((entry, index) => (
      entry !== null
      && typeof entry === 'object'
      && entry.path === current[index].path
      && entry.bindChangeTime === current[index].bindChangeTime
      && identitiesMatch(
        entry.identity,
        current[index].identity,
        entry.bindChangeTime ? PATH_IDENTITY_FIELDS : PATH_STABLE_IDENTITY_FIELDS,
      )
    ));
}

// Same-UID in-place mutation cannot be excluded outside this transaction. The
// initial, post-open, and post-read bindings fail closed on observable relocation.
export async function captureTrustedPathBinding({
  filePath,
  targetRoot,
  label,
  expectedStat,
  expectedCanonicalPath,
}) {
  const current = await inspectCurrentTrustedPath({ filePath, targetRoot, label });
  if (expectedCanonicalPath !== undefined && current.canonical !== expectedCanonicalPath) {
    throw configError(`${label}_FILE_CHANGED`, `${label} canonical path changed before open`);
  }
  validateOpenedFileIdentity(expectedStat, current.stat, { label });
  return Object.freeze({
    canonicalPath: current.canonical,
    ancestorBindings: await captureAncestorBindings(
      current.resolved,
      current.canonical,
      targetRoot,
      label,
    ),
  });
}

async function validateCurrentTrustedPathBinding({
  filePath,
  targetRoot,
  label,
  descriptorStat,
  expectedPathBinding,
}) {
  if (expectedPathBinding === null
      || typeof expectedPathBinding !== 'object'
      || typeof expectedPathBinding.canonicalPath !== 'string') {
    throw configError('CONFIG_INVALID', 'Trusted file path binding is invalid');
  }
  const current = await inspectCurrentTrustedPath({ filePath, targetRoot, label });
  if (current.canonical !== expectedPathBinding.canonicalPath) {
    throw configError(`${label}_FILE_CHANGED`, `${label} canonical path changed during verified read`);
  }
  validateOpenedFileIdentity(descriptorStat, current.stat, { label });
  const currentAncestors = await captureAncestorBindings(
    current.resolved,
    current.canonical,
    targetRoot,
    label,
  );
  if (!ancestorBindingsMatch(expectedPathBinding.ancestorBindings, currentAncestors)) {
    throw configError(`${label}_FILE_CHANGED`, `${label} ancestor path changed during verified read`);
  }
}

export async function readVerifiedJsonFile({
  filePath,
  expectedStat,
  expectedPathBinding,
  targetRoot,
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
    await validateCurrentTrustedPathBinding({
      filePath,
      targetRoot,
      label,
      descriptorStat,
      expectedPathBinding,
    });
    const text = await handle.readFile('utf8');
    const finalDescriptorStat = await handle.stat({ bigint: true });
    validateRegularFileStat(finalDescriptorStat, label);
    validateOpenedFileIdentity(descriptorStat, finalDescriptorStat, { label });
    validateTrustedFileStat(finalDescriptorStat, { label, requirePrivateMode });
    await validateCurrentTrustedPathBinding({
      filePath,
      targetRoot,
      label,
      descriptorStat: finalDescriptorStat,
      expectedPathBinding,
    });
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

  const expectedPathBinding = await captureTrustedPathBinding({
    filePath: resolved,
    targetRoot,
    label,
    expectedStat: stat,
    expectedCanonicalPath: canonical,
  });

  return readVerifiedJsonFile({
    filePath: resolved,
    expectedStat: stat,
    expectedPathBinding,
    targetRoot,
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

export async function validateTrustedConfig(value) {
  const canonical = canonicalizeTrustedConfig(value);
  const schema = await loadBundledSchema('settings');
  validateAgainstSchema(canonical, schema, { name: 'trusted config' });
  if (canonical.browserSettleMs >= canonical.responseTimeoutMs) {
    throw configError(
      'CONFIG_BROWSER_SETTLE_INVALID',
      'Browser settle time must be shorter than the response timeout',
    );
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
  return validateTrustedConfig(mergeSettings(defaults, settings));
}
