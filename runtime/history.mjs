import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants, readFileSync } from 'node:fs';
import {
  lstat,
  open,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { SentinelError } from './lib/errors.mjs';
import { validateCanonicalFindings } from './lib/findings-contract.mjs';
import { snapshotJson } from './lib/json-snapshot.mjs';
import { validateAgainstSchema } from './lib/schema.mjs';

const HISTORY_SCHEMA = JSON.parse(
  readFileSync(new URL('../schemas/sweep-history.schema.json', import.meta.url), 'utf8'),
);
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z(?:-[a-f0-9]{8})?$/u;
const TRANSACTION_ID = /^[a-f0-9]{24}$/u;
const DECIMAL_BIGINT = /^(?:0|[1-9]\d*)$/u;
const MARKER_TOKEN = /^[a-f0-9]{64}$/u;
const FINDINGS_DIGEST = /^[a-f0-9]{64}$/u;
const LOCK_ID = /^[a-f0-9]{32}$/u;
const TOMBSTONE_NAME = /^\.sentinel-clean-([a-f0-9]{24})-([0-9]{4})$/u;
const RETIRED_RECORD_TEMP = /^\.history-record-[a-f0-9]{32}\.tmp$/u;
const LOCK_RECORD_TEMP = /^\.history-record\.([1-9]\d{0,9})\.([1-9]\d*)\.([a-f0-9]{32})\.([a-f0-9]{32})\.tmp$/u;
const RELEASED_RECORD_TEMP = /^\.history-released\.([1-9]\d{0,9})\.([1-9]\d*)\.([a-f0-9]{32})\.([a-f0-9]{32})\.tmp$/u;
const HISTORY_TEMP = /^\.sweep-history\.([1-9]\d{0,9})\.([1-9]\d*)\.([a-f0-9]{32})\.tmp$/u;
const LEGACY_HISTORY_TEMP = /^\.sweep-history\.([1-9]\d{0,9})\.([a-f0-9]{32})\.tmp$/u;
const CHOOSING_NAME = /^\.sweep-history-lock-choosing-([a-f0-9]{32})$/u;
const TICKET_NAME = /^\.sweep-history-lock-ticket-([a-f0-9]{32})$/u;
const CHOOSING_RECORD = /^([LR]) ([1-9]\d{0,9}) ([1-9]\d*) ([a-f0-9]{32})\n$/u;
const TICKET_RECORD = /^([LR]) ([1-9]\d{0,9}) ([1-9]\d*) ([a-f0-9]{32}) ([1-9]\d{0,9})\n$/u;
const HISTORY_NAME = 'sweep-history.json';
const REPORT_ROOT_BASENAME = 'sentinel-v2';
const RUN_MARKER_NAME = '.sentinel-run-identity-v2';
const LOCK_TIMEOUT_MS = 5000;
const MAX_HISTORY_BYTES = 16 * 1024 * 1024;
const MAX_HISTORY_RUNS = 128;
const MAX_CLEAN_ENTRIES = MAX_HISTORY_RUNS;
const MAX_PURGE_NODES = 1024;
const MAX_PURGE_DEPTH = 32;
const MAX_PURGE_PATH_UNITS = 128 * 1024;
const MAX_LOCK_MARKERS = 4096;
const MAX_ROOT_SCAN_ENTRIES = 16_384;
const MAX_TICKET = 1_000_000_000;
const READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_NONBLOCK ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);
const DIRECTORY_FLAGS = READ_FLAGS | (fsConstants.O_DIRECTORY ?? 0);
const CREATE_FLAGS = fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | fsConstants.O_WRONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);
const SUMMARY_KEYS = ['critical', 'error', 'warning', 'info', 'skipped'];

function historyError(code, message, details = {}) {
  return new SentinelError(code, message, details);
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sameIdentity(left, right) {
  return BigInt(left.dev) === BigInt(right.dev)
    && BigInt(left.ino) === BigInt(right.ino);
}

function runFingerprint(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs),
    uid: String(stat.uid),
    mode: String(stat.mode),
  };
}

function matchesRunFingerprint(stat, entry) {
  const fingerprint = runFingerprint(stat);
  return fingerprint.dev === entry.dev
    && fingerprint.ino === entry.ino
    && fingerprint.birthtimeNs === entry.birthtimeNs
    && fingerprint.uid === entry.uid
    && fingerprint.mode === entry.mode;
}

