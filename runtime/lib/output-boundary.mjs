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
  link,
} from 'node:fs/promises';
import path from 'node:path';
import { types as utilTypes } from 'node:util';

import { SentinelError } from './errors.mjs';

const DIRECTORY_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_DIRECTORY ?? 0)
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);
const FILE_FLAGS = fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | fsConstants.O_WRONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);
const MAX_TREE_NODES = 2048;
const MAX_TREE_DEPTH = 32;
const MAX_TREE_PATH_UNITS = 128 * 1024;
const MAX_TREE_BYTES = 8 * 1024 * 1024;

function outputError(code, message) {
  return new SentinelError(code, message);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function currentUid() {
  return typeof process.geteuid === 'function' ? process.geteuid() : null;
}

function privateFile(stat) {
  const uid = currentUid();
  return uid !== null
    && stat.isFile()
    && !stat.isSymbolicLink()
    && stat.uid === uid
    && (stat.mode & 0o7777) === 0o600
    && stat.nlink === 1;
}

function privateDirectory(stat) {
  const uid = currentUid();
  return uid !== null
    && stat.isDirectory()
    && !stat.isSymbolicLink()
    && stat.uid === uid
    && (stat.mode & 0o7777) === 0o700;
}

function trustedParentDirectory(stat) {
  const uid = currentUid();
  return uid !== null
    && stat.isDirectory()
    && !stat.isSymbolicLink()
    && stat.uid === uid
    && (stat.mode & 0o022) === 0;
}

function outputPath(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value.includes('\0')) {
    throw outputError('OUTPUT_PATH_INVALID', 'Output path is invalid');
  }
  const resolved = path.resolve(value);
  const parsed = path.parse(resolved);
  if (resolved === parsed.root || path.basename(resolved) === '') {
    throw outputError('OUTPUT_PATH_INVALID', 'Output path must name one destination');
  }
  return { resolved, parent: path.dirname(resolved), name: path.basename(resolved) };
}

async function absent(candidate) {
  try {
    await lstat(candidate);
    return false;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw outputError('OUTPUT_INSPECT_FAILED', 'Output destination could not be inspected');
  }
}

async function unlinkIfIdentity(candidate, identity) {
  if (identity === null) return;
  try {
    const current = await lstat(candidate);
    if (sameIdentity(current, identity)) await unlink(candidate);
  } catch {
    // Missing or replaced paths are never unlinked speculatively.
  }
}

async function openPinnedParent(value) {
  const selected = outputPath(value);
  let before;
  let canonical;
  let handle;
  try {
    before = await lstat(selected.parent);
    canonical = await realpath(selected.parent);
    if (!trustedParentDirectory(before)
        || canonical !== selected.parent) {
      throw outputError(
        'OUTPUT_PARENT_INVALID',
        'Output parent must be canonical, current-user-owned, and not group/world-writable',
      );
    }
    handle = await open(selected.parent, DIRECTORY_FLAGS);
    const opened = await handle.stat();
    if (!trustedParentDirectory(opened) || !sameIdentity(before, opened)) {
      throw outputError('OUTPUT_PARENT_CHANGED', 'Output parent changed while being pinned');
    }
    const anchor = `/proc/self/fd/${handle.fd}`;
    if (await realpath(anchor) !== selected.parent) {
      throw outputError('OUTPUT_PARENT_CHANGED', 'Output parent does not match its pinned descriptor');
    }
    if (!await absent(path.join(anchor, selected.name))) {
      throw outputError('OUTPUT_EXISTS', 'Output destination already exists');
    }
    return { ...selected, anchor, handle, identity: opened };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof SentinelError) throw error;
    throw outputError('OUTPUT_PARENT_INVALID', 'Output parent could not be pinned');
  }
}

async function verifyParent(parent) {
  let current;
  try {
    current = await lstat(parent.parent);
  } catch {
    throw outputError('OUTPUT_PARENT_CHANGED', 'Output parent changed during publication');
  }
  if (!trustedParentDirectory(current)
      || !sameIdentity(current, parent.identity)
      || await realpath(parent.anchor) !== parent.parent) {
    throw outputError('OUTPUT_PARENT_CHANGED', 'Output parent changed during publication');
  }
}

