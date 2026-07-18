import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import fsPromises, {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendHistory as appendHistoryRuntime,
  cleanRuns,
  computeTrends,
  diffFindings,
} from '../../runtime/history.mjs';
import { findingId } from '../../runtime/lib/identity.mjs';
import {
  renderDashboard,
  renderMarkdown,
  renderPrComment,
  summaryExitCode,
} from '../../runtime/report.mjs';

const canonical = JSON.parse(
  await readFile(new URL('../fixtures/report/canonical-findings.json', import.meta.url), 'utf8'),
);
const manifestFixture = JSON.parse(
  await readFile(
    new URL('../fixtures/discovery/openapi-complete.manifest.json', import.meta.url),
    'utf8',
  ),
);
const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z(?:-[a-f0-9]{8})?$/u;
const RUN_MARKER_NAME = '.sentinel-run-identity-v2';
const TOMBSTONE_NAME = /^\.sentinel-clean-[a-f0-9]{24}-[0-9]{4}$/u;
const RELEASED_V1_RUN_GLOB = /^....-..-..T..-..-..Z$/u;

function run(findings, runId, summary = findings.summary) {
  return {
    ...structuredClone(findings),
    runId,
    summary: structuredClone(summary),
  };
}

async function temporaryRoot(t, prefix) {
  const parent = await mkdtemp(path.join(os.tmpdir(), prefix));
  const root = path.join(parent, 'sentinel-v2');
  await mkdir(root, { mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return root;
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurableFile(candidate, contents) {
  const handle = await open(candidate, 'wx', 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function publishTestRun(reportRoot, runId, artifacts = {}) {
  assert.match(runId, RUN_ID);
  const staging = path.join(
    reportRoot,
    `.sentinel-run-staging-${randomBytes(32).toString('hex')}`,
  );
  const destination = path.join(reportRoot, runId);
  const markerToken = randomBytes(32).toString('hex');
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeDurableFile(path.join(staging, RUN_MARKER_NAME), `${markerToken}\n`);
    for (const [name, contents] of Object.entries(artifacts)) {
      assert.equal(path.basename(name), name);
      await writeDurableFile(path.join(staging, name), contents);
    }
    await syncDirectory(staging);
    await assert.rejects(access(destination, fsConstants.F_OK));
    await rename(staging, destination);
    await syncDirectory(reportRoot);
    return markerToken;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function appendPublished(reportRoot, findings, artifacts = {}) {
  const manifest = { ...structuredClone(manifestFixture), generatedAt: findings.manifestGeneratedAt };
  await publishTestRun(reportRoot, findings.runId, {
    'sentinel-manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'sentinel-findings.json': `${JSON.stringify(findings, null, 2)}\n`,
    'sweep.md': renderMarkdown(findings),
    'dashboard.html': renderDashboard(findings),
    'pr-comment.md': renderPrComment(findings),
    ...artifacts,
  });
  return appendHistoryRuntime({ reportRoot, findings });
}

async function readHistory(reportRoot) {
  return JSON.parse(await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8'));
}

function fixtureIdentity(index = 1) {
  return {
    findingsDigest: (index + 256).toString(16).padStart(64, '0'),
    markerToken: index.toString(16).padStart(64, '0'),
    dev: '1',
    ino: String(index),
    birthtimeNs: String(index),
    uid: '1000',
    mode: '16832',
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function findingsDigest(findings) {
  return createHash('sha256').update(canonicalJson(findings)).digest('hex');
}

function parseMarkdownSummary(markdown) {
  const labels = ['Critical', 'Error', 'Warning', 'Info', 'Skipped'];
  return Object.fromEntries(labels.map((label) => {
    const match = new RegExp(`\\| ${label} \\| ([0-9]+) \\|`, 'u').exec(markdown);
    assert.ok(match, label);
    return [label.toLowerCase(), Number(match[1])];
  }));
}

function parseDashboardSummary(dashboard) {
  const match = /<script id="sentinel-summary" type="application\/json">([\s\S]*?)<\/script>/u
    .exec(dashboard);
  assert.ok(match);
  return JSON.parse(match[1]);
}

async function commitPendingWithoutMove(reportRoot, keep = 1) {
  const originalRename = fsPromises.rename;
  let blocked = false;
  fsPromises.rename = async (source, destination) => {
    if (TOMBSTONE_NAME.test(path.basename(destination))) {
      blocked = true;
      const error = new Error('injected tombstone move failure');
      error.code = 'EACCES';
      throw error;
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      cleanRuns({ reportRoot, keep }),
      (error) => error?.code === 'CLEAN_PURGE_PENDING',
    );
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(blocked, true);
  const history = await readHistory(reportRoot);
  assert.ok(history.pendingCleanup);
  return history;
}

async function processStartMarker(pid = process.pid) {
  const contents = await readFile(`/proc/${pid}/stat`, 'utf8');
  const close = contents.lastIndexOf(')');
  return contents.slice(close + 2).trim().split(/\s+/u)[19];
}

test('requires immutable publication identity in non-empty v2 history fixtures', async () => {
  const history = JSON.parse(
    await readFile(new URL('../fixtures/sample-sweep-history.json', import.meta.url), 'utf8'),
  );
  assert.doesNotThrow(() => computeTrends(history));
  for (const entry of history.runs) {
    assert.match(entry.findingsDigest, /^[a-f0-9]{64}$/u);
    assert.match(entry.markerToken, /^[a-f0-9]{64}$/u);
    assert.match(entry.birthtimeNs, /^\d+$/u);
  }
});

test('keeps reports, history, trends, diff, and CI on the canonical summary', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-report-consistency-');
  const older = run(canonical, '2026-07-18T11-59-58-000Z', {
    critical: 1, error: 1, warning: 1, info: 0, skipped: 0,
  });
  const oldCritical = structuredClone(canonical.findings[0]);
  oldCritical.role = 'guest';
  oldCritical.id = findingId({
    subjectType: oldCritical.subject.type,
    subjectId: oldCritical.subject.id,
    service: oldCritical.service ?? null,
    role: oldCritical.role,
    category: oldCritical.category,
    reasonCode: oldCritical.reasonCode,
    viewport: null,
    diagnosticSourcePath: null,
    diagnosticPointer: null,
  });
  older.findings = [
    oldCritical,
    structuredClone(canonical.findings[1]),
    structuredClone(canonical.findings[2]),
  ];
  await publishTestRun(reportRoot, older.runId);
  await publishTestRun(reportRoot, canonical.runId);
  await Promise.all([
    appendHistoryRuntime({ reportRoot, findings: canonical }),
    appendHistoryRuntime({ reportRoot, findings: older }),
  ]);

  const historyPath = path.join(reportRoot, 'sweep-history.json');
  const history = await readHistory(reportRoot);
  assert.deepEqual(history.runs.map((entry) => entry.runId), [older.runId, canonical.runId]);
  assert.deepEqual(history.runs.map((entry) => entry.summary), [older.summary, canonical.summary]);
  assert.equal((await stat(historyPath)).mode & 0o777, 0o600);
  assert.ok(history.runs.every((entry) => /^[a-f0-9]{64}$/u.test(entry.markerToken)));

  const trends = computeTrends(history);
  assert.deepEqual(trends.latestSummary, canonical.summary);
  assert.deepEqual(trends.deltas, [{
    fromRunId: older.runId,
    toRunId: canonical.runId,
    summary: { critical: 0, error: 0, warning: 0, info: 0, skipped: 1 },
  }]);
  const difference = diffFindings(older, canonical);
  assert.deepEqual(difference.added, [
    canonical.findings[0].id,
    canonical.findings[3].id,
  ].sort());
  assert.deepEqual(difference.resolved, [oldCritical.id]);
  assert.deepEqual(parseMarkdownSummary(renderMarkdown(canonical)), canonical.summary);
  assert.deepEqual(parseDashboardSummary(renderDashboard(canonical)), canonical.summary);
  assert.match(renderPrComment(canonical), /Critical 1/u);
  assert.equal(summaryExitCode(canonical), 2);
});

test('serializes concurrent history appends without lost updates', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-concurrent-');
  const runs = Array.from({ length: 8 }, (_, index) => run(
    canonical,
    `2026-07-18T12-00-${String(index).padStart(2, '0')}-000Z`,
  ));
  await Promise.all(runs.map((findings) => publishTestRun(reportRoot, findings.runId)));
  await Promise.all(runs.map((findings) => appendHistoryRuntime({ reportRoot, findings })));
  const history = await readHistory(reportRoot);
  assert.deepEqual(history.runs.map((entry) => entry.runId), runs.map((entry) => entry.runId));
  assert.equal(new Set(history.runs.map((entry) => entry.markerToken)).size, runs.length);
  assert.deepEqual(
    (await readdir(reportRoot)).filter((name) => name.startsWith('.sweep-history-lock-')),
    [],
  );
});

test('requires a marker-bound published run and persists its exact identity', async (t) => {
  const missingRoot = await temporaryRoot(t, 'sentinel-history-marker-missing-');
  await mkdir(path.join(missingRoot, canonical.runId), { mode: 0o700 });
  await assert.rejects(
    appendHistoryRuntime({ reportRoot: missingRoot, findings: canonical }),
    (error) => error?.code === 'CLEAN_RUN_IDENTITY_INVALID',
  );
  await assert.rejects(access(path.join(missingRoot, 'sweep-history.json'), fsConstants.F_OK));

  const reportRoot = await temporaryRoot(t, 'sentinel-history-marker-bound-');
  const token = await publishTestRun(reportRoot, canonical.runId, { 'report.md': 'durable\n' });
  const identity = await stat(path.join(reportRoot, canonical.runId), { bigint: true });
  const history = await appendHistoryRuntime({ reportRoot, findings: canonical });
  assert.deepEqual(history.runs[0], {
    runId: canonical.runId,
    startedAt: canonical.startedAt,
    finishedAt: canonical.finishedAt,
    coverageStatus: canonical.coverage.status,
    summary: canonical.summary,
    findingsDigest: findingsDigest(canonical),
    markerToken: token,
    dev: String(identity.dev),
    ino: String(identity.ino),
    birthtimeNs: String(identity.birthtimeNs),
    uid: String(identity.uid),
    mode: String(identity.mode),
  });
});

test('rejects corrupt, duplicate, symlinked, and invalid history updates', async (t) => {
  const corruptRoot = await temporaryRoot(t, 'sentinel-history-corrupt-');
  const corruptPath = path.join(corruptRoot, 'sweep-history.json');
  await writeFile(corruptPath, '{not json\n', { mode: 0o600 });
  const corruptBefore = await readFile(corruptPath, 'utf8');
  await assert.rejects(
    appendHistoryRuntime({ reportRoot: corruptRoot, findings: canonical }),
    (error) => error?.code === 'HISTORY_CORRUPT',
  );
  assert.equal(await readFile(corruptPath, 'utf8'), corruptBefore);

  const duplicateRoot = await temporaryRoot(t, 'sentinel-history-duplicate-');
  const firstHistory = await appendPublished(duplicateRoot, canonical);
  const duplicateBefore = await readFile(path.join(duplicateRoot, 'sweep-history.json'), 'utf8');
  assert.deepEqual(
    await appendHistoryRuntime({ reportRoot: duplicateRoot, findings: canonical }),
    firstHistory,
  );
  const mismatched = structuredClone(canonical);
  mismatched.findings[0].message = 'Same run identifier, different canonical finding content';
  await assert.rejects(
    appendHistoryRuntime({ reportRoot: duplicateRoot, findings: mismatched }),
    (error) => error?.code === 'HISTORY_DUPLICATE_RUN',
  );
  assert.equal(await readFile(path.join(duplicateRoot, 'sweep-history.json'), 'utf8'), duplicateBefore);

  const symlinkRoot = await temporaryRoot(t, 'sentinel-history-symlink-');
  const external = path.join(await temporaryRoot(t, 'sentinel-history-external-'), 'history.json');
  await writeFile(external, '{"outside":true}\n', { mode: 0o600 });
  await symlink(external, path.join(symlinkRoot, 'sweep-history.json'));
  await assert.rejects(
    appendHistoryRuntime({ reportRoot: symlinkRoot, findings: canonical }),
    (error) => error?.code === 'HISTORY_SYMLINK',
  );
  assert.equal(await readFile(external, 'utf8'), '{"outside":true}\n');

  const invalid = structuredClone(canonical);
  invalid.schemaVersion = '1.0';
  await assert.rejects(
    appendHistoryRuntime({ reportRoot: symlinkRoot, findings: invalid }),
    (error) => error?.code === 'HISTORY_FINDINGS_INVALID',
  );
});

test('retries an exact append after committed history durability became uncertain', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-append-uncertain-');
  await publishTestRun(reportRoot, canonical.runId);
  const originalOpen = fsPromises.open;
  const originalRename = fsPromises.rename;
  let historyRenamed = false;
  fsPromises.rename = async (source, destination) => {
    const result = await originalRename(source, destination);
    if (path.basename(destination) === 'sweep-history.json') historyRenamed = true;
    return result;
  };
  fsPromises.open = async (candidate, ...arguments_) => {
    const handle = await originalOpen(candidate, ...arguments_);
    if (historyRenamed && String(candidate).endsWith('/.')) {
      handle.sync = async () => {
        const error = new Error('injected append root sync failure');
        error.code = 'EIO';
        throw error;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      appendHistoryRuntime({ reportRoot, findings: canonical }),
      (error) => error?.code === 'HISTORY_WRITE_FAILED'
        && error.details?.committed === true
        && error.details?.durable === false,
    );
  } finally {
    fsPromises.open = originalOpen;
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(historyRenamed, true);
  const retried = await appendHistoryRuntime({ reportRoot, findings: canonical });
  assert.deepEqual(retried.runs.map((entry) => entry.runId), [canonical.runId]);
  const mismatched = structuredClone(canonical);
  mismatched.findings[0].message = 'Mismatched retry after an uncertain append';
  await assert.rejects(
    appendHistoryRuntime({ reportRoot, findings: mismatched }),
    (error) => error?.code === 'HISTORY_DUPLICATE_RUN',
  );
});

test('pins an isolated current-user mode-0700 sentinel-v2 root', async (t) => {
  const unversioned = await mkdtemp(path.join(os.tmpdir(), 'sentinel-unversioned-root-'));
  t.after(() => rm(unversioned, { recursive: true, force: true }));
  await assert.rejects(
    appendHistoryRuntime({ reportRoot: unversioned, findings: canonical }),
    (error) => error?.code === 'REPORT_ROOT_VERSION_INVALID',
  );

  const wrongMode = await temporaryRoot(t, 'sentinel-history-root-mode-');
  await fsPromises.chmod(wrongMode, 0o750);
  await assert.rejects(
    appendHistoryRuntime({ reportRoot: wrongMode, findings: canonical }),
    (error) => error?.code === 'REPORT_ROOT_PERMISSIONS_INVALID',
  );

  const aliasParent = await mkdtemp(path.join(os.tmpdir(), 'sentinel-history-root-alias-'));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const actualParent = path.join(aliasParent, 'actual');
  const actualRoot = path.join(actualParent, 'sentinel-v2');
  const alias = path.join(aliasParent, 'redirect');
  await mkdir(actualParent, { mode: 0o700 });
  await mkdir(actualRoot, { mode: 0o700 });
  await symlink(actualParent, alias, 'dir');
  const aliasedRoot = path.join(alias, 'sentinel-v2');
  await publishTestRun(aliasedRoot, canonical.runId);
  await assert.rejects(
    appendHistoryRuntime({ reportRoot: aliasedRoot, findings: canonical }),
    (error) => error?.code === 'REPORT_ROOT_SYMLINK',
  );
  await assert.rejects(access(path.join(actualRoot, 'sweep-history.json'), fsConstants.F_OK));

  const reportRoot = await temporaryRoot(t, 'sentinel-history-root-race-');
  const displacedRoot = `${reportRoot}-displaced`;
  const externalRoot = await temporaryRoot(t, 'sentinel-history-root-external-');
  t.after(() => rm(displacedRoot, { recursive: true, force: true }));
  const originalLstat = fsPromises.lstat;
  const originalOpen = fsPromises.open;
  const originalRename = fsPromises.rename;
  const originalSymlink = fsPromises.symlink;
  let injected = false;
  const injectSwap = async () => {
    if (injected) return;
    injected = true;
    await originalRename(reportRoot, displacedRoot);
    await originalSymlink(externalRoot, reportRoot, 'dir');
  };
  fsPromises.lstat = async (candidate, ...arguments_) => {
    const result = await originalLstat(candidate, ...arguments_);
    if (candidate === reportRoot) await injectSwap();
    return result;
  };
  fsPromises.open = async (candidate, ...arguments_) => {
    if (candidate === reportRoot) await injectSwap();
    return originalOpen(candidate, ...arguments_);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      appendHistoryRuntime({ reportRoot, findings: canonical }),
      (error) => ['REPORT_ROOT_SYMLINK', 'REPORT_ROOT_CHANGED', 'REPORT_ROOT_INVALID']
        .includes(error?.code),
    );
  } finally {
    fsPromises.lstat = originalLstat;
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  await assert.rejects(access(path.join(externalRoot, 'sweep-history.json'), fsConstants.F_OK));
});

test('verifies exact history replacement and stable same-inode reads', async (t) => {
  const renameRoot = await temporaryRoot(t, 'sentinel-history-rename-verify-');
  await appendPublished(renameRoot, canonical);
  const historyPath = path.join(renameRoot, 'sweep-history.json');
  const historyBefore = await readFile(historyPath, 'utf8');
  const second = run(canonical, '2026-07-18T12-00-09-000Z');
  await publishTestRun(renameRoot, second.runId);
  const originalRename = fsPromises.rename;
  let intercepted = false;
  fsPromises.rename = async (source, destination) => {
    if (!intercepted && path.basename(destination) === 'sweep-history.json') {
      intercepted = true;
      return;
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      appendHistoryRuntime({ reportRoot: renameRoot, findings: second }),
      (error) => error?.code === 'HISTORY_WRITE_FAILED',
    );
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(intercepted, true);
  assert.equal(await readFile(historyPath, 'utf8'), historyBefore);

  const tornRoot = await temporaryRoot(t, 'sentinel-history-torn-read-');
  await appendPublished(tornRoot, canonical);
  const tornPath = path.join(tornRoot, 'sweep-history.json');
  const tornBefore = await readFile(tornPath, 'utf8');
  const next = run(canonical, '2026-07-18T12-00-10-000Z');
  await publishTestRun(tornRoot, next.runId);
  const probe = await open(tornPath, 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalRead = fileHandlePrototype.read;
  let mutated = false;
  fileHandlePrototype.read = async function mutateHistoryAfterRead(...arguments_) {
    const result = await originalRead.apply(this, arguments_);
    if (!mutated && result.bytesRead > 0) {
      const opened = await this.stat();
      const current = await stat(tornPath);
      if (opened.dev === current.dev && opened.ino === current.ino) {
        mutated = true;
        await writeFile(tornPath, tornBefore.replace('"2.0"', '"2.1"'), { mode: 0o600 });
      }
    }
    return result;
  };
  try {
    await assert.rejects(
      appendHistoryRuntime({ reportRoot: tornRoot, findings: next }),
      (error) => ['HISTORY_CORRUPT', 'HISTORY_READ_FAILED'].includes(error?.code),
    );
  } finally {
    fileHandlePrototype.read = originalRead;
  }
  assert.equal(mutated, true);
});

test('cleans only exact tracked v2 runs and preserves unrelated children', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-success-');
  const runIds = [
    '2026-07-18T12-01-00-000Z',
    '2026-07-18T12-01-01-000Z',
    '2026-07-18T12-01-02-000Z',
  ];
  for (const runId of runIds) {
    await appendPublished(reportRoot, run(canonical, runId), { 'artifact.txt': `${runId}\n` });
  }
  await mkdir(path.join(reportRoot, 'operator-notes'), { mode: 0o700 });
  await writeFile(path.join(reportRoot, 'operator-notes', 'canary.txt'), 'preserve\n', {
    mode: 0o600,
  });
  await mkdir(path.join(reportRoot, runIds[0], 'nested'), { mode: 0o700 });
  await writeFile(path.join(reportRoot, runIds[0], 'nested', 'artifact.txt'), 'nested\n', {
    mode: 0o600,
  });
  await symlink(
    path.join(reportRoot, 'operator-notes'),
    path.join(reportRoot, runIds[0], 'external-link'),
    'dir',
  );
  await symlink(runIds[2], path.join(reportRoot, 'latest'), 'dir');
  const result = await cleanRuns({ reportRoot, keep: 1 });
  assert.deepEqual(result, { kept: [runIds[2]], removed: runIds.slice(0, 2) });
  await assert.rejects(access(path.join(reportRoot, runIds[0]), fsConstants.F_OK));
  await assert.rejects(access(path.join(reportRoot, runIds[1]), fsConstants.F_OK));
  assert.ok((await stat(path.join(reportRoot, runIds[2]))).isDirectory());
  assert.ok((await stat(path.join(reportRoot, 'operator-notes'))).isDirectory());
  assert.equal(await readFile(path.join(reportRoot, 'operator-notes', 'canary.txt'), 'utf8'), 'preserve\n');
  assert.ok((await lstat(path.join(reportRoot, 'latest'))).isSymbolicLink());
  assert.equal((await readdir(reportRoot)).some((name) => TOMBSTONE_NAME.test(name)), false);
  assert.deepEqual((await readHistory(reportRoot)).runs.map((entry) => entry.runId), [runIds[2]]);
});

test('preflights tracked and kept paths before changing retention state', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-preflight-');
  const externalRoot = await temporaryRoot(t, 'sentinel-clean-external-');
  const oldest = '2026-07-18T12-02-00-000Z';
  const newest = '2026-07-18T12-02-01-000Z';
  await appendPublished(reportRoot, run(canonical, oldest));
  await appendPublished(reportRoot, run(canonical, newest));
  await rm(path.join(reportRoot, newest), { recursive: true });
  await symlink(externalRoot, path.join(reportRoot, newest), 'dir');
  const historyBefore = await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8');
  await assert.rejects(
    cleanRuns({ reportRoot, keep: 1 }),
    (error) => [
      'CLEAN_RUN_SYMLINK',
      'CLEAN_HISTORY_MISMATCH',
      'HISTORY_RUN_IDENTITY_INVALID',
      'HISTORY_RUN_MISSING',
    ].includes(error?.code),
  );
  assert.ok((await stat(path.join(reportRoot, oldest))).isDirectory());
  assert.ok((await lstat(path.join(reportRoot, newest))).isSymbolicLink());
  assert.equal(await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8'), historyBefore);

  const untracked = '2026-07-18T12-02-02-000Z';
  await rm(path.join(reportRoot, newest));
  await publishTestRun(reportRoot, untracked, { 'canary.txt': 'survive\n' });
  await assert.rejects(
    cleanRuns({ reportRoot, keep: 1 }),
    (error) => [
      'CLEAN_HISTORY_MISMATCH',
      'HISTORY_RUN_MISSING',
      'RUN_ORPHAN_INVALID',
    ].includes(error?.code),
  );
  assert.equal(await readFile(path.join(reportRoot, untracked, 'canary.txt'), 'utf8'), 'survive\n');
});

test('rejects unsafe retention, false-success input, oversized history, and accessor state', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-inputs-');
  for (const keep of [-1, 1.5, '1', null]) {
    await assert.rejects(
      cleanRuns({ reportRoot, keep }),
      (error) => error?.code === 'CLEAN_KEEP_INVALID',
    );
  }
  const falseSuccess = structuredClone(canonical);
  falseSuccess.summary = { critical: 0, error: 0, warning: 0, info: 0, skipped: 0 };
  await assert.rejects(
    appendHistoryRuntime({ reportRoot, findings: falseSuccess }),
    (error) => error?.code === 'HISTORY_FINDINGS_INVALID',
  );
  assert.throws(
    () => diffFindings(canonical, falseSuccess),
    (error) => error?.code === 'HISTORY_FINDINGS_INVALID',
  );
  const oversized = structuredClone(canonical);
  oversized.startedAt = 'x'.repeat((16 * 1024 * 1024) + 1);
  await assert.rejects(
    appendHistoryRuntime({ reportRoot, findings: oversized }),
    (error) => error?.code === 'HISTORY_LIMIT_EXCEEDED',
  );

  const history = {
    schemaVersion: '2.0',
    runs: [{
      runId: canonical.runId,
      startedAt: canonical.startedAt,
      finishedAt: canonical.finishedAt,
      coverageStatus: canonical.coverage.status,
      summary: structuredClone(canonical.summary),
      ...fixtureIdentity(),
    }],
  };
  let reads = 0;
  Object.defineProperty(history.runs[0].summary, 'critical', {
    enumerable: true,
    get() {
      reads += 1;
      return reads;
    },
  });
  assert.throws(() => computeTrends(history), (error) => error?.code === 'HISTORY_CORRUPT');
  assert.equal(reads, 0);
});

test('rejects an oversized valid-looking history before opening tracked runs', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-run-limit-');
  const runs = Array.from({ length: 129 }, (_, index) => ({
    runId: `2026-07-18T12-02-59-000Z-${(index + 1).toString(16).padStart(8, '0')}`,
    startedAt: canonical.startedAt,
    finishedAt: canonical.finishedAt,
    coverageStatus: canonical.coverage.status,
    summary: structuredClone(canonical.summary),
    ...fixtureIdentity(index + 1),
  }));
  await writeFile(
    path.join(reportRoot, 'sweep-history.json'),
    `${JSON.stringify({ schemaVersion: '2.0', runs })}\n`,
    { mode: 0o600 },
  );

  await assert.rejects(
    cleanRuns({ reportRoot, keep: 1 }),
    (error) => error?.code === 'HISTORY_CORRUPT',
  );
  assert.deepEqual((await readdir(reportRoot)).filter((name) => RUN_ID.test(name)), []);
});

test('bounds cleanup tree depth and child work before committing intent', async (t) => {
  const depthRoot = await temporaryRoot(t, 'sentinel-clean-depth-limit-');
  const deepRun = '2026-07-18T12-02-50-000Z';
  const depthKept = '2026-07-18T12-02-51-000Z';
  await appendPublished(depthRoot, run(canonical, deepRun));
  await appendPublished(depthRoot, run(canonical, depthKept));
  const deepRelative = Array.from({ length: 33 }, (_, index) => `d${index}`).join(path.sep);
  await mkdir(path.join(depthRoot, deepRun, deepRelative), { recursive: true, mode: 0o700 });
  const depthHistoryBefore = await readFile(path.join(depthRoot, 'sweep-history.json'), 'utf8');
  await assert.rejects(
    cleanRuns({ reportRoot: depthRoot, keep: 1 }),
    (error) => error?.code === 'CLEAN_LIMIT_EXCEEDED',
  );
  assert.equal(await readFile(path.join(depthRoot, 'sweep-history.json'), 'utf8'), depthHistoryBefore);
  assert.ok((await stat(path.join(depthRoot, deepRun, deepRelative))).isDirectory());

  const nodeRoot = await temporaryRoot(t, 'sentinel-clean-node-limit-');
  const wideRun = '2026-07-18T12-02-52-000Z';
  const nodeKept = '2026-07-18T12-02-53-000Z';
  await appendPublished(nodeRoot, run(canonical, wideRun));
  await appendPublished(nodeRoot, run(canonical, nodeKept));
  for (let index = 0; index < 1025; index += 1) {
    await writeFile(
      path.join(nodeRoot, wideRun, `artifact-${String(index).padStart(4, '0')}.txt`),
      'bounded\n',
      { mode: 0o600 },
    );
  }
  const nodeHistoryBefore = await readFile(path.join(nodeRoot, 'sweep-history.json'), 'utf8');
  await assert.rejects(
    cleanRuns({ reportRoot: nodeRoot, keep: 1 }),
    (error) => error?.code === 'CLEAN_LIMIT_EXCEEDED',
  );
  assert.equal(await readFile(path.join(nodeRoot, 'sweep-history.json'), 'utf8'), nodeHistoryBefore);
  assert.equal(
    await readFile(path.join(nodeRoot, wideRun, 'artifact-1024.txt'), 'utf8'),
    'bounded\n',
  );
});

test('ignores dead v2 bakery records and waits for an exact live owner to release', async (t) => {
  const deadRoot = await temporaryRoot(t, 'sentinel-history-dead-lock-');
  const deadId = '1'.repeat(32);
  const deadPath = path.join(deadRoot, `.sweep-history-lock-ticket-${deadId}`);
  const deadContents = `L 2147483647 1 ${deadId} 1\n`;
  await writeFile(deadPath, deadContents, { mode: 0o600 });
  await appendPublished(deadRoot, canonical);
  await assert.rejects(access(deadPath, fsConstants.F_OK));

  const liveRoot = await temporaryRoot(t, 'sentinel-history-live-lock-');
  await publishTestRun(liveRoot, canonical.runId);
  const liveId = '0'.repeat(32);
  const livePath = path.join(liveRoot, `.sweep-history-lock-ticket-${liveId}`);
  const liveContents = `L ${process.pid} ${await processStartMarker()} ${liveId} 1\n`;
  await writeFile(livePath, liveContents, { mode: 0o600 });
  const release = setTimeout(() => unlink(livePath).catch(() => {}), 50);
  t.after(() => clearTimeout(release));
  const appended = await appendHistoryRuntime({ reportRoot: liveRoot, findings: canonical });
  assert.deepEqual(appended.runs.map((entry) => entry.runId), [canonical.runId]);
  await assert.rejects(access(livePath, fsConstants.F_OK));
});

test('streams beyond the active-marker cap while reaping dead and released lock debris', {
  timeout: 30_000,
}, async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-lock-reap-');
  const deadPid = 2_147_483_647;
  const deadStart = '1';
  for (let offset = 0; offset < 4097; offset += 128) {
    const count = Math.min(128, 4097 - offset);
    await Promise.all(Array.from({ length: count }, async (_, batchIndex) => {
      const index = offset + batchIndex;
      const id = (index + 1).toString(16).padStart(32, '0');
      await writeFile(
        path.join(reportRoot, `.sweep-history-lock-ticket-${id}`),
        `L ${deadPid} ${deadStart} ${id} ${index + 1}\n`,
        { mode: 0o600 },
      );
    }));
  }
  const releasedId = 'f'.repeat(32);
  const releasedPath = path.join(
    reportRoot,
    `.sweep-history-lock-choosing-${releasedId}`,
  );
  await writeFile(
    releasedPath,
    `R ${process.pid} ${await processStartMarker()} ${releasedId}\n`,
    { mode: 0o600 },
  );
  await appendPublished(reportRoot, canonical);
  assert.deepEqual(
    (await readdir(reportRoot)).filter((name) => name.startsWith('.sweep-history-lock-')),
    [],
  );
});

test('reaps dead owner-qualified lock stages and history transaction debris', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-stage-reap-');
  const nonce = 'a'.repeat(32);
  const id = 'b'.repeat(32);
  const deadPid = 2_147_483_647;
  const startMarker = await processStartMarker();
  const debris = [
    `.history-record.${deadPid}.1.${id}.${nonce}.tmp`,
    `.history-released.${process.pid}.${startMarker}.${id}.${nonce}.tmp`,
    `.sweep-history.${deadPid}.1.${nonce}.tmp`,
    `.sweep-history.${deadPid}.${nonce}.tmp`,
    `.history-record-${nonce}.tmp`,
  ];
  for (const name of debris) {
    await writeFile(path.join(reportRoot, name), 'crash debris\n', { mode: 0o600 });
  }
  await appendPublished(reportRoot, canonical);
  for (const name of debris) {
    await assert.rejects(access(path.join(reportRoot, name), fsConstants.F_OK));
  }
});

test('never mutates a lock inode when a retired record is concurrently reaped', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-release-reap-race-');
  const probePath = path.join(reportRoot, '.file-handle-probe');
  const probe = await open(probePath, 'w', 0o600);
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  await rm(probePath);
  const originalLstat = fsPromises.lstat;
  const originalRm = fsPromises.rm;
  const originalWrite = fileHandlePrototype.write;
  let retiredReaps = 0;
  let inPlaceReleases = 0;
  fsPromises.lstat = async (candidate, ...arguments_) => {
    if (path.basename(String(candidate)).startsWith('.history-released.')) {
      retiredReaps += 1;
      await originalRm(candidate, { force: true });
    }
    return originalLstat(candidate, ...arguments_);
  };
  fileHandlePrototype.write = async function detectInPlaceRelease(buffer, ...arguments_) {
    if (Buffer.isBuffer(buffer) && buffer.equals(Buffer.from('R'))) inPlaceReleases += 1;
    return originalWrite.call(this, buffer, ...arguments_);
  };
  syncBuiltinESMExports();
  try {
    await appendPublished(reportRoot, canonical);
  } finally {
    fsPromises.lstat = originalLstat;
    fileHandlePrototype.write = originalWrite;
    syncBuiltinESMExports();
  }
  assert.ok(retiredReaps > 0);
  assert.equal(inPlaceReleases, 0);
});

test('treats an exact marker retired between lstat and fstat as disappeared', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-retired-read-race-');
  await publishTestRun(reportRoot, canonical.runId);
  const id = 'c'.repeat(32);
  const startMarker = await processStartMarker();
  const publicMarker = path.join(reportRoot, `.sweep-history-lock-choosing-${id}`);
  const retiredMarker = path.join(
    reportRoot,
    `.history-released.${process.pid}.${startMarker}.${id}.${'d'.repeat(32)}.tmp`,
  );
  await writeFile(
    publicMarker,
    `L ${process.pid} ${startMarker} ${id}\n`,
    { mode: 0o600 },
  );
  const originalOpen = fsPromises.open;
  const originalRename = fsPromises.rename;
  let retired = false;
  fsPromises.open = async (candidate, ...arguments_) => {
    const handle = await originalOpen(candidate, ...arguments_);
    if (!retired && path.basename(String(candidate)) === path.basename(publicMarker)) {
      await originalRename(publicMarker, retiredMarker);
      retired = true;
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await appendHistoryRuntime({ reportRoot, findings: canonical });
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(retired, true);
  assert.deepEqual((await readHistory(reportRoot)).runs.map((entry) => entry.runId), [
    canonical.runId,
  ]);
});

test('rejects a marker replacement between lstat and fstat', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-replaced-read-race-');
  await publishTestRun(reportRoot, canonical.runId);
  const id = 'e'.repeat(32);
  const startMarker = await processStartMarker();
  const publicMarker = path.join(reportRoot, `.sweep-history-lock-choosing-${id}`);
  const displacedMarker = path.join(reportRoot, '.displaced-lock-marker');
  const contents = `L ${process.pid} ${startMarker} ${id}\n`;
  await writeFile(publicMarker, contents, { mode: 0o600 });
  const originalOpen = fsPromises.open;
  const originalRename = fsPromises.rename;
  const originalWriteFile = fsPromises.writeFile;
  let replaced = false;
  fsPromises.open = async (candidate, ...arguments_) => {
    const handle = await originalOpen(candidate, ...arguments_);
    if (!replaced && path.basename(String(candidate)) === path.basename(publicMarker)) {
      await originalRename(publicMarker, displacedMarker);
      await originalWriteFile(publicMarker, contents, { mode: 0o600 });
      replaced = true;
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      appendHistoryRuntime({ reportRoot, findings: canonical }),
      (error) => error?.code === 'HISTORY_LOCK_INVALID',
    );
  } finally {
    fsPromises.open = originalOpen;
    syncBuiltinESMExports();
  }
  assert.equal(replaced, true);
  assert.equal(await readFile(publicMarker, 'utf8'), contents);
});

test('bounds streamed report-root lock work without materializing every entry', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-root-scan-limit-');
  await publishTestRun(reportRoot, canonical.runId);
  const originalOpendir = fsPromises.opendir;
  let intercepted = false;
  fsPromises.opendir = async (candidate, ...arguments_) => {
    if (!intercepted && String(candidate).startsWith('/proc/self/fd/')) {
      intercepted = true;
      let index = 0;
      return {
        async read() {
          index += 1;
          return index <= 16_385 ? { name: `unknown-${index}` } : null;
        },
        async close() {},
      };
    }
    return originalOpendir(candidate, ...arguments_);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      appendHistoryRuntime({ reportRoot, findings: canonical }),
      (error) => error?.code === 'HISTORY_LOCK_LIMIT',
    );
  } finally {
    fsPromises.opendir = originalOpendir;
    syncBuiltinESMExports();
  }
  assert.equal(intercepted, true);
  await assert.rejects(access(path.join(reportRoot, 'sweep-history.json'), fsConstants.F_OK));
});

test('publishes only fully initialized v2 lock records to contenders', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-lock-publish-');
  const firstRun = run(canonical, '2026-07-18T12-03-00-000Z');
  const secondRun = run(canonical, '2026-07-18T12-03-01-000Z');
  await publishTestRun(reportRoot, firstRun.runId);
  await publishTestRun(reportRoot, secondRun.runId);
  const probePath = path.join(reportRoot, '.file-handle-probe');
  const probe = await open(probePath, 'w', 0o600);
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  await rm(probePath);
  const originalWriteFile = fileHandlePrototype.writeFile;
  let releaseWrite = () => {};
  let announceBlocked;
  let intercepted = false;
  const blocked = new Promise((resolve) => { announceBlocked = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  fileHandlePrototype.writeFile = async function delayedFirstWrite(...arguments_) {
    if (!intercepted) {
      intercepted = true;
      announceBlocked();
      await gate;
    }
    return originalWriteFile.apply(this, arguments_);
  };
  let first;
  try {
    first = appendHistoryRuntime({ reportRoot, findings: firstRun });
    await blocked;
    const second = appendHistoryRuntime({ reportRoot, findings: secondRun });
    releaseWrite();
    await Promise.all([first, second]);
  } finally {
    releaseWrite();
    await first?.catch(() => {});
    fileHandlePrototype.writeFile = originalWriteFile;
  }
  assert.deepEqual(
    (await readHistory(reportRoot)).runs.map((entry) => entry.runId),
    [firstRun.runId, secondRun.runId],
  );
});

test('isolates nested v2 state from released v1.8 direct-child behavior', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sentinel-history-v1-v2-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const reportRoot = path.join(parent, 'sentinel-v2');
  await mkdir(reportRoot, { mode: 0o700 });
  const v1HistoryPath = path.join(parent, 'sweep-history.json');
  const v1History = '{"runs":[{"runId":"legacy"}]}\n';
  const v1Run = '2026-07-18T12-04-00Z';
  await writeFile(v1HistoryPath, v1History, { mode: 0o600 });
  await mkdir(path.join(parent, v1Run), { mode: 0o700 });
  await writeFile(path.join(parent, v1Run, 'legacy.txt'), 'v1 survives\n', { mode: 0o600 });
  await symlink(v1Run, path.join(parent, 'latest'), 'dir');
  const beforeHistoryStat = await stat(v1HistoryPath);

  const v2Runs = ['2026-07-18T12-04-01-000Z', '2026-07-18T12-04-02-000Z'];
  for (const runId of v2Runs) await appendPublished(reportRoot, run(canonical, runId));
  await cleanRuns({ reportRoot, keep: 1 });
  assert.equal(await readFile(v1HistoryPath, 'utf8'), v1History);
  const afterHistoryStat = await stat(v1HistoryPath);
  assert.equal(afterHistoryStat.dev, beforeHistoryStat.dev);
  assert.equal(afterHistoryStat.ino, beforeHistoryStat.ino);
  assert.equal(await readFile(path.join(parent, v1Run, 'legacy.txt'), 'utf8'), 'v1 survives\n');
  assert.ok((await lstat(path.join(parent, 'latest'))).isSymbolicLink());

  const v2Before = await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8');
  const v2StatBefore = await stat(path.join(reportRoot, 'sweep-history.json'));
  const legacyTemporary = '2026-07-18T12-04-03Z';
  await mkdir(path.join(parent, legacyTemporary), { mode: 0o700 });
  for (const name of (await readdir(parent)).filter(
    (entry) => RELEASED_V1_RUN_GLOB.test(entry),
  )) {
    if (name === legacyTemporary) await rm(path.join(parent, name), { recursive: true });
  }
  assert.equal(await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8'), v2Before);
  const v2StatAfter = await stat(path.join(reportRoot, 'sweep-history.json'));
  assert.equal(v2StatAfter.dev, v2StatBefore.dev);
  assert.equal(v2StatAfter.ino, v2StatBefore.ino);
});

test('durably commits target state and cleanup intent before any run rename', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-order-');
  const removedRun = '2026-07-18T12-05-00-000Z';
  const keptRun = '2026-07-18T12-05-01-000Z';
  await appendPublished(reportRoot, run(canonical, removedRun), { 'artifact.txt': 'remove\n' });
  await appendPublished(reportRoot, run(canonical, keptRun), { 'artifact.txt': 'keep\n' });
  const originalRename = fsPromises.rename;
  let observed = false;
  fsPromises.rename = async (source, destination) => {
    if (TOMBSTONE_NAME.test(path.basename(destination))) {
      const history = await readHistory(reportRoot);
      assert.deepEqual(history.runs.map((entry) => entry.runId), [keptRun]);
      assert.deepEqual(history.pendingCleanup.entries.map((entry) => entry.runId), [removedRun]);
      assert.ok((await stat(path.join(reportRoot, removedRun))).isDirectory());
      observed = true;
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await cleanRuns({ reportRoot, keep: 1 }), {
      kept: [keptRun], removed: [removedRun],
    });
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(observed, true);
});

test('does not rename or purge after uncertain cleanup-intent durability', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-uncertain-intent-');
  const runIds = ['2026-07-18T12-06-00-000Z', '2026-07-18T12-06-01-000Z'];
  for (const runId of runIds) {
    await appendPublished(reportRoot, run(canonical, runId), { 'artifact.txt': 'preserve\n' });
  }
  const originalOpen = fsPromises.open;
  const originalRename = fsPromises.rename;
  let intentReplaced = false;
  let tombstoneRename = false;
  fsPromises.rename = async (source, destination) => {
    const result = await originalRename(source, destination);
    if (path.basename(destination) === 'sweep-history.json') intentReplaced = true;
    if (TOMBSTONE_NAME.test(path.basename(destination))) tombstoneRename = true;
    return result;
  };
  fsPromises.open = async (candidate, ...arguments_) => {
    const handle = await originalOpen(candidate, ...arguments_);
    if (intentReplaced && String(candidate).endsWith('/.')) {
      handle.sync = async () => {
        const error = new Error('injected root sync failure');
        error.code = 'EIO';
        throw error;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      cleanRuns({ reportRoot, keep: 1 }),
      (error) => error?.code === 'HISTORY_WRITE_FAILED',
    );
  } finally {
    fsPromises.open = originalOpen;
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(tombstoneRename, false);
  for (const runId of runIds) {
    assert.equal(await readFile(path.join(reportRoot, runId, 'artifact.txt'), 'utf8'), 'preserve\n');
  }
});

test('append recovers exact pending originals and rereads state before continuing', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-recover-original-');
  const removedRun = '2026-07-18T12-07-00-000Z';
  const keptRun = '2026-07-18T12-07-01-000Z';
  await appendPublished(reportRoot, run(canonical, removedRun), { 'artifact.txt': 'remove\n' });
  await appendPublished(reportRoot, run(canonical, keptRun), { 'artifact.txt': 'keep\n' });
  await commitPendingWithoutMove(reportRoot);
  const next = run(canonical, '2026-07-18T12-07-02-000Z');
  await publishTestRun(reportRoot, next.runId);
  const appended = await appendHistoryRuntime({ reportRoot, findings: next });
  await assert.rejects(access(path.join(reportRoot, removedRun), fsConstants.F_OK));
  assert.equal(appended.pendingCleanup, undefined);
  assert.deepEqual(appended.runs.map((entry) => entry.runId), [keptRun, next.runId]);
});

test('recovers an exact pending tombstone only after rename durability is known', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-recover-tombstone-');
  const removedRun = '2026-07-18T12-08-00-000Z';
  const keptRun = '2026-07-18T12-08-01-000Z';
  await appendPublished(reportRoot, run(canonical, removedRun), { 'artifact.txt': 'remove\n' });
  await appendPublished(reportRoot, run(canonical, keptRun), { 'artifact.txt': 'keep\n' });
  const originalOpen = fsPromises.open;
  const originalRename = fsPromises.rename;
  let tombstoneMoved = false;
  fsPromises.rename = async (source, destination) => {
    const result = await originalRename(source, destination);
    if (TOMBSTONE_NAME.test(path.basename(destination))) tombstoneMoved = true;
    return result;
  };
  fsPromises.open = async (candidate, ...arguments_) => {
    const handle = await originalOpen(candidate, ...arguments_);
    if (tombstoneMoved && String(candidate).endsWith('/.')) {
      handle.sync = async () => {
        const error = new Error('injected tombstone rename sync failure');
        error.code = 'EIO';
        throw error;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      cleanRuns({ reportRoot, keep: 1 }),
      (error) => error?.code === 'CLEAN_DELETE_FAILED',
    );
  } finally {
    fsPromises.open = originalOpen;
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(tombstoneMoved, true);
  assert.equal((await readdir(reportRoot)).some((name) => TOMBSTONE_NAME.test(name)), true);
  assert.deepEqual(await cleanRuns({ reportRoot, keep: 1 }), { kept: [keptRun], removed: [] });
  assert.equal((await readdir(reportRoot)).some((name) => TOMBSTONE_NAME.test(name)), false);
});

test('clears pending intent only after both paths are durably absent', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-recover-absent-');
  const removedRun = '2026-07-18T12-09-00-000Z';
  const keptRun = '2026-07-18T12-09-01-000Z';
  await appendPublished(reportRoot, run(canonical, removedRun));
  await appendPublished(reportRoot, run(canonical, keptRun));
  await commitPendingWithoutMove(reportRoot);
  await rm(path.join(reportRoot, removedRun), { recursive: true });
  assert.deepEqual(await cleanRuns({ reportRoot, keep: 1 }), { kept: [keptRun], removed: [] });
  assert.equal((await readHistory(reportRoot)).pendingCleanup, undefined);
});

test('throws on uncertain cleanup-intent clearing and remains safely retryable', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-clear-uncertain-');
  const removedRun = '2026-07-18T12-09-10-000Z';
  const keptRun = '2026-07-18T12-09-11-000Z';
  await appendPublished(reportRoot, run(canonical, removedRun), { 'artifact.txt': 'remove\n' });
  await appendPublished(reportRoot, run(canonical, keptRun));
  const originalOpen = fsPromises.open;
  const originalRename = fsPromises.rename;
  let historyRenames = 0;
  let clearReplaced = false;
  fsPromises.rename = async (source, destination) => {
    const result = await originalRename(source, destination);
    if (path.basename(destination) === 'sweep-history.json') {
      historyRenames += 1;
      if (historyRenames === 2) clearReplaced = true;
    }
    return result;
  };
  fsPromises.open = async (candidate, ...arguments_) => {
    const handle = await originalOpen(candidate, ...arguments_);
    if (clearReplaced && String(candidate).endsWith('/.')) {
      handle.sync = async () => {
        const error = new Error('injected clear-state sync failure');
        error.code = 'EIO';
        throw error;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      cleanRuns({ reportRoot, keep: 1 }),
      (error) => error?.code === 'HISTORY_WRITE_FAILED',
    );
  } finally {
    fsPromises.open = originalOpen;
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(clearReplaced, true);
  await assert.rejects(access(path.join(reportRoot, removedRun), fsConstants.F_OK));
  assert.deepEqual(await cleanRuns({ reportRoot, keep: 1 }), { kept: [keptRun], removed: [] });
});

test('blocks append on both-present pending state without deleting either path', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-both-present-');
  const removedRun = '2026-07-18T12-10-00-000Z';
  const keptRun = '2026-07-18T12-10-01-000Z';
  await appendPublished(reportRoot, run(canonical, removedRun), { 'owned.txt': 'owned\n' });
  await appendPublished(reportRoot, run(canonical, keptRun));
  const pending = await commitPendingWithoutMove(reportRoot);
  const tombstone = pending.pendingCleanup.entries[0].tombstone;
  await mkdir(path.join(reportRoot, tombstone), { mode: 0o700 });
  await writeFile(path.join(reportRoot, tombstone, 'canary.txt'), 'replacement\n', { mode: 0o600 });
  await assert.rejects(
    cleanRuns({ reportRoot, keep: 1 }),
    (error) => error?.code === 'CLEAN_PURGE_PENDING',
  );
  const next = run(canonical, '2026-07-18T12-10-02-000Z');
  await publishTestRun(reportRoot, next.runId);
  await assert.rejects(
    appendHistoryRuntime({ reportRoot, findings: next }),
    (error) => error?.code === 'HISTORY_CLEANUP_PENDING',
  );
  assert.equal(await readFile(path.join(reportRoot, removedRun, 'owned.txt'), 'utf8'), 'owned\n');
  assert.equal(await readFile(path.join(reportRoot, tombstone, 'canary.txt'), 'utf8'), 'replacement\n');
});

test('preflights every pending entry before purging any exact run', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-pending-preflight-');
  const firstRemoved = '2026-07-18T12-10-10-000Z';
  const secondRemoved = '2026-07-18T12-10-11-000Z';
  const keptRun = '2026-07-18T12-10-12-000Z';
  await appendPublished(reportRoot, run(canonical, firstRemoved), { 'owned.txt': 'first\n' });
  await appendPublished(reportRoot, run(canonical, secondRemoved), { 'owned.txt': 'second\n' });
  await appendPublished(reportRoot, run(canonical, keptRun));
  const pending = await commitPendingWithoutMove(reportRoot);
  const ambiguous = pending.pendingCleanup.entries[1].tombstone;
  await mkdir(path.join(reportRoot, ambiguous), { mode: 0o700 });
  await writeFile(path.join(reportRoot, ambiguous, 'canary.txt'), 'ambiguous\n', { mode: 0o600 });

  await assert.rejects(
    cleanRuns({ reportRoot, keep: 1 }),
    (error) => error?.code === 'CLEAN_PURGE_PENDING',
  );

  assert.equal(await readFile(path.join(reportRoot, firstRemoved, 'owned.txt'), 'utf8'), 'first\n');
  assert.equal(await readFile(path.join(reportRoot, secondRemoved, 'owned.txt'), 'utf8'), 'second\n');
  assert.equal(await readFile(path.join(reportRoot, ambiguous, 'canary.txt'), 'utf8'), 'ambiguous\n');
});

test('never purges a fingerprint or marker replacement at an original path', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-replacement-');
  const removedRun = '2026-07-18T12-11-00-000Z';
  const keptRun = '2026-07-18T12-11-01-000Z';
  await appendPublished(reportRoot, run(canonical, removedRun), { 'owned.txt': 'owned\n' });
  await appendPublished(reportRoot, run(canonical, keptRun));
  await commitPendingWithoutMove(reportRoot);
  const displaced = path.join(reportRoot, '.displaced-owned-run');
  await rename(path.join(reportRoot, removedRun), displaced);
  await publishTestRun(reportRoot, removedRun, { 'canary.txt': 'survive\n' });
  await assert.rejects(
    cleanRuns({ reportRoot, keep: 1 }),
    (error) => error?.code === 'CLEAN_PURGE_PENDING',
  );
  assert.equal(await readFile(path.join(reportRoot, removedRun, 'canary.txt'), 'utf8'), 'survive\n');
  assert.equal(await readFile(path.join(displaced, 'owned.txt'), 'utf8'), 'owned\n');
});

test('blocks exact-directory marker mismatch and tombstone-only fingerprint mismatch', async (t) => {
  const markerRoot = await temporaryRoot(t, 'sentinel-clean-marker-mismatch-');
  const markerRun = '2026-07-18T12-11-10-000Z';
  const markerKept = '2026-07-18T12-11-11-000Z';
  await appendPublished(markerRoot, run(canonical, markerRun), { 'owned.txt': 'owned\n' });
  await appendPublished(markerRoot, run(canonical, markerKept));
  const markerPending = await commitPendingWithoutMove(markerRoot);
  const originalToken = markerPending.pendingCleanup.entries[0].markerToken;
  const replacementToken = originalToken === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
  await writeFile(path.join(markerRoot, markerRun, RUN_MARKER_NAME), `${replacementToken}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    cleanRuns({ reportRoot: markerRoot, keep: 1 }),
    (error) => error?.code === 'CLEAN_PURGE_PENDING',
  );
  assert.equal(await readFile(path.join(markerRoot, markerRun, 'owned.txt'), 'utf8'), 'owned\n');

  const tombstoneRoot = await temporaryRoot(t, 'sentinel-clean-tombstone-mismatch-');
  const tombstoneRun = '2026-07-18T12-11-12-000Z';
  const tombstoneKept = '2026-07-18T12-11-13-000Z';
  await appendPublished(tombstoneRoot, run(canonical, tombstoneRun), { 'owned.txt': 'owned\n' });
  await appendPublished(tombstoneRoot, run(canonical, tombstoneKept));
  const tombstonePending = await commitPendingWithoutMove(tombstoneRoot);
  const entry = tombstonePending.pendingCleanup.entries[0];
  await rename(path.join(tombstoneRoot, tombstoneRun), path.join(tombstoneRoot, '.displaced-run'));
  await mkdir(path.join(tombstoneRoot, entry.tombstone), { mode: 0o700 });
  await writeFile(path.join(tombstoneRoot, entry.tombstone, 'canary.txt'), 'survive\n', {
    mode: 0o600,
  });
  await assert.rejects(
    cleanRuns({ reportRoot: tombstoneRoot, keep: 1 }),
    (error) => error?.code === 'CLEAN_PURGE_PENDING',
  );
  assert.equal(
    await readFile(path.join(tombstoneRoot, entry.tombstone, 'canary.txt'), 'utf8'),
    'survive\n',
  );
});

test('recovers an exact empty tombstone after marker-last crash', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-marker-last-');
  const removedRun = '2026-07-18T12-12-00-000Z';
  const keptRun = '2026-07-18T12-12-01-000Z';
  await appendPublished(reportRoot, run(canonical, removedRun), { 'artifact.txt': 'remove\n' });
  await appendPublished(reportRoot, run(canonical, keptRun));
  const originalRmdir = fsPromises.rmdir;
  let blocked = false;
  fsPromises.rmdir = async (candidate, ...arguments_) => {
    if (!blocked && TOMBSTONE_NAME.test(path.basename(candidate))) {
      blocked = true;
      const error = new Error('injected crash before tombstone rmdir');
      error.code = 'EIO';
      throw error;
    }
    return originalRmdir(candidate, ...arguments_);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      cleanRuns({ reportRoot, keep: 1 }),
      (error) => error?.code === 'CLEAN_PURGE_PENDING',
    );
  } finally {
    fsPromises.rmdir = originalRmdir;
    syncBuiltinESMExports();
  }
  assert.equal(blocked, true);
  const tombstone = (await readdir(reportRoot)).find((name) => TOMBSTONE_NAME.test(name));
  assert.ok(tombstone);
  assert.deepEqual(await readdir(path.join(reportRoot, tombstone)), []);
  assert.deepEqual(await cleanRuns({ reportRoot, keep: 1 }), { kept: [keptRun], removed: [] });
  await assert.rejects(access(path.join(reportRoot, tombstone), fsConstants.F_OK));
});

test('detects a kept-run swap at commit without deleting the replacement', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-kept-swap-');
  const removedRun = '2026-07-18T12-13-00-000Z';
  const keptRun = '2026-07-18T12-13-01-000Z';
  await appendPublished(reportRoot, run(canonical, removedRun), { 'artifact.txt': 'remove\n' });
  await appendPublished(reportRoot, run(canonical, keptRun), { 'artifact.txt': 'owned\n' });
  const displaced = path.join(reportRoot, '.displaced-kept-run');
  const originalRename = fsPromises.rename;
  const originalMkdir = fsPromises.mkdir;
  const originalWriteFile = fsPromises.writeFile;
  let swapped = false;
  fsPromises.rename = async (source, destination) => {
    if (!swapped && path.basename(destination) === 'sweep-history.json') {
      swapped = true;
      await originalRename(path.join(reportRoot, keptRun), displaced);
      await originalMkdir(path.join(reportRoot, keptRun), { mode: 0o700 });
      await originalWriteFile(path.join(reportRoot, keptRun, 'canary.txt'), 'survive\n', {
        mode: 0o600,
      });
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      cleanRuns({ reportRoot, keep: 1 }),
      (error) => ['CLEAN_RUN_CHANGED', 'HISTORY_WRITE_FAILED'].includes(error?.code),
    );
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(swapped, true);
  assert.equal(await readFile(path.join(reportRoot, keptRun, 'canary.txt'), 'utf8'), 'survive\n');
  assert.equal(await readFile(path.join(displaced, 'artifact.txt'), 'utf8'), 'owned\n');
});
