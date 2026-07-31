import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { SentinelError } from './errors.mjs';

const READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);
const TARGET_READ_FLAGS = READ_FLAGS | (fsConstants.O_NONBLOCK ?? 0);
const WRITE_FLAGS = fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | fsConstants.O_WRONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);
const DIRECTORY_FLAGS = READ_FLAGS | (fsConstants.O_DIRECTORY ?? 0);
const INPUT_EXTENSIONS = new Set(['.har', '.js', '.json', '.ts', '.vue', '.yaml', '.yml']);
const BLOCKED_INPUT_NAME = /(?:^|[._-])(?:credential|credentials|secret|secrets|private[-_]?key)(?:[._-]|$)/u;
const STAGING_NAME = /^\.sentinel-run-staging-([a-f0-9]{64})$/u;
const PINNED_DIRECTORY = new RegExp(
  `^/proc/(?:self|${process.pid})/fd/[0-9]+$`,
  'u',
);
const PINNED_PATH = new RegExp(
  `^/proc/(?:self|${process.pid})/fd/[0-9]+(?:/|$)`,
  'u',
);
const RUN_MARKER_NAME = '.sentinel-run-identity-v2';
const MARKER_TOKEN = /^[a-f0-9]{64}$/u;
const MAX_TREE_NODES = 4096;
const MAX_TREE_DEPTH = 32;
const MAX_TREE_PATH_UNITS = 256 * 1024;

