import { randomBytes } from 'node:crypto';
import { constants as fsConstants, readFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';

import { SentinelError } from './lib/errors.mjs';
import { validateAgainstSchema } from './lib/schema.mjs';

const FINDINGS_SCHEMA = JSON.parse(
  readFileSync(new URL('../schemas/findings.schema.json', import.meta.url), 'utf8'),
);
const HISTORY_SCHEMA = JSON.parse(
  readFileSync(new URL('../schemas/sweep-history.schema.json', import.meta.url), 'utf8'),
);
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z(?:-[a-f0-9]{8})?$/u;
const LOCK_NAME = 'sweep-history.lock';
const HISTORY_NAME = 'sweep-history.json';
const LOCK_TIMEOUT_MS = 5000;
const READ_FLAGS = fsConstants.O_RDONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);
const CREATE_FLAGS = fsConstants.O_CREAT
  | fsConstants.O_EXCL
  | fsConstants.O_WRONLY
  | (fsConstants.O_NOFOLLOW ?? 0)
  | (fsConstants.O_CLOEXEC ?? 0);
const SUMMARY_KEYS = ['critical', 'error', 'warning', 'info', 'skipped'];

function historyError(code, message) {
  return new SentinelError(code, message);
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`));
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function validateFindings(findings, code = 'HISTORY_FINDINGS_INVALID') {
  try {
    validateAgainstSchema(findings, FINDINGS_SCHEMA, { name: 'findings' });
  } catch {
    throw historyError(code, 'History input is not a canonical findings document');
  }
  if (!RUN_ID.test(findings.runId)) {
    throw historyError(code, 'History input contains an invalid run identifier');
  }
  const ids = findings.findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) {
    throw historyError(code, 'History input contains duplicate finding identifiers');
  }
}

function validateHistory(history) {
  try {
    validateAgainstSchema(history, HISTORY_SCHEMA, { name: 'history' });
  } catch {
    throw historyError('HISTORY_CORRUPT', 'Sweep history is corrupt or invalid');
  }
  const runIds = history.runs.map((entry) => entry.runId);
  if (new Set(runIds).size !== runIds.length
      || runIds.some((runId) => !RUN_ID.test(runId))) {
    throw historyError('HISTORY_CORRUPT', 'Sweep history contains invalid run identifiers');
  }
}

async function canonicalReportRoot(reportRoot, { create }) {
  if (typeof reportRoot !== 'string' || reportRoot.length === 0 || reportRoot.includes('\0')) {
    throw historyError('REPORT_ROOT_INVALID', 'Report root is invalid');
  }
  const resolved = path.resolve(reportRoot);
  if (create) {
    try {
      await mkdir(resolved, { recursive: true, mode: 0o700 });
    } catch {
      throw historyError('REPORT_ROOT_INVALID', 'Report root could not be created');
    }
  }
  let rootStat;
  try {
    rootStat = await lstat(resolved);
  } catch {
    throw historyError('REPORT_ROOT_INVALID', 'Report root is not accessible');
  }
  if (rootStat.isSymbolicLink()) {
    throw historyError('REPORT_ROOT_SYMLINK', 'Report root must not be a symbolic link');
  }
  if (!rootStat.isDirectory()) {
    throw historyError('REPORT_ROOT_INVALID', 'Report root must be a directory');
  }
  let canonical;
  try {
    canonical = await realpath(resolved);
  } catch {
    throw historyError('REPORT_ROOT_INVALID', 'Report root could not be canonicalized');
  }
  return canonical;
}

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLock(root) {
  const lockPath = path.join(root, LOCK_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    let handle;
    try {
      handle = await open(lockPath, CREATE_FLAGS, 0o600);
      await handle.chmod(0o600);
      await handle.writeFile(`${process.pid} ${randomBytes(16).toString('hex')}\n`, 'utf8');
      await handle.sync();
      const identity = await handle.stat();
      return { handle, identity, path: lockPath };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== 'EEXIST' && error?.code !== 'ELOOP') {
        throw historyError('HISTORY_LOCK_FAILED', 'Sweep history lock could not be acquired');
      }
      let current;
      try {
        current = await lstat(lockPath);
      } catch (inspectError) {
        if (inspectError?.code === 'ENOENT') continue;
        throw historyError('HISTORY_LOCK_FAILED', 'Sweep history lock could not be inspected');
      }
      if (current.isSymbolicLink() || !current.isFile()) {
        throw historyError('HISTORY_LOCK_INVALID', 'Sweep history lock path is unsafe');
      }
      if (Date.now() >= deadline) {
        throw historyError('HISTORY_LOCK_TIMEOUT', 'Timed out waiting for sweep history lock');
      }
      await pause(10);
    }
  }
}

async function releaseLock(lock) {
  await lock.handle.close().catch(() => {});
  let current;
  try {
    current = await lstat(lock.path);
  } catch {
    return;
  }
  if (!current.isSymbolicLink()
      && current.isFile()
      && current.dev === lock.identity.dev
      && current.ino === lock.identity.ino) {
    await unlink(lock.path).catch(() => {});
  }
}

async function readHistory(root) {
  const historyPath = path.join(root, HISTORY_NAME);
  let historyStat;
  try {
    historyStat = await lstat(historyPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: '2.0', runs: [] };
    throw historyError('HISTORY_READ_FAILED', 'Sweep history could not be inspected');
  }
  if (historyStat.isSymbolicLink()) {
    throw historyError('HISTORY_SYMLINK', 'Sweep history must not be a symbolic link');
  }
  if (!historyStat.isFile()) {
    throw historyError('HISTORY_CORRUPT', 'Sweep history is not a regular file');
  }

  let handle;
  let contents;
  try {
    handle = await open(historyPath, READ_FLAGS);
    const opened = await handle.stat();
    if (!opened.isFile()) throw historyError('HISTORY_CORRUPT', 'Sweep history is invalid');
    contents = await handle.readFile('utf8');
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    if (error?.code === 'ELOOP') {
      throw historyError('HISTORY_SYMLINK', 'Sweep history must not be a symbolic link');
    }
    throw historyError('HISTORY_READ_FAILED', 'Sweep history could not be read');
  } finally {
    await handle?.close().catch(() => {});
  }

  let history;
  try {
    history = JSON.parse(contents);
  } catch {
    throw historyError('HISTORY_CORRUPT', 'Sweep history is not valid JSON');
  }
  validateHistory(history);
  return history;
}

async function syncDirectory(root) {
  let handle;
  try {
    handle = await open(root, fsConstants.O_RDONLY | (fsConstants.O_CLOEXEC ?? 0));
    await handle.sync();
  } catch {
    throw historyError('HISTORY_WRITE_FAILED', 'Sweep history directory could not be synchronized');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicWriteHistory(root, history) {
  validateHistory(history);
  const destination = path.join(root, HISTORY_NAME);
  const temporary = path.join(
    root,
    `.sweep-history.${process.pid}.${randomBytes(16).toString('hex')}.tmp`,
  );
  let handle;
  try {
    let destinationStat;
    try {
      destinationStat = await lstat(destination);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (destinationStat?.isSymbolicLink()) {
      throw historyError('HISTORY_SYMLINK', 'Sweep history must not be a symbolic link');
    }
    if (destinationStat !== undefined && !destinationStat.isFile()) {
      throw historyError('HISTORY_CORRUPT', 'Sweep history is not a regular file');
    }

    handle = await open(temporary, CREATE_FLAGS, 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(history, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await syncDirectory(root);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (error instanceof SentinelError) throw error;
    throw historyError('HISTORY_WRITE_FAILED', 'Sweep history could not be written atomically');
  }
}

function historyEntry(findings) {
  return {
    runId: findings.runId,
    startedAt: findings.startedAt,
    finishedAt: findings.finishedAt,
    coverageStatus: findings.coverage.status,
    summary: clone(findings.summary),
  };
}

/** Appends one completed canonical run under an exclusive, atomic history lock. */
export async function appendHistory({ reportRoot, findings } = {}) {
  validateFindings(findings);
  const root = await canonicalReportRoot(reportRoot, { create: true });
  const lock = await acquireLock(root);
  try {
    const history = await readHistory(root);
    if (history.runs.some((entry) => entry.runId === findings.runId)) {
      throw historyError('HISTORY_DUPLICATE_RUN', 'Sweep history already contains this run');
    }
    const updated = {
      schemaVersion: '2.0',
      runs: [...history.runs.map(clone), historyEntry(findings)]
        .sort((left, right) => compareCodeUnits(left.runId, right.runId)),
    };
    await atomicWriteHistory(root, updated);
    return deepFreeze(updated);
  } finally {
    await releaseLock(lock);
  }
}

function summaryDelta(older, newer) {
  return Object.fromEntries(SUMMARY_KEYS.map((key) => [key, newer[key] - older[key]]));
}

/** Computes trend rows from persisted canonical summaries only. */
export function computeTrends(history) {
  validateHistory(history);
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
export function diffFindings(older, newer) {
  validateFindings(older);
  validateFindings(newer);
  const olderIds = new Set(older.findings.map((finding) => finding.id));
  const newerIds = new Set(newer.findings.map((finding) => finding.id));
  const added = [...newerIds].filter((id) => !olderIds.has(id)).sort(compareCodeUnits);
  const resolved = [...olderIds].filter((id) => !newerIds.has(id)).sort(compareCodeUnits);
  const persisting = [...newerIds].filter((id) => olderIds.has(id)).sort(compareCodeUnits);
  return deepFreeze({
    olderRunId: older.runId,
    newerRunId: newer.runId,
    olderSummary: clone(older.summary),
    newerSummary: clone(newer.summary),
    added,
    resolved,
    persisting,
  });
}

async function inspectRun(root, runId) {
  if (!RUN_ID.test(runId) || path.basename(runId) !== runId) {
    throw historyError('CLEAN_RUN_ID_INVALID', 'Cleanup run identifier is invalid');
  }
  const candidate = path.join(root, runId);
  let candidateStat;
  try {
    candidateStat = await lstat(candidate);
  } catch {
    throw historyError('CLEAN_RUN_INVALID', 'Cleanup run is not accessible');
  }
  if (candidateStat.isSymbolicLink()) {
    throw historyError('CLEAN_RUN_SYMLINK', 'Cleanup run must not be a symbolic link');
  }
  if (!candidateStat.isDirectory()) {
    throw historyError('CLEAN_RUN_INVALID', 'Cleanup run must be a directory');
  }
  let canonical;
  try {
    canonical = await realpath(candidate);
  } catch {
    throw historyError('CLEAN_RUN_INVALID', 'Cleanup run could not be canonicalized');
  }
  if (!isWithin(root, canonical) || path.dirname(canonical) !== root) {
    throw historyError('CLEAN_RUN_ESCAPE', 'Cleanup run escapes the report root');
  }
  return candidate;
}

async function restoreQuarantines(quarantines) {
  for (const entry of [...quarantines].reverse()) {
    try {
      await rename(entry.quarantine, entry.original);
    } catch {
      // A failed cleanup remains failed; never broaden recovery beyond exact paths.
    }
  }
}

async function quarantineRuns(root, runIds) {
  const inspected = [];
  for (const runId of runIds) {
    inspected.push({ runId, original: await inspectRun(root, runId) });
  }
  const quarantines = [];
  try {
    for (const entry of inspected) {
      const quarantine = path.join(
        root,
        `.sentinel-clean-${entry.runId}-${randomBytes(12).toString('hex')}`,
      );
      await rename(entry.original, quarantine);
      const moved = { ...entry, quarantine };
      quarantines.push(moved);
      const movedStat = await lstat(quarantine);
      if (movedStat.isSymbolicLink()) {
        throw historyError('CLEAN_RUN_SYMLINK', 'Cleanup run changed into a symbolic link');
      }
      if (!movedStat.isDirectory()) {
        throw historyError('CLEAN_RUN_INVALID', 'Cleanup run changed type during quarantine');
      }
    }
    return quarantines;
  } catch (error) {
    await restoreQuarantines(quarantines);
    if (error instanceof SentinelError) throw error;
    throw historyError('CLEAN_QUARANTINE_FAILED', 'Cleanup run could not be quarantined safely');
  }
}

/** Removes old direct-child run directories without following symlinks. */
export async function cleanRuns({ reportRoot, keep } = {}) {
  if (!Number.isInteger(keep) || keep < 1) {
    throw historyError('CLEAN_KEEP_INVALID', 'Retention count must be a positive integer');
  }
  const root = await canonicalReportRoot(reportRoot, { create: false });
  const lock = await acquireLock(root);
  try {
    const history = await readHistory(root);
    let names;
    try {
      names = await readdir(root);
    } catch {
      throw historyError('CLEAN_READ_FAILED', 'Report root could not be enumerated');
    }
    const runIds = names.filter((name) => RUN_ID.test(name)).sort(compareCodeUnits);
    const kept = runIds.slice(-keep);
    const removed = runIds.slice(0, Math.max(0, runIds.length - keep));
    if (removed.length === 0) return deepFreeze({ kept, removed });

    const quarantines = await quarantineRuns(root, removed);
    for (let index = 0; index < quarantines.length; index += 1) {
      try {
        await rm(quarantines[index].quarantine, { recursive: true, force: false, maxRetries: 0 });
      } catch {
        await restoreQuarantines(quarantines.slice(index));
        throw historyError('CLEAN_DELETE_FAILED', 'Quarantined run could not be deleted');
      }
    }

    const removedSet = new Set(removed);
    const updatedHistory = {
      schemaVersion: '2.0',
      runs: history.runs.filter((entry) => !removedSet.has(entry.runId)).map(clone),
    };
    await atomicWriteHistory(root, updatedHistory);
    return deepFreeze({ kept, removed });
  } finally {
    await releaseLock(lock);
  }
}