async function writePrivateFile(candidate, contents) {
  if (typeof contents !== 'string'
      && !Buffer.isBuffer(contents)
      && !(contents instanceof Uint8Array)) {
    throw outputError('OUTPUT_CONTENT_INVALID', 'Output content must be text or bytes');
  }
  let handle;
  try {
    handle = await open(candidate, FILE_FLAGS, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(contents);
    await handle.sync();
    const stat = await handle.stat();
    if (!privateFile(stat)) {
      throw outputError('OUTPUT_FILE_INVALID', 'Output file is not private and exclusive');
    }
    return stat;
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    throw outputError('OUTPUT_WRITE_FAILED', 'Output file could not be written');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function artifactPath(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value.includes('\0')
      || value.includes('\\')
      || path.isAbsolute(value)
      || path.win32.isAbsolute(value)) {
    throw outputError('OUTPUT_ARTIFACT_INVALID', 'Output artifact path is invalid');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw outputError('OUTPUT_ARTIFACT_INVALID', 'Output artifact path is not canonical');
  }
  return segments;
}

function snapshotArtifacts(artifacts) {
  if (!Array.isArray(artifacts)
      || utilTypes.isProxy(artifacts)
      || Object.getPrototypeOf(artifacts) !== Array.prototype
      || artifacts.length === 0
      || artifacts.length > MAX_TREE_NODES) {
    throw outputError('OUTPUT_ARTIFACT_INVALID', 'Output artifacts must be a bounded data array');
  }
  const arrayKeys = Reflect.ownKeys(artifacts);
  if (arrayKeys.length !== artifacts.length + 1 || !arrayKeys.includes('length')) {
    throw outputError('OUTPUT_ARTIFACT_INVALID', 'Output artifacts must be an own-data array');
  }
  const snapshot = [];
  const nodeTypes = new Map([['.', 'directory']]);
  let pathUnits = 0;
  let contentBytes = 0;
  for (let index = 0; index < artifacts.length; index += 1) {
    const arrayDescriptor = Object.getOwnPropertyDescriptor(artifacts, String(index));
    if (arrayDescriptor === undefined
        || !Object.hasOwn(arrayDescriptor, 'value')
        || arrayDescriptor.enumerable !== true) {
      throw outputError('OUTPUT_ARTIFACT_INVALID', 'Output artifacts must be own data');
    }
    const artifact = arrayDescriptor.value;
    if (artifact === null
        || typeof artifact !== 'object'
        || Array.isArray(artifact)
        || utilTypes.isProxy(artifact)
        || Object.getPrototypeOf(artifact) !== Object.prototype) {
      throw outputError('OUTPUT_ARTIFACT_INVALID', 'Output artifact is invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(artifact);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== 3
        || keys.some((key) => typeof key !== 'string'
          || (key !== 'path' && key !== 'content' && key !== 'mediaType'))) {
      throw outputError('OUTPUT_ARTIFACT_INVALID', 'Output artifact fields are invalid');
    }
    for (const key of ['path', 'content', 'mediaType']) {
      const descriptor = descriptors[key];
      if (descriptor === undefined
          || !Object.hasOwn(descriptor, 'value')
          || descriptor.enumerable !== true
          || typeof descriptor.value !== 'string') {
        throw outputError('OUTPUT_ARTIFACT_INVALID', 'Output artifact fields must be string data');
      }
    }
    const segments = artifactPath(descriptors.path.value);
    if (segments.length > MAX_TREE_DEPTH) {
      throw outputError('OUTPUT_TREE_LIMIT', 'Output tree exceeds its depth limit');
    }
    pathUnits += descriptors.path.value.length;
    contentBytes += Buffer.byteLength(descriptors.content.value);
    if (pathUnits > MAX_TREE_PATH_UNITS || contentBytes > MAX_TREE_BYTES) {
      throw outputError('OUTPUT_TREE_LIMIT', 'Output tree exceeds its size limits');
    }
    let relative = '';
    for (let segment = 0; segment < segments.length; segment += 1) {
      relative = relative === '' ? segments[segment] : `${relative}/${segments[segment]}`;
      const expected = segment === segments.length - 1 ? 'file' : 'directory';
      const existing = nodeTypes.get(relative);
      if (existing !== undefined && (existing !== expected || expected === 'file')) {
        throw outputError('OUTPUT_ARTIFACT_INVALID', 'Output artifact paths conflict');
      }
      nodeTypes.set(relative, expected);
      if (nodeTypes.size > MAX_TREE_NODES) {
        throw outputError('OUTPUT_TREE_LIMIT', 'Output tree exceeds its node limit');
      }
    }
    snapshot.push(Object.freeze({
      path: descriptors.path.value,
      content: descriptors.content.value,
      mediaType: descriptors.mediaType.value,
      segments: Object.freeze(segments),
    }));
  }
  return Object.freeze(snapshot);
}

async function syncTree(root) {
  const state = { nodes: 0, pathUnits: 0 };
  const visit = async (candidate, relative, depth) => {
    state.nodes += 1;
    state.pathUnits += relative.length;
    if (depth > MAX_TREE_DEPTH
        || state.nodes > MAX_TREE_NODES
        || state.pathUnits > MAX_TREE_PATH_UNITS) {
      throw outputError('OUTPUT_TREE_LIMIT', 'Output tree exceeds its safety limits');
    }
    const initial = await lstat(candidate);
    if (initial.isSymbolicLink()) {
      throw outputError('OUTPUT_TREE_INVALID', 'Output tree contains a symbolic link');
    }
    if (initial.isFile()) {
      if (!privateFile(initial)) {
        throw outputError('OUTPUT_TREE_INVALID', 'Output tree contains an unsafe file');
      }
      let handle;
      try {
        handle = await open(candidate, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
        const opened = await handle.stat();
        if (!privateFile(opened) || !sameIdentity(initial, opened)) {
          throw outputError('OUTPUT_TREE_CHANGED', 'Output file changed before publication');
        }
      } finally {
        await handle?.close().catch(() => {});
      }
      return;
    }
    if (!privateDirectory(initial)) {
      throw outputError('OUTPUT_TREE_INVALID', 'Output tree contains an unsafe directory');
    }
    const names = [];
    let directory;
    try {
      directory = await opendir(candidate);
      while (true) {
        const entry = await directory.read();
        if (entry === null) break;
        names.push(entry.name);
      }
    } finally {
      await directory?.close().catch(() => {});
    }
    names.sort();
    for (const name of names) {
      await visit(path.join(candidate, name), path.join(relative, name), depth + 1);
    }
    let handle;
    try {
      handle = await open(candidate, DIRECTORY_FLAGS);
      await handle.sync();
      const after = await handle.stat();
      if (!privateDirectory(after) || !sameIdentity(initial, after)) {
        throw outputError('OUTPUT_TREE_CHANGED', 'Output directory changed during publication');
      }
    } finally {
      await handle?.close().catch(() => {});
    }
  };
  await visit(root, '.', 0);
}

async function removeCreatedTree(candidate, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > MAX_TREE_NODES) {
    throw outputError('OUTPUT_ABORT_FAILED', 'Output staging cleanup exceeded its node limit');
  }
  let stat;
  try {
    stat = await lstat(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw outputError('OUTPUT_ABORT_FAILED', 'Output staging could not be inspected');
  }
  if (stat.isSymbolicLink() || stat.isFile()) {
    await unlink(candidate);
    return;
  }
  if (!stat.isDirectory()) {
    throw outputError('OUTPUT_ABORT_FAILED', 'Output staging contains an unsupported node');
  }
  const names = [];
  let directory;
  try {
    directory = await opendir(candidate);
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      names.push(entry.name);
    }
  } finally {
    await directory?.close().catch(() => {});
  }
  for (const name of names) await removeCreatedTree(path.join(candidate, name), budget);
  await rmdir(candidate);
}

export class OutputBoundary {
  static async writeFile(destination, contents) {
    const parent = await openPinnedParent(destination);
    const nonce = randomBytes(16).toString('hex');
    const temporary = path.join(parent.anchor, `.${parent.name}.sentinel-${nonce}.tmp`);
    const target = path.join(parent.anchor, parent.name);
    let published = false;
    let writtenIdentity = null;
    try {
      writtenIdentity = await writePrivateFile(temporary, contents);
      await verifyParent(parent);
      try {
        await link(temporary, target);
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw outputError('OUTPUT_EXISTS', 'Output destination already exists');
        }
        throw error;
      }
      published = true;
      await unlink(temporary);
      await parent.handle.sync();
      const result = await lstat(target);
      if (!privateFile(result)) {
        throw outputError('OUTPUT_FILE_INVALID', 'Published output is not a private regular file');
      }
      await verifyParent(parent);
    } catch (error) {
      await unlinkIfIdentity(temporary, writtenIdentity);
      if (published && writtenIdentity !== null) {
        try {
          const current = await lstat(target);
          if (sameIdentity(current, writtenIdentity)) await unlink(target);
        } catch {
          // Never remove a replacement whose identity cannot be proven.
        }
      }
      if (error instanceof SentinelError) throw error;
      throw outputError('OUTPUT_WRITE_FAILED', 'Output file could not be published atomically');
    } finally {
      await parent.handle.close().catch(() => {});
    }
  }

  static async writeTree(destination, artifacts) {
    const trustedArtifacts = snapshotArtifacts(artifacts);
    const parent = await openPinnedParent(destination);
    const nonce = randomBytes(16).toString('hex');
    const staging = path.join(parent.anchor, `.${parent.name}.sentinel-${nonce}.stage`);
    const target = path.join(parent.anchor, parent.name);
    let stagePublished = false;
    let stageCreated = false;
    let stageIdentity = null;
    try {
      await mkdir(staging, { mode: 0o700 });
      stageIdentity = await lstat(staging);
      if (!privateDirectory(stageIdentity)) {
        throw outputError('OUTPUT_TREE_INVALID', 'Output staging directory is not private');
      }
      stageCreated = true;
      for (const artifact of trustedArtifacts) {
        const { segments } = artifact;
        let directory = staging;
        for (let index = 0; index < segments.length - 1; index += 1) {
          directory = path.join(directory, segments[index]);
          try {
            await mkdir(directory, { mode: 0o700 });
          } catch (error) {
            if (error?.code !== 'EEXIST') throw error;
          }
          if (!privateDirectory(await lstat(directory))) {
            throw outputError('OUTPUT_TREE_INVALID', 'Output artifact parent is unsafe');
          }
        }
        await writePrivateFile(path.join(directory, segments[segments.length - 1]), artifact.content);
      }
      await syncTree(staging);
      const syncedIdentity = await lstat(staging);
      if (!sameIdentity(stageIdentity, syncedIdentity)) {
        throw outputError('OUTPUT_TREE_CHANGED', 'Output staging changed before publication');
      }
      await verifyParent(parent);
      if (!await absent(target)) {
        throw outputError('OUTPUT_EXISTS', 'Output destination already exists');
      }
      await rename(staging, target);
      stagePublished = true;
      await parent.handle.sync();
      const result = await lstat(target);
      if (!privateDirectory(result)) {
        throw outputError('OUTPUT_TREE_INVALID', 'Published output tree is not private');
      }
      await verifyParent(parent);
    } catch (error) {
      let abortError = null;
      if (!stagePublished && stageCreated && stageIdentity !== null) {
        try {
          const current = await lstat(staging);
          if (!sameIdentity(current, stageIdentity)) {
            throw outputError('OUTPUT_ABORT_FAILED', 'Output staging identity changed before abort');
          }
          await removeCreatedTree(staging);
        } catch (cleanupError) {
          abortError = cleanupError;
        }
      }
      if (stagePublished && stageIdentity !== null) {
        try {
          const current = await lstat(target);
          if (sameIdentity(current, stageIdentity)) await removeCreatedTree(target);
        } catch {
          // Never remove a replacement whose identity cannot be proven.
        }
      }
      if (abortError !== null) throw abortError;
      if (error instanceof SentinelError) throw error;
      throw outputError('OUTPUT_WRITE_FAILED', 'Output tree could not be published atomically');
    } finally {
      await parent.handle.close().catch(() => {});
    }
  }
}