function boundaryError(code, message, details = {}) {
  return new SentinelError(code, message, details);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`));
}

function resolveRelative(root, relativePath) {
  if (typeof relativePath !== 'string'
      || relativePath.length === 0
      || relativePath.includes('\0')
      || path.isAbsolute(relativePath)
      || path.win32.isAbsolute(relativePath)) {
    throw boundaryError('PATH_ESCAPE', 'Path must be relative to the pinned root');
  }

  const candidate = path.resolve(root, relativePath);
  if (!isWithin(root, candidate) || candidate === root) {
    throw boundaryError('PATH_ESCAPE', 'Path escapes the pinned root');
  }
  return candidate;
}

function validateInputType(candidate) {
  const basename = path.basename(candidate).toLowerCase();
  const extension = path.extname(basename);
  if (basename === '.env'
      || basename.startsWith('.env.')
      || !INPUT_EXTENSIONS.has(extension)
      || BLOCKED_INPUT_NAME.test(basename)) {
    throw boundaryError('INPUT_TYPE_BLOCKED', 'Input type is not allowed');
  }
}

async function canonicalDirectory(root, { symlinkCode, invalidCode, create = false }) {
  const resolvedRoot = path.resolve(root);
  if (create) {
    try {
      await ensurePrivateDirectoryChain(resolvedRoot, { requirePrivateFinal: false });
    } catch (error) {
      if (error?.code === 'REPORT_ROOT_SYMLINK') {
        throw boundaryError(symlinkCode, 'Pinned root ancestors must not be symbolic links');
      }
      throw boundaryError(invalidCode, 'Pinned root could not be created');
    }
  }

  let stat;
  try {
    stat = await lstat(resolvedRoot);
  } catch {
    throw boundaryError(invalidCode, 'Pinned root is not an accessible directory');
  }
  if (stat.isSymbolicLink()) {
    throw boundaryError(symlinkCode, 'Pinned root must not be a symbolic link');
  }
  if (!stat.isDirectory()) {
    throw boundaryError(invalidCode, 'Pinned root must be a directory');
  }

  let canonical;
  try {
    canonical = await realpath(resolvedRoot);
  } catch {
    throw boundaryError(invalidCode, 'Pinned root could not be canonicalized');
  }
  if (canonical !== resolvedRoot) {
    throw boundaryError(symlinkCode, 'Pinned root and all ancestors must be canonical paths');
  }
  return canonical;
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null
      && typeof value === 'object'
      && (Object.getPrototypeOf(value) === Object.prototype
        || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
    );
  }
  return value;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function samePinnedDirectory(left, right) {
  return left.isDirectory()
    && right.isDirectory()
    && sameIdentity(left, right)
    && left.birthtimeNs === right.birthtimeNs
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function samePinnedFile(left, right) {
  return left.isFile()
    && right.isFile()
    && sameIdentity(left, right)
    && left.birthtimeNs === right.birthtimeNs
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

// Node 18 has no openat(2) API. Linux procfs lets each already-open directory
// descriptor act as the no-follow anchor for the next path segment.
async function openPinnedTargetRoot(root, expected = null) {
  if (process.platform !== 'linux') {
    throw boundaryError(
      'TARGET_ROOT_PIN_UNAVAILABLE',
      'Safe target-root descriptor pinning is unavailable on this platform',
    );
  }
  let handle;
  try {
    const initial = await lstat(root, { bigint: true });
    if (initial.isSymbolicLink() || !initial.isDirectory()) {
      throw boundaryError('TARGET_ROOT_CHANGED', 'Pinned target root changed identity');
    }
    if (expected !== null && !samePinnedDirectory(initial, expected)) {
      throw boundaryError('TARGET_ROOT_CHANGED', 'Pinned target root changed identity');
    }
    handle = await open(root, DIRECTORY_FLAGS);
    const opened = await handle.stat({ bigint: true });
    const anchor = `/proc/self/fd/${handle.fd}`;
    const anchored = await lstat(`${anchor}/.`, { bigint: true });
    const current = await lstat(root, { bigint: true });
    const anchoredCanonical = await realpath(anchor);
    const currentCanonical = await realpath(root);
    if (!samePinnedDirectory(initial, opened)
        || !samePinnedDirectory(opened, anchored)
        || !samePinnedDirectory(opened, current)
        || anchoredCanonical !== root
        || currentCanonical !== root
        || (expected !== null && !samePinnedDirectory(opened, expected))) {
      throw boundaryError('TARGET_ROOT_CHANGED', 'Pinned target root changed identity');
    }
    return { anchor, handle, identity: opened };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof SentinelError) throw error;
    throw boundaryError('TARGET_ROOT_CHANGED', 'Pinned target root could not be revalidated');
  }
}

async function verifyPinnedTargetRoot(root, pinned, expected) {
  try {
    const descriptor = await pinned.handle.stat({ bigint: true });
    const anchored = await lstat(`${pinned.anchor}/.`, { bigint: true });
    const current = await lstat(root, { bigint: true });
    const anchoredCanonical = await realpath(pinned.anchor);
    const currentCanonical = await realpath(root);
    if (current.isSymbolicLink()
        || !samePinnedDirectory(pinned.identity, descriptor)
        || !samePinnedDirectory(descriptor, anchored)
        || !samePinnedDirectory(descriptor, current)
        || !samePinnedDirectory(descriptor, expected)
        || anchoredCanonical !== root
        || currentCanonical !== root) {
      throw boundaryError('TARGET_ROOT_CHANGED', 'Pinned target root changed during input access');
    }
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    throw boundaryError('TARGET_ROOT_CHANGED', 'Pinned target root changed during input access');
  }
}

async function boundedReadText(handle, maxBytes) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = (maxBytes + 1) - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const result = await handle.read(buffer, 0, buffer.length, total);
    if (result.bytesRead === 0) return Buffer.concat(chunks, total).toString('utf8');
    chunks.push(buffer.subarray(0, result.bytesRead));
    total += result.bytesRead;
  }
  throw boundaryError(
    'INPUT_SIZE_LIMIT',
    'Input exceeds the configured read limit',
    { maxBytes },
  );
}

async function accessPinnedTargetInput(
  root,
  expectedRoot,
  candidate,
  { readContents = false, maxBytes = null } = {},
) {
  const relative = path.relative(root, candidate);
  const segments = relative.split(path.sep);
  let pinnedRoot;
  let fileHandle;
  const directories = [];
  try {
    pinnedRoot = await openPinnedTargetRoot(root, expectedRoot);
    let parentAnchor = pinnedRoot.anchor;
    for (const segment of segments.slice(0, -1)) {
      const entry = path.join(parentAnchor, segment);
      let initial;
      try {
        initial = await lstat(entry, { bigint: true });
      } catch {
        throw boundaryError('INPUT_PARENT_INVALID', 'Input parent is not accessible');
      }
      if (initial.isSymbolicLink()) {
        throw boundaryError('INPUT_SYMLINK', 'Input ancestors must not be symbolic links');
      }
      if (!initial.isDirectory()) {
        throw boundaryError('INPUT_PARENT_INVALID', 'Input parent is not a directory');
      }
      let handle;
      try {
        handle = await open(entry, DIRECTORY_FLAGS);
        const opened = await handle.stat({ bigint: true });
        const current = await lstat(entry, { bigint: true });
        if (!samePinnedDirectory(initial, opened) || !samePinnedDirectory(opened, current)) {
          throw boundaryError('INPUT_CHANGED', 'Input ancestor changed during descriptor pinning');
        }
        directories.push({ entry, handle, identity: opened });
        parentAnchor = `/proc/self/fd/${handle.fd}`;
      } catch (error) {
        await handle?.close().catch(() => {});
        if (error instanceof SentinelError) throw error;
        if (error?.code === 'ELOOP') {
          throw boundaryError('INPUT_SYMLINK', 'Input ancestors must not be symbolic links');
        }
        throw boundaryError('INPUT_PARENT_INVALID', 'Input parent could not be pinned safely');
      }
    }

    const input = path.join(parentAnchor, segments.at(-1));
    let initial;
    try {
      initial = await lstat(input, { bigint: true });
    } catch {
      throw boundaryError('INPUT_UNAVAILABLE', 'Input is not available');
    }
    if (initial.isSymbolicLink()) {
      throw boundaryError('INPUT_SYMLINK', 'Input must not be a symbolic link');
    }
    if (!initial.isFile()) {
      throw boundaryError('INPUT_NOT_FILE', 'Input must be a regular file');
    }
    fileHandle = await open(input, TARGET_READ_FLAGS);
    const opened = await fileHandle.stat({ bigint: true });
    if (!samePinnedFile(initial, opened)) {
      throw boundaryError('INPUT_CHANGED', 'Input changed before descriptor pinning');
    }
    if (maxBytes !== null && opened.size > BigInt(maxBytes)) {
      throw boundaryError(
        'INPUT_SIZE_LIMIT',
        'Input exceeds the configured read limit',
        { maxBytes },
      );
    }
    let contents = null;
    if (readContents) {
      contents = maxBytes === null
        ? await fileHandle.readFile('utf8')
        : await boundedReadText(fileHandle, maxBytes);
    }
    const after = await fileHandle.stat({ bigint: true });
    const current = await lstat(input, { bigint: true });
    if (!samePinnedFile(opened, after) || !samePinnedFile(after, current)) {
      throw boundaryError('INPUT_CHANGED', 'Input changed during descriptor-pinned access');
    }
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      const directory = directories[index];
      const descriptor = await directory.handle.stat({ bigint: true });
      const linked = await lstat(directory.entry, { bigint: true });
      if (!samePinnedDirectory(directory.identity, descriptor)
          || !samePinnedDirectory(descriptor, linked)) {
        throw boundaryError('INPUT_CHANGED', 'Input ancestor changed during access');
      }
    }
    await verifyPinnedTargetRoot(root, pinnedRoot, expectedRoot);
    return contents;
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    if (error?.code === 'ELOOP') {
      throw boundaryError('INPUT_SYMLINK', 'Input must not be a symbolic link');
    }
    throw boundaryError('INPUT_READ_FAILED', 'Input could not be accessed safely');
  } finally {
    await fileHandle?.close().catch(() => {});
    for (let index = directories.length - 1; index >= 0; index -= 1) {
      await directories[index].handle.close().catch(() => {});
    }
    await pinnedRoot?.handle.close().catch(() => {});
  }
}

function currentUid() {
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

function trustedOutputDirectory(stat) {
  const uid = currentUid();
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && uid !== null
    && stat.uid === uid
    && (stat.mode & 0o7777) === 0o700;
}

function trustedOutputFile(stat) {
  const uid = currentUid();
  return stat.isFile()
    && !stat.isSymbolicLink()
    && uid !== null
    && stat.uid === uid
    && (stat.mode & 0o7777) === 0o600
    && stat.nlink === 1;
}

async function syncOutputDirectory(directory, code = 'OUTPUT_SYNC_FAILED') {
  let handle;
  try {
    const candidate = PINNED_DIRECTORY.test(directory) ? `${directory}/.` : directory;
    handle = await open(candidate, DIRECTORY_FLAGS);
    await handle.sync();
  } catch {
    throw boundaryError(code, 'Output directory could not be synchronized');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function ensureOutputParent(root, destination) {
  const parent = path.dirname(destination);
  const relative = path.relative(root, parent);
  if (relative === '') return root;
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw boundaryError('PATH_ESCAPE', 'Output parent escapes the pinned root');
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
      await syncOutputDirectory(path.dirname(current));
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        if (error instanceof SentinelError) throw error;
        throw boundaryError('OUTPUT_PARENT_INVALID', 'Output parent could not be created safely');
      }
    }
    let identity;
    try {
      identity = await lstat(current);
    } catch {
      throw boundaryError('OUTPUT_PARENT_INVALID', 'Output parent is not accessible');
    }
    if (!trustedOutputDirectory(identity)) {
      throw boundaryError('OUTPUT_PARENT_INVALID', 'Output parent is not a private directory');
    }
    let handle;
    try {
      handle = await open(current, DIRECTORY_FLAGS);
      const opened = await handle.stat();
      const linked = await lstat(current);
      if (!trustedOutputDirectory(opened)
          || !trustedOutputDirectory(linked)
          || !sameIdentity(identity, opened)
          || !sameIdentity(opened, linked)) {
        throw boundaryError('OUTPUT_PARENT_INVALID', 'Output parent changed during pinning');
      }
    } catch (error) {
      if (error instanceof SentinelError) throw error;
      throw boundaryError('OUTPUT_PARENT_INVALID', 'Output parent could not be pinned safely');
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return verifyOutputParent(root, destination);
}

async function verifyOutputParent(root, destination) {
  const parent = path.dirname(destination);
  const relative = path.relative(root, parent);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw boundaryError('PATH_ESCAPE', 'Output parent escapes the pinned root');
  }
  let initial;
  let handle;
  try {
    initial = await lstat(parent);
    const allowExistingRootMode = parent === root && !PINNED_PATH.test(root);
    const validDirectory = (stat) => (
      allowExistingRootMode
        ? stat.isDirectory() && !stat.isSymbolicLink()
        : trustedOutputDirectory(stat)
    );
    if (!validDirectory(initial)) {
      throw boundaryError('OUTPUT_PARENT_INVALID', 'Output parent is not a private directory');
    }
    handle = await open(parent, DIRECTORY_FLAGS);
    const opened = await handle.stat();
    const current = await lstat(parent);
    if (!validDirectory(opened)
        || !validDirectory(current)
        || !sameIdentity(initial, opened)
        || !sameIdentity(opened, current)) {
      throw boundaryError('OUTPUT_PARENT_INVALID', 'Output parent changed during verification');
    }
    return parent;
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    throw boundaryError('OUTPUT_PARENT_INVALID', 'Output parent could not be verified safely');
  } finally {
    await handle?.close().catch(() => {});
  }
}

// History owns the lifetime of this descriptor. Keeping its procfs spelling
// avoids falling back to a public path after the root has been renamed.
async function pinnedReportRoot(reportRoot) {
  if (process.platform !== 'linux' || !PINNED_DIRECTORY.test(reportRoot)) return null;
  let handle;
  try {
    const initial = await lstat(`${reportRoot}/.`);
    if (!trustedOutputDirectory(initial)) {
      throw boundaryError(
        'REPORT_ROOT_PERMISSIONS_INVALID',
        'The report root must be owned by the current uid with mode 0700',
      );
    }
    handle = await open(`${reportRoot}/.`, DIRECTORY_FLAGS);
    const opened = await handle.stat();
    const current = await lstat(`${reportRoot}/.`);
    if (!trustedOutputDirectory(opened)
        || !trustedOutputDirectory(current)
        || !sameIdentity(initial, opened)
        || !sameIdentity(opened, current)) {
      throw boundaryError('REPORT_ROOT_CHANGED', 'Pinned report root changed identity');
    }
    return { identity: opened, root: reportRoot };
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    throw boundaryError('REPORT_ROOT_INVALID', 'Pinned report root is not accessible');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function stagingReportRoot(reportRoot) {
  const pinned = await pinnedReportRoot(reportRoot);
  if (pinned !== null) return pinned;
  const canonicalRoot = await canonicalDirectory(reportRoot, {
    symlinkCode: 'REPORT_ROOT_SYMLINK',
    invalidCode: 'REPORT_ROOT_INVALID',
  });
  const identity = await lstat(canonicalRoot);
  if (!trustedOutputDirectory(identity)) {
    throw boundaryError(
      'REPORT_ROOT_PERMISSIONS_INVALID',
      'The report root must be owned by the current uid with mode 0700',
    );
  }
  return { identity, root: canonicalRoot };
}

async function ensurePrivateDirectoryChain(candidate, { requirePrivateFinal = true } = {}) {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  const relative = resolved.slice(parsed.root.length);
  const segments = relative.length === 0 ? [] : relative.split(path.sep);
  let current = parsed.root;
  for (const segment of segments) {
    const parent = current;
    current = path.join(current, segment);
    let created = false;
    try {
      await mkdir(current, { mode: 0o700 });
      created = true;
      await syncOutputDirectory(parent, 'REPORT_ROOT_INVALID');
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        if (error instanceof SentinelError) throw error;
        throw boundaryError('REPORT_ROOT_INVALID', 'Report root could not be created safely');
      }
    }
    let identity;
    let canonical;
    try {
      identity = await lstat(current);
      canonical = await realpath(current);
    } catch {
      throw boundaryError('REPORT_ROOT_INVALID', 'Report root ancestor is inaccessible');
    }
    if (identity.isSymbolicLink() || !identity.isDirectory() || canonical !== current) {
      throw boundaryError('REPORT_ROOT_SYMLINK', 'Report root ancestors must not be symbolic links');
    }
    if (created && !trustedOutputDirectory(identity)) {
      throw boundaryError('REPORT_ROOT_PERMISSIONS_INVALID', 'Created report directories must be private');
    }
  }
  const finalIdentity = await lstat(resolved);
  if (requirePrivateFinal && !trustedOutputDirectory(finalIdentity)) {
    throw boundaryError(
      'REPORT_ROOT_PERMISSIONS_INVALID',
      'The report root must be owned by the current uid with mode 0700',
    );
  }
  return resolved;
}

async function inspectOutputTree(root, { remove = false } = {}) {
  const state = { nodes: 0, pathUnits: 0 };
  const visit = async (candidate, relative, depth) => {
    if (depth > MAX_TREE_DEPTH) {
      throw boundaryError('OUTPUT_TREE_LIMIT', 'Output tree exceeds its depth limit');
    }
    state.nodes += 1;
    state.pathUnits += relative.length;
    if (state.nodes > MAX_TREE_NODES || state.pathUnits > MAX_TREE_PATH_UNITS) {
      throw boundaryError('OUTPUT_TREE_LIMIT', 'Output tree exceeds its work limit');
    }
    let initial;
    try {
      initial = await lstat(candidate);
    } catch {
      throw boundaryError('OUTPUT_TREE_CHANGED', 'Output tree changed during inspection');
    }
    if (initial.isSymbolicLink()) {
      if (!remove) throw boundaryError('OUTPUT_TREE_SYMLINK', 'Output tree contains a symbolic link');
      await unlink(candidate);
      return;
    }
    if (initial.isDirectory()) {
      if (!trustedOutputDirectory(initial)) {
        throw boundaryError('OUTPUT_TREE_INVALID', 'Output tree contains an unsafe directory');
      }
      const names = [];
      let directory;
      try {
        directory = await opendir(candidate);
        while (true) {
          const entry = await directory.read();
          if (entry === null) break;
          names.push(entry.name);
          if (state.nodes + names.length > MAX_TREE_NODES) {
            throw boundaryError('OUTPUT_TREE_LIMIT', 'Output tree exceeds its node limit');
          }
        }
      } finally {
        await directory?.close().catch(() => {});
      }
      names.sort();
      for (const name of names) {
        await visit(path.join(candidate, name), path.join(relative, name), depth + 1);
      }
      if (remove) {
        await rmdir(candidate);
      } else {
        await syncOutputDirectory(candidate);
        const current = await lstat(candidate);
        if (!trustedOutputDirectory(current) || !sameIdentity(initial, current)) {
          throw boundaryError('OUTPUT_TREE_CHANGED', 'Output directory changed during sync');
        }
      }
      return;
    }
    if (!trustedOutputFile(initial)) {
      throw boundaryError('OUTPUT_TREE_INVALID', 'Output tree contains an unsafe artifact');
    }
    if (remove) {
      await unlink(candidate);
      return;
    }
    let handle;
    try {
      handle = await open(candidate, READ_FLAGS);
      const opened = await handle.stat();
      if (!trustedOutputFile(opened) || !sameIdentity(initial, opened)) {
        throw boundaryError('OUTPUT_TREE_CHANGED', 'Output artifact changed before sync');
      }
      await handle.sync();
      const after = await handle.stat();
      const current = await lstat(candidate);
      if (!trustedOutputFile(after)
          || !trustedOutputFile(current)
          || !sameIdentity(opened, after)
          || !sameIdentity(after, current)
          || after.size !== opened.size
          || after.mtimeMs !== opened.mtimeMs
          || after.ctimeMs !== opened.ctimeMs) {
        throw boundaryError('OUTPUT_TREE_CHANGED', 'Output artifact changed during sync');
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  };
  await visit(root, '.', 0);
}

export class TargetBoundary {
  #identity;

  static async create(root) {
    const canonicalRoot = await canonicalDirectory(root, {
      symlinkCode: 'TARGET_ROOT_SYMLINK',
      invalidCode: 'TARGET_ROOT_INVALID',
    });
    const pinned = await openPinnedTargetRoot(canonicalRoot);
    try {
      return new TargetBoundary(canonicalRoot, pinned.identity);
    } finally {
      await pinned.handle.close().catch(() => {});
    }
  }

  constructor(canonicalRoot, identity) {
    this.root = canonicalRoot;
    this.#identity = identity;
  }

  async readText(relativePath, { maxBytes = null } = {}) {
    if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
      throw boundaryError('INPUT_LIMIT_INVALID', 'Input read limit must be a positive safe integer');
    }
    const candidate = resolveRelative(this.root, relativePath);
    validateInputType(candidate);
    return accessPinnedTargetInput(this.root, this.#identity, candidate, {
      readContents: true,
      maxBytes,
    });
  }

  async resolveInput(relativePath) {
    const candidate = resolveRelative(this.root, relativePath);
    validateInputType(candidate);
    await accessPinnedTargetInput(this.root, this.#identity, candidate);
    return candidate;
  }
}

export class RunBoundary {
  #staging;

  static async create(runRoot) {
    const canonicalRoot = await canonicalDirectory(runRoot, {
      symlinkCode: 'RUN_ROOT_SYMLINK',
      invalidCode: 'RUN_ROOT_INVALID',
      create: true,
    });
    return new RunBoundary(canonicalRoot);
  }

  static async ensureReportRoot(reportRoot) {
    if (typeof reportRoot !== 'string'
        || reportRoot.length === 0
        || reportRoot.includes('\0')
        || !path.isAbsolute(reportRoot)) {
      throw boundaryError('REPORT_ROOT_INVALID', 'Report root must be an absolute path');
    }
    return ensurePrivateDirectoryChain(reportRoot);
  }

  static async createStaging(reportRoot, markerToken) {
    if (!MARKER_TOKEN.test(markerToken)) {
      throw boundaryError('RUN_MARKER_INVALID', 'Run identity marker is invalid');
    }
    const report = await stagingReportRoot(reportRoot);
    const canonicalReportRoot = report.root;
    const name = `.sentinel-run-staging-${markerToken}`;
    if (!STAGING_NAME.test(name)) {
      throw boundaryError('RUN_STAGE_FAILED', 'Run staging identifier is invalid');
    }
    const stagingRoot = path.join(canonicalReportRoot, name);
    try {
      await mkdir(stagingRoot, { mode: 0o700 });
      const identity = await lstat(stagingRoot);
      if (!trustedOutputDirectory(identity)) {
        throw boundaryError('RUN_STAGE_FAILED', 'Run staging directory is not private');
      }
      await syncOutputDirectory(canonicalReportRoot, 'RUN_STAGE_FAILED');
      const boundary = new RunBoundary(stagingRoot, {
        reportRoot: canonicalReportRoot,
        name,
        identity,
      });
      try {
        await boundary.writeIdentityMarker(markerToken);
        return boundary;
      } catch (error) {
        try {
          await boundary.abort();
        } catch (abortError) {
          throw abortError;
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof SentinelError) throw error;
      throw boundaryError('RUN_STAGE_FAILED', 'Run staging directory could not be created');
    }
  }

  static async recoverStaging(reportRoot, name) {
    const match = STAGING_NAME.exec(name);
    if (match === null || path.basename(name) !== name) {
      throw boundaryError('RUN_STAGE_INVALID', 'Run staging identifier is invalid');
    }
    const canonicalReportRoot = (await stagingReportRoot(reportRoot)).root;
    const stagingRoot = path.join(canonicalReportRoot, name);
    let identity;
    try {
      identity = await lstat(stagingRoot);
    } catch {
      throw boundaryError('RUN_STAGE_RECOVERY_FAILED', 'Run staging directory is unavailable');
    }
    if (!trustedOutputDirectory(identity)) {
      throw boundaryError('RUN_STAGE_RECOVERY_FAILED', 'Run staging directory is unsafe');
    }
    const markerPath = path.join(stagingRoot, RUN_MARKER_NAME);
    let markerHandle;
    try {
      const markerPathIdentity = await lstat(markerPath);
      if (!trustedOutputFile(markerPathIdentity) || markerPathIdentity.size !== 65) {
        throw boundaryError('RUN_STAGE_RECOVERY_FAILED', 'Run staging marker is invalid');
      }
      markerHandle = await open(markerPath, READ_FLAGS);
      const opened = await markerHandle.stat();
      const contents = await markerHandle.readFile('utf8');
      const current = await lstat(markerPath);
      if (!trustedOutputFile(opened)
          || !trustedOutputFile(current)
          || !sameIdentity(markerPathIdentity, opened)
          || !sameIdentity(opened, current)
          || contents !== `${match[1]}\n`) {
        throw boundaryError('RUN_STAGE_RECOVERY_FAILED', 'Run staging marker does not match');
      }
    } catch (error) {
      if (error instanceof SentinelError) throw error;
      throw boundaryError('RUN_STAGE_RECOVERY_FAILED', 'Run staging marker is unavailable');
    } finally {
      await markerHandle?.close().catch(() => {});
    }
    const boundary = new RunBoundary(stagingRoot, {
      reportRoot: canonicalReportRoot,
      name,
      identity,
    });
    await boundary.abort();
  }

  constructor(canonicalRoot, staging = null) {
    this.root = canonicalRoot;
    this.#staging = staging;
  }

  async #write(name, contents, { internal = false } = {}) {
    const destination = resolveRelative(this.root, name);
    if (!internal && path.relative(this.root, destination).split(path.sep)[0] === RUN_MARKER_NAME) {
      throw boundaryError('OUTPUT_NAME_RESERVED', 'Output path is reserved for run identity');
    }
    const parent = await ensureOutputParent(this.root, destination);
    const temporary = path.join(
      parent,
      `.${path.basename(destination)}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
    );
    let handle;

    try {
      handle = await open(temporary, WRITE_FLAGS, 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;

      await verifyOutputParent(this.root, destination);
      await rename(temporary, destination);
      await syncOutputDirectory(parent);
      return destination;
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      if (error instanceof SentinelError) throw error;
      throw boundaryError('OUTPUT_WRITE_FAILED', 'Output could not be written atomically');
    }
  }

  async writeJson(name, value) {
    let contents;
    try {
      contents = `${JSON.stringify(sortJson(value), null, 2)}\n`;
    } catch {
      throw boundaryError('OUTPUT_SERIALIZE_FAILED', 'Output value is not JSON serializable');
    }
    if (contents === 'undefined\n') {
      throw boundaryError('OUTPUT_SERIALIZE_FAILED', 'Output value is not JSON serializable');
    }
    return this.#write(name, contents);
  }

  async writeText(name, value) {
    if (typeof value !== 'string') {
      throw boundaryError('OUTPUT_TEXT_INVALID', 'Text output must be a string');
    }
    return this.#write(name, value);
  }

  async writeBytes(name, value) {
    if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
      throw boundaryError('OUTPUT_BYTES_INVALID', 'Binary output must be a Buffer or Uint8Array');
    }
    return this.#write(name, Buffer.from(value));
  }

  async writeIdentityMarker(token) {
    if (this.#staging === null || !MARKER_TOKEN.test(token)) {
      throw boundaryError('RUN_MARKER_INVALID', 'Run identity marker is invalid');
    }
    return this.#write(RUN_MARKER_NAME, `${token}\n`, { internal: true });
  }

  async syncTree() {
    await inspectOutputTree(this.root);
  }

  async commit(runId) {
    if (this.#staging === null) {
      throw boundaryError('RUN_STAGE_INVALID', 'Only an unpublished staging run can be committed');
    }
    if (typeof runId !== 'string'
        || runId.length === 0
        || runId === '.'
        || runId === '..'
        || path.basename(runId) !== runId
        || runId.includes('\0')) {
      throw boundaryError('RUN_ID_INVALID', 'Run identifier must be a single path segment');
    }
    await this.syncTree();
    const destination = path.join(this.#staging.reportRoot, runId);
    let existing;
    try {
      existing = await lstat(destination);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw boundaryError('RUN_PUBLISH_FAILED', 'Run destination could not be inspected safely');
      }
    }
    if (existing !== undefined) {
      throw boundaryError('RUN_ALREADY_EXISTS', 'Run destination already exists');
    }
    const stageIdentity = await lstat(this.root);
    if (!trustedOutputDirectory(stageIdentity)
        || !sameIdentity(stageIdentity, this.#staging.identity)) {
      throw boundaryError('RUN_STAGE_CHANGED', 'Run staging directory changed before publication');
    }
    try {
      await rename(this.root, destination);
      this.root = destination;
      this.#staging = null;
      await syncOutputDirectory(path.dirname(destination), 'RUN_PUBLISH_FAILED');
      const published = await lstat(destination);
      if (!trustedOutputDirectory(published) || !sameIdentity(stageIdentity, published)) {
        throw boundaryError('RUN_PUBLISH_FAILED', 'Published run identity does not match staging');
      }
      return destination;
    } catch (error) {
      if (error instanceof SentinelError) throw error;
      throw boundaryError('RUN_PUBLISH_FAILED', 'Complete run could not be published atomically');
    }
  }

  async abort() {
    if (this.#staging === null) return;
    const staging = this.#staging;
    try {
      const current = await lstat(this.root);
      if (!trustedOutputDirectory(current) || !sameIdentity(current, staging.identity)) {
        throw boundaryError('RUN_STAGE_CHANGED', 'Run staging directory changed before abort');
      }
      await inspectOutputTree(this.root, { remove: true });
      await syncOutputDirectory(staging.reportRoot, 'RUN_ABORT_FAILED');
      this.#staging = null;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#staging = null;
        return;
      }
      if (error instanceof SentinelError) throw error;
      throw boundaryError('RUN_ABORT_FAILED', 'Run staging directory could not be aborted safely');
    }
  }
}