function sameReadState(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.birthtimeNs === right.birthtimeNs
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function trustedRegularFile(stat) {
  return stat.isFile()
    && typeof process.geteuid === 'function'
    && stat.uid === BigInt(process.geteuid())
    && (stat.mode & 0o7777n) === 0o600n
    && stat.nlink === 1n;
}

function trustedDirectory(stat) {
  return stat.isDirectory()
    && typeof process.geteuid === 'function'
    && stat.uid === BigInt(process.geteuid())
    && (stat.mode & 0o7777n) === 0o700n
    && stat.nlink >= 2n;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function snapshotOptions(value, code, message, limits = {}) {
  const limitCode = limits.limitCode ?? code;
  const limitMessage = limits.limitMessage ?? message;
  try {
    return snapshotJson(value, {
      code,
      message,
      maxNodes: 250_000,
      maxArrayLength: 100_000,
      ...limits,
      limitCode,
      limitMessage,
    });
  } catch (error) {
    if (limitCode !== code && error?.code === limitCode) {
      throw historyError(limitCode, limitMessage);
    }
    throw historyError(code, message);
  }
}

function validateFindings(value, code = 'HISTORY_FINDINGS_INVALID') {
  const findings = validateCanonicalFindings(value, {
    code,
    message: 'History input is not a canonical findings document',
  });
  if (!RUN_ID.test(findings.runId)) {
    throw historyError(code, 'History input contains an invalid run identifier');
  }
  return findings;
}

function validateHistory(value) {
  const failure = historyError('HISTORY_CORRUPT', 'Sweep history is corrupt or invalid');
  let history;
  try {
    history = snapshotJson(value, {
      code: failure.code,
      message: failure.message,
      maxNodes: 250_000,
      maxArrayLength: 100_000,
    });
    validateAgainstSchema(history, HISTORY_SCHEMA, { name: 'history' });
  } catch {
    throw failure;
  }
  const runIds = history.runs.map((entry) => entry.runId);
  const runTokens = new Set();
  const runIdentities = new Set();
  if (history.runs.length > MAX_HISTORY_RUNS
      || new Set(runIds).size !== runIds.length
      || runIds.some((runId, index) => (
        !RUN_ID.test(runId)
        || (index > 0 && compareCodeUnits(runIds[index - 1], runId) >= 0)
      ))) {
    throw failure;
  }
  for (const entry of history.runs) {
    const identity = `${entry.dev}\0${entry.ino}\0${entry.birthtimeNs}`;
    if (!FINDINGS_DIGEST.test(entry.findingsDigest)
        || !MARKER_TOKEN.test(entry.markerToken)
        || !DECIMAL_BIGINT.test(entry.dev)
        || !DECIMAL_BIGINT.test(entry.ino)
        || !DECIMAL_BIGINT.test(entry.birthtimeNs)
        || !DECIMAL_BIGINT.test(entry.uid)
        || !DECIMAL_BIGINT.test(entry.mode)
        || runTokens.has(entry.markerToken)
        || runIdentities.has(identity)) {
      throw failure;
    }
    runTokens.add(entry.markerToken);
    runIdentities.add(identity);
  }
  if (history.pendingCleanup !== undefined) {
    const pending = history.pendingCleanup;
    if (pending.entries.length > MAX_CLEAN_ENTRIES) throw failure;
    const pendingRunIds = new Set();
    const tombstones = new Set();
    const markerTokens = new Set(runTokens);
    const identities = new Set(runIdentities);
    for (let index = 0; index < pending.entries.length; index += 1) {
      const entry = pending.entries[index];
      const identity = `${entry.dev}\0${entry.ino}\0${entry.birthtimeNs}`;
      const expectedTombstone = `.sentinel-clean-${pending.transactionId}-${String(index).padStart(4, '0')}`;
      if (!RUN_ID.test(entry.runId)
          || path.basename(entry.runId) !== entry.runId
          || entry.tombstone !== expectedTombstone
          || path.basename(entry.tombstone) !== entry.tombstone
          || !MARKER_TOKEN.test(entry.markerToken)
          || !DECIMAL_BIGINT.test(entry.dev)
          || !DECIMAL_BIGINT.test(entry.ino)
          || !DECIMAL_BIGINT.test(entry.birthtimeNs)
          || !DECIMAL_BIGINT.test(entry.uid)
          || !DECIMAL_BIGINT.test(entry.mode)
          || pendingRunIds.has(entry.runId)
          || tombstones.has(entry.tombstone)
          || markerTokens.has(entry.markerToken)
          || identities.has(identity)
          || runIds.includes(entry.runId)
          || (index > 0
            && compareCodeUnits(pending.entries[index - 1].runId, entry.runId) >= 0)) {
        throw failure;
      }
      pendingRunIds.add(entry.runId);
      tombstones.add(entry.tombstone);
      markerTokens.add(entry.markerToken);
      identities.add(identity);
    }
  }
  return history;
}

async function pathStat(candidate) {
  try {
    return await lstat(candidate, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function unlinkExactFile(candidate, identity) {
  const current = await pathStat(candidate);
  if (current === null) return true;
  if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(current, identity)) {
    return false;
  }
  try {
    await unlink(candidate);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  return true;
}

async function boundedRead(handle, maxBytes, code, message) {
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = (maxBytes + 1) - total;
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    let result;
    try {
      result = await handle.read(buffer, 0, buffer.length, total);
    } catch {
      throw historyError(code, message);
    }
    if (result.bytesRead === 0) {
      return {
        bytes: total,
        contents: Buffer.concat(chunks, total).toString('utf8'),
      };
    }
    chunks.push(buffer.subarray(0, result.bytesRead));
    total += result.bytesRead;
  }
  throw historyError(code, message);
}

async function readRegularFile(candidate, {
  corruptCode,
  corruptMessage,
  symlinkCode,
  symlinkMessage,
  readCode,
  readMessage,
  maxBytes,
  allowDisappear = false,
}) {
  let initial;
  try {
    initial = await lstat(candidate, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw historyError(readCode, readMessage);
  }
  if (initial.isSymbolicLink()) throw historyError(symlinkCode, symlinkMessage);
  if (!trustedRegularFile(initial) || initial.size > BigInt(maxBytes)) {
    throw historyError(corruptCode, corruptMessage);
  }
  let handle;
  try {
    handle = await open(candidate, READ_FLAGS);
    const opened = await handle.stat({ bigint: true });
    if (!trustedRegularFile(opened)
        || opened.size > BigInt(maxBytes)
        || !sameReadState(opened, initial)) {
      if (allowDisappear && await pathStat(candidate) === null) return null;
      throw historyError(corruptCode, corruptMessage);
    }
    const read = await boundedRead(handle, maxBytes, corruptCode, corruptMessage);
    const after = await handle.stat({ bigint: true });
    const current = await lstat(candidate, { bigint: true });
    if (!trustedRegularFile(after)
        || !trustedRegularFile(current)
        || BigInt(read.bytes) !== opened.size
        || !sameReadState(opened, after)
        || !sameReadState(after, current)) {
      throw historyError(corruptCode, corruptMessage);
    }
    return { contents: read.contents, identity: opened };
  } catch (error) {
    if (allowDisappear && error?.code === 'ENOENT') return null;
    if (error instanceof SentinelError) throw error;
    if (error?.code === 'ELOOP') throw historyError(symlinkCode, symlinkMessage);
    throw historyError(readCode, readMessage);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function openReportRoot(reportRoot) {
  if (typeof reportRoot !== 'string' || reportRoot.length === 0 || reportRoot.includes('\0')) {
    throw historyError('REPORT_ROOT_INVALID', 'Report root is invalid');
  }
  const publicPath = path.resolve(reportRoot);
  if (path.basename(publicPath) !== REPORT_ROOT_BASENAME) {
    throw historyError(
      'REPORT_ROOT_VERSION_INVALID',
      'History operations require the isolated sentinel-v2 report root',
    );
  }
  let handle;
  try {
    const canonical = await realpath(publicPath);
    if (canonical !== publicPath) {
      throw historyError(
        'REPORT_ROOT_SYMLINK',
        'Report root and all of its ancestors must be canonical non-symbolic paths',
      );
    }
    const initial = await lstat(publicPath, { bigint: true });
    if (initial.isSymbolicLink()) {
      throw historyError('REPORT_ROOT_SYMLINK', 'Report root must not be a symbolic link');
    }
    if (!initial.isDirectory()) {
      throw historyError('REPORT_ROOT_INVALID', 'Report root must be a directory');
    }
    handle = await open(publicPath, DIRECTORY_FLAGS);
    const identity = await handle.stat({ bigint: true });
    if (!identity.isDirectory() || !sameIdentity(identity, initial)) {
      throw historyError('REPORT_ROOT_INVALID', 'Report root must be a directory');
    }
    if (typeof process.geteuid !== 'function'
        || identity.uid !== BigInt(process.geteuid())
        || (identity.mode & 0o7777n) !== 0o700n
        || identity.nlink < 2n) {
      throw historyError(
        'REPORT_ROOT_PERMISSIONS_INVALID',
        'The sentinel-v2 report root must be owned by the current uid with mode 0700',
      );
    }
    if (process.platform !== 'linux') {
      throw historyError(
        'REPORT_ROOT_PIN_UNAVAILABLE',
        'Safe report-root descriptor pinning is unavailable on this platform',
      );
    }
    const anchor = `/proc/self/fd/${handle.fd}`;
    const anchored = await lstat(`${anchor}/.`, { bigint: true });
    const current = await lstat(publicPath, { bigint: true });
    const anchoredCanonical = await realpath(anchor);
    const currentCanonical = await realpath(publicPath);
    if (!anchored.isDirectory()
        || current.isSymbolicLink()
        || !current.isDirectory()
        || anchoredCanonical !== publicPath
        || currentCanonical !== publicPath
        || !sameIdentity(anchored, identity)
        || !sameIdentity(current, identity)) {
      throw historyError('REPORT_ROOT_CHANGED', 'Report root changed during descriptor pinning');
    }
    return { anchor, handle, identity, publicPath };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof SentinelError) throw error;
    if (error?.code === 'ELOOP') {
      throw historyError('REPORT_ROOT_SYMLINK', 'Report root must not be a symbolic link');
    }
    throw historyError('REPORT_ROOT_INVALID', 'Report root could not be pinned safely');
  }
}

async function verifyReportRoot(root) {
  let current;
  let anchoredCanonical;
  let currentCanonical;
  try {
    current = await lstat(root.publicPath, { bigint: true });
    anchoredCanonical = await realpath(root.anchor);
    currentCanonical = await realpath(root.publicPath);
  } catch {
    throw historyError('REPORT_ROOT_CHANGED', 'Report root changed during history operation');
  }
  if (current.isSymbolicLink()
      || !current.isDirectory()
      || anchoredCanonical !== root.publicPath
      || currentCanonical !== root.publicPath
      || !sameIdentity(current, root.identity)
      || current.uid !== root.identity.uid
      || current.mode !== root.identity.mode
      || current.nlink < 2n) {
    throw historyError('REPORT_ROOT_CHANGED', 'Report root changed during history operation');
  }
}

async function syncDirectory(anchor, code = 'HISTORY_WRITE_FAILED',
  message = 'Sweep history directory could not be synchronized') {
  let handle;
  try {
    handle = await open(`${anchor}/.`, DIRECTORY_FLAGS);
    await handle.sync();
  } catch {
    throw historyError(code, message);
  } finally {
    await handle?.close().catch(() => {});
  }
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function processStartMarker(pid) {
  let contents;
  try {
    contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return null;
    throw historyError('HISTORY_LOCK_FAILED', 'Process liveness could not be verified');
  }
  const close = contents.lastIndexOf(')');
  if (close < 0) throw historyError('HISTORY_LOCK_FAILED', 'Process identity is malformed');
  const fields = contents.slice(close + 2).trim().split(/\s+/u);
  const marker = fields[19];
  if (!/^[1-9]\d*$/u.test(marker ?? '')) {
    throw historyError('HISTORY_LOCK_FAILED', 'Process start marker is unavailable');
  }
  return marker;
}

async function ownerIsLive(pid, startMarker = null) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code !== 'EPERM') {
      throw historyError('HISTORY_LOCK_INVALID', 'History lock owner is invalid');
    }
  }
  if (startMarker === null) return true;
  return await processStartMarker(pid) === startMarker;
}

async function publishRecord(anchor, name, content, code, message) {
  const destination = path.join(anchor, name);
  const recordPattern = CHOOSING_NAME.test(name) ? CHOOSING_RECORD : TICKET_RECORD;
  const record = recordPattern.exec(content);
  if (record === null || record[1] !== 'L') throw historyError(code, message);
  const pid = Number(record[2]);
  const startMarker = record[3];
  const id = record[4];
  const expectedId = (CHOOSING_NAME.exec(name) ?? TICKET_NAME.exec(name))?.[1];
  if (!Number.isSafeInteger(pid) || pid !== process.pid || id !== expectedId) {
    throw historyError(code, message);
  }
  const candidate = path.join(
    anchor,
    `.history-record.${pid}.${startMarker}.${id}.${randomBytes(16).toString('hex')}.tmp`,
  );
  let handle;
  let identity;
  let published = false;
  try {
    if (await pathStat(destination) !== null) throw historyError(code, message);
    handle = await open(candidate, CREATE_FLAGS, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    identity = await handle.stat({ bigint: true });
    if (!trustedRegularFile(identity)) throw historyError(code, message);
    await rename(candidate, destination);
    published = true;
    const current = await lstat(destination, { bigint: true });
    if (!trustedRegularFile(current) || !sameIdentity(current, identity)) {
      throw historyError(code, message);
    }
    await syncDirectory(anchor, code, message);
    return { handle, id, identity, path: destination, pid, startMarker };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (identity !== undefined) await unlinkExactFile(candidate, identity).catch(() => {});
    if (published && identity !== undefined) {
      await unlinkExactFile(destination, identity).catch(() => {});
    }
    if (error instanceof SentinelError) throw error;
    throw historyError(code, message);
  }
}

async function releaseRecord(anchor, record) {
  if (record === null || record === undefined) return;
  const releasedPath = path.join(
    anchor,
    `.history-released.${record.pid}.${record.startMarker}.${record.id}.${randomBytes(16).toString('hex')}.tmp`,
  );
  let retired = false;
  try {
    const current = await pathStat(record.path);
    if (current !== null
        && trustedRegularFile(current)
        && sameIdentity(current, record.identity)) {
      await rename(record.path, releasedPath);
      retired = true;
      const released = await pathStat(releasedPath);
      if (released !== null
          && (!trustedRegularFile(released)
            || !sameIdentity(released, record.identity))) {
        throw historyError('HISTORY_LOCK_FAILED', 'History lock release changed identity');
      }
      await syncDirectory(anchor);
    }
  } catch {
    // Exact unlink below is the only fallback; public lock records are never mutated in place.
  } finally {
    await record.handle.close().catch(() => {});
  }
  const removed = await unlinkExactFile(
    retired ? releasedPath : record.path,
    record.identity,
  ).catch(() => false);
  if (removed) await syncDirectory(anchor).catch(() => {});
}

async function readMarker(anchor, name, type) {
  const result = await readRegularFile(path.join(anchor, name), {
    corruptCode: 'HISTORY_LOCK_INVALID',
    corruptMessage: 'History lock marker is invalid or unsafe',
    symlinkCode: 'HISTORY_LOCK_INVALID',
    symlinkMessage: 'History lock marker is invalid or unsafe',
    readCode: 'HISTORY_LOCK_FAILED',
    readMessage: 'History lock marker could not be inspected',
    maxBytes: 256,
    allowDisappear: true,
  });
  if (result === null) return { record: null, reapIdentity: null };
  const pattern = type === 'choosing' ? CHOOSING_RECORD : TICKET_RECORD;
  const match = pattern.exec(result.contents);
  const expectedId = (type === 'choosing' ? CHOOSING_NAME : TICKET_NAME).exec(name)?.[1];
  if (match === null || match[4] !== expectedId) {
    throw historyError('HISTORY_LOCK_INVALID', 'History lock marker is malformed');
  }
  const record = {
    state: match[1],
    pid: Number(match[2]),
    startMarker: match[3],
    id: match[4],
    ticket: type === 'ticket' ? Number(match[5]) : null,
  };
  if (!Number.isSafeInteger(record.pid)
      || (record.ticket !== null
        && (!Number.isSafeInteger(record.ticket) || record.ticket > MAX_TICKET))) {
    throw historyError('HISTORY_LOCK_INVALID', 'History lock marker is malformed');
  }
  if (record.state === 'R') return { record: null, reapIdentity: result.identity };
  return await ownerIsLive(record.pid, record.startMarker)
    ? { record, reapIdentity: null }
    : { record: null, reapIdentity: result.identity };
}

async function scanRootEntries(anchor, visitor) {
  let directory;
  let count = 0;
  try {
    directory = await opendir(anchor);
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      count += 1;
      if (count > MAX_ROOT_SCAN_ENTRIES) {
        throw historyError('HISTORY_LOCK_LIMIT', 'History root scan limit exceeded');
      }
      await visitor(entry.name);
    }
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    throw historyError('HISTORY_LOCK_FAILED', 'History lock directory could not be scanned');
  } finally {
    await directory?.close().catch(() => {});
  }
}

async function trustedDebrisIdentity(candidate, { allowTwoLinks = false } = {}) {
  const identity = await pathStat(candidate);
  if (identity === null) return null;
  const trusted = identity.isFile()
    && !identity.isSymbolicLink()
    && typeof process.geteuid === 'function'
    && identity.uid === BigInt(process.geteuid())
    && (identity.mode & 0o7777n) === 0o600n
    && (identity.nlink === 1n || (allowTwoLinks && identity.nlink === 2n));
  if (!trusted) {
    throw historyError('HISTORY_LOCK_INVALID', 'History transaction debris is invalid or unsafe');
  }
  return identity;
}

async function reapRootDebris(anchor) {
  let dirty = false;
  const inspect = async (name) => {
    const lockStage = LOCK_RECORD_TEMP.exec(name);
    const released = RELEASED_RECORD_TEMP.exec(name);
    const historyTemporary = HISTORY_TEMP.exec(name);
    const legacyHistoryTemporary = LEGACY_HISTORY_TEMP.exec(name);
    const retired = RETIRED_RECORD_TEMP.test(name);
    if (lockStage === null
        && released === null
        && historyTemporary === null
        && legacyHistoryTemporary === null
        && !retired) return;
    const candidate = path.join(anchor, name);
    const identity = await trustedDebrisIdentity(candidate, { allowTwoLinks: retired });
    if (identity === null) return;
    let shouldReap = retired || released !== null;
    if (lockStage !== null) {
      shouldReap = !await ownerIsLive(Number(lockStage[1]), lockStage[2]);
    } else if (historyTemporary !== null) {
      shouldReap = !await ownerIsLive(
        Number(historyTemporary[1]),
        historyTemporary[2],
      );
    } else if (legacyHistoryTemporary !== null) {
      shouldReap = !await ownerIsLive(Number(legacyHistoryTemporary[1]));
    }
    if (shouldReap && await unlinkExactFile(candidate, identity)) dirty = true;
  };
  try {
    await scanRootEntries(anchor, inspect);
  } catch (error) {
    if (dirty) await syncDirectory(anchor);
    throw error;
  }
  if (dirty) await syncDirectory(anchor);
}

async function scanMarkers(anchor) {
  await reapRootDebris(anchor);
  const choosing = [];
  const tickets = [];
  let activeCount = 0;
  let dirty = false;
  const inspect = async (name) => {
    const choosingMatch = CHOOSING_NAME.exec(name);
    const ticketMatch = TICKET_NAME.exec(name);
    if (choosingMatch === null && ticketMatch === null) return;
    const type = choosingMatch === null ? 'ticket' : 'choosing';
    const result = await readMarker(anchor, name, type);
    if (result.reapIdentity !== null) {
      if (await unlinkExactFile(path.join(anchor, name), result.reapIdentity)) dirty = true;
      return;
    }
    if (result.record === null) return;
    activeCount += 1;
    if (activeCount > MAX_LOCK_MARKERS) {
      throw historyError('HISTORY_LOCK_LIMIT', 'History lock marker limit exceeded');
    }
    (type === 'choosing' ? choosing : tickets).push(result.record);
  };
  try {
    await scanRootEntries(anchor, inspect);
  } catch (error) {
    if (dirty) await syncDirectory(anchor);
    throw error;
  }
  if (dirty) await syncDirectory(anchor);
  choosing.sort((left, right) => compareCodeUnits(left.id, right.id));
  tickets.sort(ticketOrder);
  return { choosing, tickets };
}

function ticketOrder(left, right) {
  return left.ticket - right.ticket || compareCodeUnits(left.id, right.id);
}

async function acquireLock(anchor) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const startMarker = await processStartMarker(process.pid);
  const id = randomBytes(16).toString('hex');
  if (!LOCK_ID.test(id)) throw historyError('HISTORY_LOCK_FAILED', 'Lock nonce is invalid');
  let choosing;
  let ticket;
  try {
    choosing = await publishRecord(
      anchor,
      `.sweep-history-lock-choosing-${id}`,
      `L ${process.pid} ${startMarker} ${id}\n`,
      'HISTORY_LOCK_FAILED',
      'History choosing marker could not be published',
    );
    const initial = await scanMarkers(anchor);
    const nextTicket = initial.tickets.reduce(
      (maximum, record) => Math.max(maximum, record.ticket),
      0,
    ) + 1;
    if (nextTicket > MAX_TICKET) {
      throw historyError('HISTORY_LOCK_LIMIT', 'History lock ticket limit exceeded');
    }
    ticket = await publishRecord(
      anchor,
      `.sweep-history-lock-ticket-${id}`,
      `L ${process.pid} ${startMarker} ${id} ${nextTicket}\n`,
      'HISTORY_LOCK_FAILED',
      'History ticket could not be published',
    );
    await releaseRecord(anchor, choosing);
    choosing = null;
    const own = { id, ticket: nextTicket };
    while (true) {
      const state = await scanMarkers(anchor);
      const otherChoosing = state.choosing.some((record) => record.id !== id);
      const lowerTicket = state.tickets.some(
        (record) => record.id !== id && ticketOrder(record, own) < 0,
      );
      if (!otherChoosing && !lowerTicket) return { ticket };
      if (Date.now() >= deadline) {
        throw historyError('HISTORY_LOCK_TIMEOUT', 'Timed out waiting for sweep history lock');
      }
      await pause(10);
    }
  } catch (error) {
    await releaseRecord(anchor, choosing);
    await releaseRecord(anchor, ticket);
    throw error;
  }
}

async function releaseLock(anchor, lock) {
  await releaseRecord(anchor, lock?.ticket);
}

async function readHistory(anchor) {
  const result = await readRegularFile(path.join(anchor, HISTORY_NAME), {
    corruptCode: 'HISTORY_CORRUPT',
    corruptMessage: 'Sweep history is not a valid regular file',
    symlinkCode: 'HISTORY_SYMLINK',
    symlinkMessage: 'Sweep history must not be a symbolic link',
    readCode: 'HISTORY_READ_FAILED',
    readMessage: 'Sweep history could not be read',
    maxBytes: MAX_HISTORY_BYTES,
  });
  if (result === null) return deepFreeze({ schemaVersion: '2.0', runs: [] });
  let history;
  try {
    history = JSON.parse(result.contents);
  } catch {
    throw historyError('HISTORY_CORRUPT', 'Sweep history is not valid JSON');
  }
  return validateHistory(history);
}

function serializedHistory(value) {
  const history = validateHistory(value);
  const contents = `${JSON.stringify(history, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_HISTORY_BYTES) {
    throw historyError('HISTORY_LIMIT_EXCEEDED', 'Sweep history exceeds its persisted size limit');
  }
  return { contents, history };
}

async function verifyExactHistory(anchor, expectedContents) {
  const result = await readRegularFile(path.join(anchor, HISTORY_NAME), {
    corruptCode: 'HISTORY_WRITE_FAILED',
    corruptMessage: 'Sweep history replacement does not match the committed document',
    symlinkCode: 'HISTORY_WRITE_FAILED',
    symlinkMessage: 'Sweep history replacement does not match the committed document',
    readCode: 'HISTORY_WRITE_FAILED',
    readMessage: 'Sweep history replacement could not be verified',
    maxBytes: MAX_HISTORY_BYTES,
  });
  const expectedDigest = createHash('sha256').update(expectedContents).digest('hex');
  const actualDigest = result === null
    ? null
    : createHash('sha256').update(result.contents).digest('hex');
  if (result === null
      || actualDigest !== expectedDigest
      || result.contents !== expectedContents) {
    throw historyError(
      'HISTORY_WRITE_FAILED',
      'Sweep history replacement does not match the committed document',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(result.contents);
  } catch {
    throw historyError('HISTORY_WRITE_FAILED', 'Sweep history replacement is not valid JSON');
  }
  validateHistory(parsed);
  return result.identity;
}

async function atomicWriteHistory(anchor, value, options = {}) {
  const { contents } = serializedHistory(value);
  const destination = path.join(anchor, HISTORY_NAME);
  const startMarker = await processStartMarker(process.pid);
  const temporary = path.join(
    anchor,
    `.sweep-history.${process.pid}.${startMarker}.${randomBytes(16).toString('hex')}.tmp`,
  );
  let handle;
  let renamed = false;
  try {
    const destinationStat = await pathStat(destination);
    if (destinationStat?.isSymbolicLink()) {
      throw historyError('HISTORY_SYMLINK', 'Sweep history must not be a symbolic link');
    }
    if (destinationStat !== null && !destinationStat.isFile()) {
      throw historyError('HISTORY_CORRUPT', 'Sweep history is not a regular file');
    }
    handle = await open(temporary, CREATE_FLAGS, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (options.beforeRename !== undefined) await options.beforeRename();
    await rename(temporary, destination);
    renamed = true;
    const committedIdentity = await verifyExactHistory(anchor, contents);
    await syncDirectory(anchor);
    const durableIdentity = await verifyExactHistory(anchor, contents);
    if (!sameIdentity(committedIdentity, durableIdentity)) {
      throw historyError('HISTORY_WRITE_FAILED', 'Sweep history changed during commit verification');
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (renamed) {
      throw historyError(
        'HISTORY_WRITE_FAILED',
        'Sweep history replacement has uncertain durability',
        { committed: true, durable: false },
      );
    }
    if (error instanceof SentinelError) throw error;
    throw historyError('HISTORY_WRITE_FAILED', 'Sweep history could not be written atomically');
  }
}

function historyEntry(findings, identity) {
  return {
    runId: findings.runId,
    startedAt: findings.startedAt,
    finishedAt: findings.finishedAt,
    coverageStatus: findings.coverage.status,
    summary: clone(findings.summary),
    findingsDigest: createHash('sha256').update(canonicalJson(findings)).digest('hex'),
    markerToken: identity.markerToken,
    ...runFingerprint(identity.stat),
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort(compareCodeUnits)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function sameHistoryEntry(left, right) {
  const scalarKeys = [
    'runId',
    'startedAt',
    'finishedAt',
    'coverageStatus',
    'findingsDigest',
    'markerToken',
    'dev',
    'ino',
    'birthtimeNs',
    'uid',
    'mode',
  ];
  return scalarKeys.every((key) => left[key] === right[key])
    && SUMMARY_KEYS.every((key) => left.summary[key] === right.summary[key]);
}

async function openPublishedRun(anchor, runId) {
  const run = await openPinnedRun(anchor, runId);
  if (run === null) {
    throw historyError('HISTORY_RUN_MISSING', 'Published v2 run directory is missing');
  }
  try {
    const markerToken = await readRunMarker(run);
    const stat = await run.handle.stat({ bigint: true });
    if (!await revalidatePinnedRun(run, null, markerToken)) {
      throw historyError('HISTORY_RUN_IDENTITY_INVALID', 'Published v2 run identity changed');
    }
    return { run, markerToken, stat };
  } catch (error) {
    await run.handle.close().catch(() => {});
    if (error instanceof SentinelError) throw error;
    throw historyError('HISTORY_RUN_IDENTITY_INVALID', 'Published v2 run identity is invalid');
  }
}

/** Appends one completed canonical run under an exclusive, atomic history lock. */
export async function appendHistory(options = {}) {
  const input = snapshotOptions(
    options,
    'HISTORY_INPUT_INVALID',
    'History options must be recursively plain own-data JSON',
    {
      maxStringLength: MAX_HISTORY_BYTES,
      maxStringUnits: MAX_HISTORY_BYTES * 4,
      limitCode: 'HISTORY_LIMIT_EXCEEDED',
      limitMessage: 'Sweep history exceeds its persisted size limit',
    },
  );
  const findings = validateFindings(input.findings);
  const root = await openReportRoot(input.reportRoot);
  let lock;
  try {
    lock = await acquireLock(root.anchor);
    let history = await readHistory(root.anchor);
    const recovery = await recoverPendingCleanup(root.anchor, history);
    if (!recovery.complete) {
      throw historyError(
        'HISTORY_CLEANUP_PENDING',
        'Sweep history cannot advance while cleanup recovery is pending',
        { runIds: recovery.pendingRunIds },
      );
    }
    history = await readHistory(root.anchor);
    if (history.pendingCleanup !== undefined) {
      throw historyError('HISTORY_CLEANUP_PENDING', 'Cleanup intent remains pending');
    }
    const existing = history.runs.find((entry) => entry.runId === findings.runId);
    if (existing !== undefined) {
      const published = await openPublishedRun(root.anchor, findings.runId);
      try {
        const expected = historyEntry(findings, published);
        if (!sameHistoryEntry(existing, expected)) {
          throw historyError(
            'HISTORY_DUPLICATE_RUN',
            'Sweep history contains this run with different canonical content or identity',
          );
        }
        if (!await revalidatePinnedRun(published.run, null, published.markerToken)) {
          throw historyError('HISTORY_RUN_IDENTITY_INVALID', 'Published v2 run identity changed');
        }
        await verifyReportRoot(root);
        return deepFreeze(clone(history));
      } finally {
        await published.run.handle.close().catch(() => {});
      }
    }
    if (history.runs.length >= MAX_HISTORY_RUNS) {
      throw historyError('HISTORY_LIMIT_EXCEEDED', 'Sweep history run limit is exhausted');
    }
    const published = await openPublishedRun(root.anchor, findings.runId);
    try {
      const updated = {
        schemaVersion: '2.0',
        runs: [...history.runs.map(clone), historyEntry(findings, published)]
          .sort((left, right) => compareCodeUnits(left.runId, right.runId)),
      };
      if (!await revalidatePinnedRun(published.run, null, published.markerToken)) {
        throw historyError('HISTORY_RUN_IDENTITY_INVALID', 'Published v2 run identity changed');
      }
      await atomicWriteHistory(root.anchor, updated, {
        beforeRename: async () => {
          if (!await revalidatePinnedRun(published.run, null, published.markerToken)) {
            throw historyError('HISTORY_RUN_IDENTITY_INVALID', 'Published v2 run identity changed');
          }
        },
      });
      if (!await revalidatePinnedRun(published.run, null, published.markerToken)) {
        throw historyError('HISTORY_RUN_IDENTITY_INVALID', 'Published v2 run identity changed');
      }
      await verifyReportRoot(root);
      return deepFreeze(updated);
    } finally {
      await published.run.handle.close().catch(() => {});
    }
  } finally {
    await releaseLock(root.anchor, lock);
    await root.handle.close().catch(() => {});
  }
}

function summaryDelta(older, newer) {
  return Object.fromEntries(SUMMARY_KEYS.map((key) => [key, newer[key] - older[key]]));
}

/** Computes trend rows from persisted canonical summaries only. */
export function computeTrends(value) {
  const history = validateHistory(value);
  const runs = [...history.runs]
    .sort((left, right) => compareCodeUnits(left.runId, right.runId))
    .map((entry) => ({
      runId: entry.runId,
      coverageStatus: entry.coverageStatus,
      summary: clone(entry.summary),
    }));
  const deltas = [];
  for (let index = 1; index < runs.length; index += 1) {
    deltas.push({
      fromRunId: runs[index - 1].runId,
      toRunId: runs[index].runId,
      summary: summaryDelta(runs[index - 1].summary, runs[index].summary),
    });
  }
  const latestSummary = runs.length === 0
    ? { critical: 0, error: 0, warning: 0, info: 0, skipped: 0 }
    : clone(runs[runs.length - 1].summary);
  return deepFreeze({ runs, latestSummary, deltas });
}

/** Diffs stable finding identities while preserving each document's canonical summary. */
export function diffFindings(olderValue, newerValue) {
  const older = validateFindings(olderValue);
  const newer = validateFindings(newerValue);
  const olderIds = new Set(older.findings.map((finding) => finding.id));
  const newerIds = new Set(newer.findings.map((finding) => finding.id));
  return deepFreeze({
    olderRunId: older.runId,
    newerRunId: newer.runId,
    olderSummary: clone(older.summary),
    newerSummary: clone(newer.summary),
    added: [...newerIds].filter((id) => !olderIds.has(id)).sort(compareCodeUnits),
    resolved: [...olderIds].filter((id) => !newerIds.has(id)).sort(compareCodeUnits),
    persisting: [...newerIds].filter((id) => olderIds.has(id)).sort(compareCodeUnits),
  });
}

async function openPinnedRun(anchor, runId, expected = null, publicName = runId) {
  if (!RUN_ID.test(runId) || path.basename(runId) !== runId) {
    throw historyError('CLEAN_RUN_ID_INVALID', 'Cleanup run identifier is invalid');
  }
  if (publicName !== runId
      && (expected === null
        || publicName !== expected.tombstone
        || path.basename(publicName) !== publicName)) {
    throw historyError('CLEAN_RUN_ID_INVALID', 'Cleanup run path is invalid');
  }
  const publicPath = path.join(anchor, publicName);
  let initial;
  try {
    initial = await lstat(publicPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw historyError('CLEAN_RUN_INVALID', 'Cleanup run is not accessible');
  }
  if (expected !== null && (initial.isSymbolicLink() || !trustedDirectory(initial))) {
    return null;
  }
  if (initial.isSymbolicLink()) {
    throw historyError('CLEAN_RUN_SYMLINK', 'Cleanup run must not be a symbolic link');
  }
  if (!trustedDirectory(initial)) {
    throw historyError('CLEAN_RUN_INVALID', 'Cleanup run must be a directory');
  }
  if (expected !== null && !matchesRunFingerprint(initial, expected)) {
    return null;
  }
  let handle;
  try {
    handle = await open(publicPath, DIRECTORY_FLAGS);
    const identity = await handle.stat({ bigint: true });
    const current = await lstat(publicPath, { bigint: true });
    const pinnedPath = `/proc/self/fd/${handle.fd}`;
    const pinned = await lstat(`${pinnedPath}/.`, { bigint: true });
    if (!trustedDirectory(identity)
        || current.isSymbolicLink()
        || !trustedDirectory(current)
        || !sameIdentity(identity, initial)
        || !sameIdentity(current, identity)
        || !sameIdentity(pinned, identity)
        || (expected !== null && !matchesRunFingerprint(identity, expected))) {
      throw historyError('CLEAN_RUN_CHANGED', 'Cleanup run changed during descriptor pinning');
    }
    return { handle, identity, pinnedPath, publicPath, publicName, runId };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (expected !== null
        && ['ENOENT', 'ELOOP', 'ENOTDIR'].includes(error?.code)) return null;
    if (expected !== null
        && error instanceof SentinelError
        && ['CLEAN_RUN_CHANGED', 'CLEAN_RUN_INVALID', 'CLEAN_RUN_SYMLINK'].includes(error.code)) {
      return null;
    }
    if (error instanceof SentinelError) throw error;
    if (error?.code === 'ELOOP') {
      throw historyError('CLEAN_RUN_SYMLINK', 'Cleanup run must not be a symbolic link');
    }
    throw historyError('CLEAN_RUN_INVALID', 'Cleanup run could not be pinned safely');
  }
}

async function readRunMarkerRecord(run, expectedToken = null) {
  const markerPath = path.join(run.pinnedPath, RUN_MARKER_NAME);
  const marker = await readRegularFile(markerPath, {
    corruptCode: 'CLEAN_RUN_IDENTITY_INVALID',
    corruptMessage: 'Cleanup run identity marker is invalid',
    symlinkCode: 'CLEAN_RUN_IDENTITY_INVALID',
    symlinkMessage: 'Cleanup run identity marker must not be a symbolic link',
    readCode: 'CLEAN_RUN_IDENTITY_INVALID',
    readMessage: 'Cleanup run identity marker could not be read safely',
    maxBytes: 128,
  });
  const token = marker === null || !/^([a-f0-9]{64})\n$/u.test(marker.contents)
    ? null
    : marker.contents.slice(0, -1);
  if (token === null || (expectedToken !== null && token !== expectedToken)) {
    throw historyError('CLEAN_RUN_IDENTITY_INVALID', 'Cleanup run identity marker does not match');
  }
  return { identity: marker.identity, token };
}

async function readRunMarker(run, expectedToken = null) {
  return (await readRunMarkerRecord(run, expectedToken)).token;
}

async function revalidatePinnedRun(run, expected = null, markerToken = null) {
  let current;
  try {
    current = await lstat(run.publicPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw historyError('CLEAN_RUN_CHANGED', 'Cleanup run changed during verification');
  }
  const descriptor = await run.handle.stat({ bigint: true });
  const pinned = await lstat(`${run.pinnedPath}/.`, { bigint: true });
  if (!trustedDirectory(current)
      || !trustedDirectory(descriptor)
      || !trustedDirectory(pinned)
      || !sameIdentity(current, descriptor)
      || !sameIdentity(pinned, descriptor)
      || (expected !== null && !matchesRunFingerprint(descriptor, expected))) {
    return false;
  }
  if (markerToken !== null) {
    try {
      await readRunMarker(run, markerToken);
    } catch {
      return false;
    }
  }
  return true;
}

function purgeNodeKind(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  return null;
}

function trustedPurgeNode(stat, kind) {
  if (typeof process.geteuid !== 'function' || stat.uid !== BigInt(process.geteuid())) return false;
  if (kind === 'directory') return trustedDirectory(stat);
  if (kind === 'file') return trustedRegularFile(stat);
  return kind === 'symlink';
}

function purgeNodeRecord(relative, stat, kind) {
  return {
    relative,
    kind,
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeNs: String(stat.birthtimeNs),
    uid: String(stat.uid),
    mode: String(stat.mode),
  };
}

function matchesPurgeNode(stat, node) {
  return purgeNodeKind(stat) === node.kind
    && String(stat.dev) === node.dev
    && String(stat.ino) === node.ino
    && String(stat.birthtimeNs) === node.birthtimeNs
    && String(stat.uid) === node.uid
    && String(stat.mode) === node.mode;
}

async function boundedDirectoryNames(candidate, state, { markerAware = false } = {}) {
  const names = [];
  let markerPresent = false;
  let directory;
  try {
    directory = await opendir(candidate);
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      if (markerAware && entry.name === RUN_MARKER_NAME) {
        markerPresent = true;
        continue;
      }
      names.push(entry.name);
      if (state.nodes + names.length > MAX_PURGE_NODES) {
        throw historyError('CLEAN_LIMIT_EXCEEDED', 'Cleanup tree exceeds its node limit');
      }
    }
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    throw historyError('CLEAN_RUN_INVALID', 'Cleanup tree could not be inspected safely');
  } finally {
    await directory?.close().catch(() => {});
  }
  return { markerPresent, names: names.sort(compareCodeUnits) };
}

async function buildPurgePlan(run) {
  const state = { nodes: 0, pathUnits: 0 };
  const plan = [];
  const visit = async (relative, depth) => {
    if (depth > MAX_PURGE_DEPTH) {
      throw historyError('CLEAN_LIMIT_EXCEEDED', 'Cleanup tree exceeds its depth limit');
    }
    state.nodes += 1;
    state.pathUnits += relative.length;
    if (state.nodes > MAX_PURGE_NODES || state.pathUnits > MAX_PURGE_PATH_UNITS) {
      throw historyError('CLEAN_LIMIT_EXCEEDED', 'Cleanup tree exceeds its work limit');
    }
    const candidate = path.join(run.pinnedPath, relative);
    let identity;
    try {
      identity = await lstat(candidate, { bigint: true });
    } catch {
      throw historyError('CLEAN_RUN_INVALID', 'Cleanup tree changed during inspection');
    }
    const kind = purgeNodeKind(identity);
    if (kind === null || !trustedPurgeNode(identity, kind)) {
      throw historyError('CLEAN_RUN_INVALID', 'Cleanup tree contains an unsafe artifact');
    }
    if (kind === 'directory') {
      const children = await boundedDirectoryNames(candidate, state);
      for (const name of children.names) await visit(path.join(relative, name), depth + 1);
    }
    plan.push(purgeNodeRecord(relative, identity, kind));
  };
  const top = await boundedDirectoryNames(run.pinnedPath, state, { markerAware: true });
  for (const name of top.names) await visit(name, 1);
  return { markerPresent: top.markerPresent, nodes: plan };
}

async function removePurgePlan(run, plan) {
  for (const node of plan.nodes) {
    const candidate = path.join(run.pinnedPath, node.relative);
    let current;
    try {
      current = await lstat(candidate, { bigint: true });
    } catch {
      return false;
    }
    if (!matchesPurgeNode(current, node)) return false;
    try {
      if (node.kind === 'directory') await rmdir(candidate);
      else await unlink(candidate);
    } catch {
      return false;
    }
  }
  return true;
}

async function moveRunToTombstone(anchor, run, entry) {
  if (run.publicName === entry.tombstone) return true;
  if (!await revalidatePinnedRun(run, entry, entry.markerToken)) return false;
  const tombstonePath = path.join(anchor, entry.tombstone);
  if (await pathStat(tombstonePath) !== null) return false;
  try {
    await rename(run.publicPath, tombstonePath);
  } catch (error) {
    if (error?.code === 'CLEAN_DELETE_FAILED') throw error;
    return false;
  }
  run.publicName = entry.tombstone;
  run.publicPath = tombstonePath;
  if (!await revalidatePinnedRun(run, entry, entry.markerToken)) return false;
  await syncDirectory(anchor, 'CLEAN_DELETE_FAILED', 'Cleanup tombstone move is not durable');
  return true;
}

async function purgeTombstone(anchor, run, entry, purgePlan = null) {
  if (!await moveRunToTombstone(anchor, run, entry)) return false;
  try {
    const plan = purgePlan ?? await buildPurgePlan(run);
    const markerPresent = plan.markerPresent;
    let marker = null;
    if (markerPresent) marker = await readRunMarkerRecord(run, entry.markerToken);
    if (!markerPresent && plan.nodes.length > 0) return false;
    if (!await removePurgePlan(run, plan)) return false;
    const afterChildren = await buildPurgePlan(run);
    if (markerPresent) {
      if (!afterChildren.markerPresent || afterChildren.nodes.length !== 0) return false;
      if (!await revalidatePinnedRun(run, entry, entry.markerToken)) return false;
      if (!await unlinkExactFile(path.join(run.pinnedPath, RUN_MARKER_NAME), marker.identity)) {
        return false;
      }
      await syncDirectory(
        run.pinnedPath,
        'CLEAN_DELETE_FAILED',
        'Cleanup marker removal is not durable',
      );
    } else if (!await revalidatePinnedRun(run, entry)) {
      return false;
    }
    const empty = await buildPurgePlan(run);
    if (empty.markerPresent || empty.nodes.length !== 0) return false;
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    return false;
  }
  if (!await revalidatePinnedRun(run, entry)) return false;
  try {
    await rmdir(run.publicPath);
  } catch {
    return false;
  }
  const after = await run.handle.stat({ bigint: true });
  if (after.nlink !== 0n) return false;
  await syncDirectory(anchor, 'CLEAN_DELETE_FAILED', 'Cleanup directory removal is not durable');
  return true;
}

async function preflightPendingCleanup(anchor, pending) {
  const candidates = [];
  const pendingRunIds = [];
  let absentNeedsSync = false;
  try {
    for (const entry of pending.entries) {
      const original = await pathStat(path.join(anchor, entry.runId));
      const tombstone = await pathStat(path.join(anchor, entry.tombstone));
      if (original !== null && tombstone !== null) {
        pendingRunIds.push(entry.runId);
        continue;
      }
      if (original === null && tombstone === null) {
        absentNeedsSync = true;
        candidates.push({ entry, run: null });
        continue;
      }
      const publicName = tombstone === null ? entry.runId : entry.tombstone;
      const run = await openPinnedRun(anchor, entry.runId, entry, publicName);
      if (run === null) {
        pendingRunIds.push(entry.runId);
        continue;
      }
      let exact = false;
      let purgePlan = null;
      try {
        if (publicName === entry.runId) {
          await readRunMarker(run, entry.markerToken);
          exact = await revalidatePinnedRun(run, entry, entry.markerToken);
          if (exact) purgePlan = await buildPurgePlan(run);
        } else {
          purgePlan = await buildPurgePlan(run);
          if (purgePlan.markerPresent) {
            await readRunMarker(run, entry.markerToken);
            exact = await revalidatePinnedRun(run, entry, entry.markerToken);
          } else {
            exact = purgePlan.nodes.length === 0 && await revalidatePinnedRun(run, entry);
          }
        }
      } catch (error) {
        if (error?.code === 'CLEAN_LIMIT_EXCEEDED') {
          await run.handle.close().catch(() => {});
          throw error;
        }
        exact = false;
      }
      if (exact) {
        candidates.push({ entry, purgePlan, run });
      } else {
        pendingRunIds.push(entry.runId);
        await run.handle.close().catch(() => {});
      }
    }
    if (pendingRunIds.length > 0) {
      for (const candidate of candidates) await candidate.run?.handle.close().catch(() => {});
      return { absentNeedsSync, candidates: [], complete: false, pendingRunIds };
    }
    return { absentNeedsSync, candidates, complete: true, pendingRunIds: [] };
  } catch (error) {
    for (const candidate of candidates) await candidate.run?.handle.close().catch(() => {});
    throw error;
  }
}

async function recoverPendingCleanup(anchor, history) {
  const pending = history.pendingCleanup;
  if (pending === undefined) return { complete: true, history, pendingRunIds: [] };
  const preflight = await preflightPendingCleanup(anchor, pending);
  if (!preflight.complete) {
    return { complete: false, history, pendingRunIds: preflight.pendingRunIds };
  }
  try {
    for (let index = 0; index < preflight.candidates.length; index += 1) {
      const candidate = preflight.candidates[index];
      if (candidate.run === null) continue;
      if (!await purgeTombstone(
        anchor,
        candidate.run,
        candidate.entry,
        candidate.purgePlan,
      )) {
        return {
          complete: false,
          history,
          pendingRunIds: preflight.candidates
            .slice(index)
            .map(({ entry }) => entry.runId),
        };
      }
    }
  } finally {
    for (const candidate of preflight.candidates) {
      await candidate.run?.handle.close().catch(() => {});
    }
  }
  if (preflight.absentNeedsSync) {
    await syncDirectory(anchor, 'CLEAN_DELETE_FAILED', 'Cleanup absence is not durable');
  }
  const recovered = { schemaVersion: '2.0', runs: history.runs.map(clone) };
  await atomicWriteHistory(anchor, recovered);
  return { complete: true, history: deepFreeze(recovered), pendingRunIds: [] };
}

/** Removes old direct-child run directories without following symlinks. */
export async function cleanRuns(options = {}) {
  const input = snapshotOptions(
    options,
    'CLEAN_INPUT_INVALID',
    'Cleanup options must be recursively plain own-data JSON',
  );
  if (!Number.isInteger(input.keep) || input.keep < 1) {
    throw historyError('CLEAN_KEEP_INVALID', 'Retention count must be a positive integer');
  }
  const root = await openReportRoot(input.reportRoot);
  let lock;
  const pinnedRuns = new Map();
  try {
    lock = await acquireLock(root.anchor);
    let history = await readHistory(root.anchor);
    const recovery = await recoverPendingCleanup(root.anchor, history);
    if (!recovery.complete) {
      throw historyError(
        'CLEAN_PURGE_PENDING',
        'Cleanup recovery remains pending and requires operator intervention',
        { runIds: recovery.pendingRunIds },
      );
    }
    history = await readHistory(root.anchor);
    if (history.pendingCleanup !== undefined) {
      throw historyError('CLEAN_PURGE_PENDING', 'Cleanup intent remains pending');
    }
    const names = await readdir(root.anchor);
    const directRunIds = names.filter((name) => RUN_ID.test(name)).sort(compareCodeUnits);
    const historyRunIds = history.runs.map((entry) => entry.runId).sort(compareCodeUnits);
    const historyIds = new Set(historyRunIds);
    const strayTombstones = names.filter((name) => TOMBSTONE_NAME.test(name));
    if (historyRunIds.some((runId) => !directRunIds.includes(runId))
        || directRunIds.some((runId) => !historyIds.has(runId))
        || strayTombstones.length > 0) {
      throw historyError(
        'CLEAN_HISTORY_MISMATCH',
        'Cleanup requires exact history/direct-child agreement with no unowned tombstones',
      );
    }
    for (const entry of history.runs) {
      const pinned = await openPinnedRun(root.anchor, entry.runId, entry);
      if (pinned === null) {
        throw historyError('CLEAN_HISTORY_MISMATCH', 'Tracked cleanup run is missing');
      }
      try {
        await readRunMarker(pinned, entry.markerToken);
      } catch (error) {
        await pinned.handle.close().catch(() => {});
        throw error;
      }
      pinnedRuns.set(entry.runId, pinned);
    }
    const kept = historyRunIds.slice(-input.keep);
    const removed = historyRunIds.slice(0, Math.max(0, historyRunIds.length - input.keep));
    if (removed.length === 0) {
      await verifyReportRoot(root);
      for (const entry of history.runs) {
        if (!await revalidatePinnedRun(
          pinnedRuns.get(entry.runId),
          entry,
          entry.markerToken,
        )) {
          throw historyError('CLEAN_RUN_CHANGED', 'Tracked run changed during cleanup preflight');
        }
      }
      return deepFreeze({ kept, removed });
    }
    if (removed.length > MAX_CLEAN_ENTRIES) {
      throw historyError('CLEAN_LIMIT_EXCEEDED', 'Cleanup run count exceeds its safe limit');
    }
    for (const runId of removed) {
      const plan = await buildPurgePlan(pinnedRuns.get(runId));
      if (!plan.markerPresent) {
        throw historyError(
          'CLEAN_RUN_IDENTITY_INVALID',
          'Tracked cleanup run lost its publication marker',
        );
      }
    }
    const removedSet = new Set(removed);
    const transactionId = randomBytes(12).toString('hex');
    if (!TRANSACTION_ID.test(transactionId)) {
      throw historyError('CLEAN_STATE_INVALID', 'Cleanup transaction identifier is invalid');
    }
    const pendingEntries = history.runs
      .filter((entry) => removedSet.has(entry.runId))
      .map((entry, index) => ({
        runId: entry.runId,
        tombstone: `.sentinel-clean-${transactionId}-${String(index).padStart(4, '0')}`,
        markerToken: entry.markerToken,
        dev: entry.dev,
        ino: entry.ino,
        birthtimeNs: entry.birthtimeNs,
        uid: entry.uid,
        mode: entry.mode,
      }));
    const targetHistory = {
      schemaVersion: '2.0',
      runs: history.runs.filter((entry) => !removedSet.has(entry.runId)).map(clone),
      pendingCleanup: { transactionId, entries: pendingEntries },
    };
    serializedHistory(targetHistory);
    for (const entry of history.runs) {
      if (!await revalidatePinnedRun(
        pinnedRuns.get(entry.runId),
        entry,
        entry.markerToken,
      )) {
        throw historyError('CLEAN_RUN_CHANGED', 'Tracked run changed before cleanup commit');
      }
    }
    await atomicWriteHistory(root.anchor, targetHistory, {
      beforeRename: async () => {
        for (const entry of history.runs) {
          if (!await revalidatePinnedRun(
            pinnedRuns.get(entry.runId),
            entry,
            entry.markerToken,
          )) {
            throw historyError('CLEAN_RUN_CHANGED', 'Tracked run changed at cleanup commit');
          }
        }
      },
    });
    const cleanup = await recoverPendingCleanup(root.anchor, targetHistory);
    if (!cleanup.complete) {
      await verifyReportRoot(root);
      throw historyError(
        'CLEAN_PURGE_PENDING',
        'Cleanup is logically committed but physical purge remains pending',
        { runIds: cleanup.pendingRunIds, kept, removed },
      );
    }
    history = await readHistory(root.anchor);
    if (history.pendingCleanup !== undefined) {
      throw historyError('CLEAN_PURGE_PENDING', 'Cleanup intent remains pending after recovery');
    }
    for (const entry of history.runs) {
      if (!await revalidatePinnedRun(
        pinnedRuns.get(entry.runId),
        entry,
        entry.markerToken,
      )) {
        throw historyError('CLEAN_RUN_CHANGED', 'Kept run changed during cleanup');
      }
    }
    await verifyReportRoot(root);
    return deepFreeze({ kept, removed });
  } finally {
    for (const pinned of pinnedRuns.values()) await pinned.handle.close().catch(() => {});
    await releaseLock(root.anchor, lock);
    await root.handle.close().catch(() => {});
  }
}
