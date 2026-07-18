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
  symlink,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { SentinelError } from './errors.mjs';

const READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);
const WRITE_FLAGS = fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | fsConstants.O_WRONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);
const DIRECTORY_FLAGS = READ_FLAGS | (fsConstants.O_DIRECTORY ?? 0);
const INPUT_EXTENSIONS = new Set(['.har', '.js', '.json', '.ts', '.vue', '.yaml', '.yml']);
const BLOCKED_INPUT_NAME = /(?:^|[._-])(?:credential|credentials|secret|secrets|private[-_]?key)(?:[._-]|$)/u;
const STAGING_NAME = /^\.sentinel-run-staging-([a-f0-9]{64})$/u;
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

async function verifyParent(root, candidate, code) {
  let canonicalParent;
  try {
    canonicalParent = await realpath(path.dirname(candidate));
  } catch {
    throw boundaryError(code, 'Path parent is not an accessible directory');
  }
  if (!isWithin(root, canonicalParent)) {
    throw boundaryError('PATH_ESCAPE', 'Canonical path parent escapes the pinned root');
  }
  return canonicalParent;
}

async function inspectInput(root, candidate) {
  await verifyParent(root, candidate, 'INPUT_PARENT_INVALID');

  let stat;
  try {
    stat = await lstat(candidate);
  } catch {
    throw boundaryError('INPUT_UNAVAILABLE', 'Input is not available');
  }
  if (stat.isSymbolicLink()) {
    throw boundaryError('INPUT_SYMLINK', 'Input must not be a symbolic link');
  }
  if (!stat.isFile()) {
    throw boundaryError('INPUT_NOT_FILE', 'Input must be a regular file');
  }

  let canonicalInput;
  try {
    canonicalInput = await realpath(candidate);
  } catch {
    throw boundaryError('INPUT_UNAVAILABLE', 'Input could not be canonicalized');
  }
  if (!isWithin(root, canonicalInput)) {
    throw boundaryError('PATH_ESCAPE', 'Canonical input escapes the pinned root');
  }
  return canonicalInput;
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
    handle = await open(directory, DIRECTORY_FLAGS);
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
    let canonical;
    try {
      identity = await lstat(current);
      canonical = await realpath(current);
    } catch {
      throw boundaryError('OUTPUT_PARENT_INVALID', 'Output parent is not accessible');
    }
    if (!trustedOutputDirectory(identity) || canonical !== current) {
      throw boundaryError('OUTPUT_PARENT_INVALID', 'Output parent is not a private directory');
    }
  }
  return verifyParent(root, destination, 'OUTPUT_PARENT_INVALID');
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
  static async create(root) {
    const canonicalRoot = await canonicalDirectory(root, {
      symlinkCode: 'TARGET_ROOT_SYMLINK',
      invalidCode: 'TARGET_ROOT_INVALID',
    });
    return new TargetBoundary(canonicalRoot);
  }

  constructor(canonicalRoot) {
    this.root = canonicalRoot;
  }

  async readText(relativePath) {
    const candidate = resolveRelative(this.root, relativePath);
    validateInputType(candidate);
    await inspectInput(this.root, candidate);

    let handle;
    try {
      handle = await open(candidate, READ_FLAGS);
      const stat = await handle.stat();
      if (!stat.isFile()) {
        throw boundaryError('INPUT_NOT_FILE', 'Input must be a regular file');
      }
      return await handle.readFile('utf8');
    } catch (error) {
      if (error instanceof SentinelError) throw error;
      if (error?.code === 'ELOOP') {
        throw boundaryError('INPUT_SYMLINK', 'Input must not be a symbolic link');
      }
      throw boundaryError('INPUT_READ_FAILED', 'Input could not be read');
    } finally {
      await handle?.close();
    }
  }

  async resolveInput(relativePath) {
    const candidate = resolveRelative(this.root, relativePath);
    validateInputType(candidate);
    return inspectInput(this.root, candidate);
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
    const canonicalReportRoot = await canonicalDirectory(reportRoot, {
      symlinkCode: 'REPORT_ROOT_SYMLINK',
      invalidCode: 'REPORT_ROOT_INVALID',
    });
    const reportIdentity = await lstat(canonicalReportRoot);
    if (!trustedOutputDirectory(reportIdentity)) {
      throw boundaryError(
        'REPORT_ROOT_PERMISSIONS_INVALID',
        'The report root must be owned by the current uid with mode 0700',
      );
    }
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
    const canonicalReportRoot = await canonicalDirectory(reportRoot, {
      symlinkCode: 'REPORT_ROOT_SYMLINK',
      invalidCode: 'REPORT_ROOT_INVALID',
    });
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

      await verifyParent(this.root, destination, 'OUTPUT_PARENT_INVALID');
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

  async replaceLatest(reportRoot, runId) {
    if (typeof runId !== 'string'
        || runId.length === 0
        || runId === '.'
        || runId === '..'
        || path.basename(runId) !== runId
        || runId.includes('\0')) {
      throw boundaryError('RUN_ID_INVALID', 'Run identifier must be a single path segment');
    }

    const canonicalReportRoot = await canonicalDirectory(reportRoot, {
      symlinkCode: 'REPORT_ROOT_SYMLINK',
      invalidCode: 'REPORT_ROOT_INVALID',
    });
    const runPath = path.join(canonicalReportRoot, runId);
    let runStat;
    try {
      runStat = await lstat(runPath);
    } catch {
      throw boundaryError('RUN_NOT_FOUND', 'Latest run does not exist');
    }
    if (runStat.isSymbolicLink() || !runStat.isDirectory()) {
      throw boundaryError('RUN_INVALID', 'Latest run must be a regular directory');
    }
    if (!isWithin(canonicalReportRoot, await realpath(runPath))) {
      throw boundaryError('PATH_ESCAPE', 'Latest run escapes the report root');
    }

    const temporary = path.join(
      canonicalReportRoot,
      `.latest.${process.pid}.${randomBytes(12).toString('hex')}.tmp`,
    );
    try {
      await symlink(runId, temporary, 'dir');
      await rename(temporary, path.join(canonicalReportRoot, 'latest'));
      return path.join(canonicalReportRoot, 'latest');
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw boundaryError('LATEST_REPLACE_FAILED', 'Latest run pointer could not be replaced');
    }
  }
}
