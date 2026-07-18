import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
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
const INPUT_EXTENSIONS = new Set(['.har', '.js', '.json', '.ts', '.vue', '.yaml', '.yml']);
const BLOCKED_INPUT_NAME = /(?:^|[._-])(?:credential|credentials|secret|secrets|private[-_]?key)(?:[._-]|$)/u;

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
      await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
    } catch {
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

  try {
    return await realpath(resolvedRoot);
  } catch {
    throw boundaryError(invalidCode, 'Pinned root could not be canonicalized');
  }
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
  static async create(runRoot) {
    const canonicalRoot = await canonicalDirectory(runRoot, {
      symlinkCode: 'RUN_ROOT_SYMLINK',
      invalidCode: 'RUN_ROOT_INVALID',
      create: true,
    });
    return new RunBoundary(canonicalRoot);
  }

  constructor(canonicalRoot) {
    this.root = canonicalRoot;
  }

  async #write(name, contents) {
    const destination = resolveRelative(this.root, name);
    const parent = await verifyParent(this.root, destination, 'OUTPUT_PARENT_INVALID');
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
