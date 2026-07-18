import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendHistory,
  cleanRuns,
  computeTrends,
  diffFindings,
} from '../../runtime/history.mjs';
import {
  renderDashboard,
  renderMarkdown,
  renderPrComment,
  summaryExitCode,
} from '../../runtime/report.mjs';

const canonical = JSON.parse(
  await readFile(new URL('../fixtures/report/canonical-findings.json', import.meta.url), 'utf8'),
);

function run(findings, runId, summary = findings.summary) {
  return {
    ...structuredClone(findings),
    runId,
    summary: structuredClone(summary),
  };
}

async function temporaryRoot(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
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

test('keeps Markdown, dashboard, PR, history, trends, diff, and CI on the canonical summary', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-report-consistency-');
  const older = run(canonical, '2026-07-18T11-59-58-000Z', {
    critical: 1, error: 0, warning: 0, info: 0, skipped: 0,
  });
  older.findings = [
    structuredClone(canonical.findings[0]),
    {
      ...structuredClone(canonical.findings[1]),
      id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    },
  ];
  const newer = structuredClone(canonical);

  await Promise.all([
    appendHistory({ reportRoot, findings: newer }),
    appendHistory({ reportRoot, findings: older }),
  ]);

  const historyPath = path.join(reportRoot, 'sweep-history.json');
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  assert.deepEqual(history.runs.map((entry) => entry.runId), [older.runId, newer.runId]);
  assert.deepEqual(history.runs[0].summary, older.summary);
  assert.deepEqual(history.runs[1].summary, newer.summary);
  assert.equal((await stat(historyPath)).mode & 0o777, 0o600);

  const trends = computeTrends(history);
  assert.deepEqual(trends.latestSummary, newer.summary);
  assert.deepEqual(trends.runs.map((entry) => entry.summary), [older.summary, newer.summary]);
  assert.deepEqual(trends.deltas, [{
    fromRunId: older.runId,
    toRunId: newer.runId,
    summary: { critical: 0, error: 1, warning: 1, info: 0, skipped: 1 },
  }]);

  const difference = diffFindings(older, newer);
  assert.equal(difference.olderRunId, older.runId);
  assert.equal(difference.newerRunId, newer.runId);
  assert.deepEqual(difference.olderSummary, older.summary);
  assert.deepEqual(difference.newerSummary, newer.summary);
  assert.deepEqual(difference.added, [
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  ]);
  assert.deepEqual(difference.resolved, [
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  ]);
  assert.deepEqual(difference.persisting, [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  ]);

  assert.deepEqual(parseMarkdownSummary(renderMarkdown(newer)), newer.summary);
  assert.deepEqual(parseDashboardSummary(renderDashboard(newer)), newer.summary);
  const pr = renderPrComment(newer);
  for (const [name, count] of Object.entries(newer.summary)) {
    const label = `${name[0].toUpperCase()}${name.slice(1)}`;
    assert.ok(pr.includes(`${label} ${count}`), `${label} ${count}`);
  }
  assert.equal(summaryExitCode(newer), 2);
});

test('serializes concurrent history appends without lost updates', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-history-concurrent-');
  const runs = Array.from({ length: 8 }, (_, index) => run(
    canonical,
    `2026-07-18T12-00-${String(index).padStart(2, '0')}-000Z`,
  ));

  await Promise.all(runs.map((findings) => appendHistory({ reportRoot, findings })));

  const history = JSON.parse(await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8'));
  assert.deepEqual(
    history.runs.map((entry) => entry.runId),
    runs.map((entry) => entry.runId),
  );
  assert.equal(new Set(history.runs.map((entry) => entry.runId)).size, runs.length);
  await assert.rejects(access(path.join(reportRoot, 'sweep-history.lock'), fsConstants.F_OK));
});

test('rejects corrupt, duplicate, symlinked, locked, and failed history updates without replacement', async (t) => {
  const corruptRoot = await temporaryRoot(t, 'sentinel-history-corrupt-');
  const corruptPath = path.join(corruptRoot, 'sweep-history.json');
  await writeFile(corruptPath, '{not json\n', { mode: 0o600 });
  const corruptBefore = await readFile(corruptPath, 'utf8');
  await assert.rejects(
    appendHistory({ reportRoot: corruptRoot, findings: canonical }),
    (error) => error?.code === 'HISTORY_CORRUPT',
  );
  assert.equal(await readFile(corruptPath, 'utf8'), corruptBefore);

  const duplicateRoot = await temporaryRoot(t, 'sentinel-history-duplicate-');
  await appendHistory({ reportRoot: duplicateRoot, findings: canonical });
  const duplicatePath = path.join(duplicateRoot, 'sweep-history.json');
  const duplicateBefore = await readFile(duplicatePath, 'utf8');
  await assert.rejects(
    appendHistory({ reportRoot: duplicateRoot, findings: canonical }),
    (error) => error?.code === 'HISTORY_DUPLICATE_RUN',
  );
  assert.equal(await readFile(duplicatePath, 'utf8'), duplicateBefore);

  const symlinkRoot = await temporaryRoot(t, 'sentinel-history-symlink-');
  const external = path.join(await temporaryRoot(t, 'sentinel-history-external-'), 'history.json');
  await writeFile(external, '{"outside":true}\n', { mode: 0o600 });
  await symlink(external, path.join(symlinkRoot, 'sweep-history.json'));
  await assert.rejects(
    appendHistory({ reportRoot: symlinkRoot, findings: canonical }),
    (error) => error?.code === 'HISTORY_SYMLINK',
  );
  assert.equal(await readFile(external, 'utf8'), '{"outside":true}\n');

  const lockRoot = await temporaryRoot(t, 'sentinel-history-lock-');
  const lockExternal = path.join(await temporaryRoot(t, 'sentinel-lock-external-'), 'lock');
  await writeFile(lockExternal, 'outside\n', { mode: 0o600 });
  await symlink(lockExternal, path.join(lockRoot, 'sweep-history.lock'));
  await assert.rejects(
    appendHistory({ reportRoot: lockRoot, findings: canonical }),
    (error) => error?.code === 'HISTORY_LOCK_INVALID',
  );
  assert.equal(await readFile(lockExternal, 'utf8'), 'outside\n');

  const failedRoot = await temporaryRoot(t, 'sentinel-history-failed-run-');
  const invalid = structuredClone(canonical);
  invalid.schemaVersion = '1.0';
  await assert.rejects(
    appendHistory({ reportRoot: failedRoot, findings: invalid }),
    (error) => error?.code === 'HISTORY_FINDINGS_INVALID',
  );
  await assert.rejects(access(path.join(failedRoot, 'sweep-history.json'), fsConstants.F_OK));
});

test('cleans only validated direct-child runs and updates history after successful deletion', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-success-');
  const runIds = [
    '2026-07-18T12-00-00-000Z',
    '2026-07-18T12-00-01-000Z',
    '2026-07-18T12-00-02-000Z',
  ];
  for (const runId of runIds) {
    await mkdir(path.join(reportRoot, runId), { mode: 0o700 });
    await writeFile(path.join(reportRoot, runId, 'artifact.txt'), `${runId}\n`, { mode: 0o600 });
    await appendHistory({ reportRoot, findings: run(canonical, runId) });
  }
  await mkdir(path.join(reportRoot, 'operator-notes'), { mode: 0o700 });
  await symlink(runIds[2], path.join(reportRoot, 'latest'), 'dir');

  const result = await cleanRuns({ reportRoot, keep: 1 });

  assert.deepEqual(result, { kept: [runIds[2]], removed: runIds.slice(0, 2) });
  await assert.rejects(access(path.join(reportRoot, runIds[0]), fsConstants.F_OK));
  await assert.rejects(access(path.join(reportRoot, runIds[1]), fsConstants.F_OK));
  assert.ok((await stat(path.join(reportRoot, runIds[2]))).isDirectory());
  assert.ok((await stat(path.join(reportRoot, 'operator-notes'))).isDirectory());
  assert.ok((await lstat(path.join(reportRoot, 'latest'))).isSymbolicLink());
  const entries = await import('node:fs/promises').then(({ readdir }) => readdir(reportRoot));
  assert.equal(entries.some((entry) => entry.startsWith('.sentinel-clean-')), false);

  const history = JSON.parse(await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8'));
  assert.deepEqual(history.runs.map((entry) => entry.runId), [runIds[2]]);
});

test('preflights every cleanup target so symlinks and corrupt history preserve all runs', async (t) => {
  const externalRoot = await temporaryRoot(t, 'sentinel-clean-external-');
  const externalFile = path.join(externalRoot, 'must-survive.txt');
  await writeFile(externalFile, 'survive\n', { mode: 0o600 });

  const symlinkRoot = await temporaryRoot(t, 'sentinel-clean-symlink-');
  const oldest = '2026-07-18T12-00-00-000Z';
  const linked = '2026-07-18T12-00-01-000Z';
  const newest = '2026-07-18T12-00-02-000Z';
  await mkdir(path.join(symlinkRoot, oldest), { mode: 0o700 });
  await symlink(externalRoot, path.join(symlinkRoot, linked), 'dir');
  await mkdir(path.join(symlinkRoot, newest), { mode: 0o700 });
  const history = {
    schemaVersion: '2.0',
    runs: [oldest, linked, newest].map((runId) => ({
      runId,
      startedAt: canonical.startedAt,
      finishedAt: canonical.finishedAt,
      coverageStatus: canonical.coverage.status,
      summary: canonical.summary,
    })),
  };
  const historyPath = path.join(symlinkRoot, 'sweep-history.json');
  await writeFile(historyPath, `${JSON.stringify(history)}\n`, { mode: 0o600 });
  const historyBefore = await readFile(historyPath, 'utf8');

  await assert.rejects(
    cleanRuns({ reportRoot: symlinkRoot, keep: 1 }),
    (error) => error?.code === 'CLEAN_RUN_SYMLINK',
  );
  assert.ok((await stat(path.join(symlinkRoot, oldest))).isDirectory());
  assert.equal(await readFile(externalFile, 'utf8'), 'survive\n');
  assert.equal(await readFile(historyPath, 'utf8'), historyBefore);

  const corruptRoot = await temporaryRoot(t, 'sentinel-clean-corrupt-');
  await mkdir(path.join(corruptRoot, oldest), { mode: 0o700 });
  await mkdir(path.join(corruptRoot, newest), { mode: 0o700 });
  await writeFile(path.join(corruptRoot, 'sweep-history.json'), 'broken\n', { mode: 0o600 });
  await assert.rejects(
    cleanRuns({ reportRoot: corruptRoot, keep: 1 }),
    (error) => error?.code === 'HISTORY_CORRUPT',
  );
  assert.ok((await stat(path.join(corruptRoot, oldest))).isDirectory());
  assert.ok((await stat(path.join(corruptRoot, newest))).isDirectory());
});

test('rejects invalid retention counts without touching report contents', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-clean-invalid-');
  const runId = '2026-07-18T12-00-00-000Z';
  await mkdir(path.join(reportRoot, runId), { mode: 0o700 });

  for (const keep of [-1, 1.5, '1', null]) {
    await assert.rejects(
      cleanRuns({ reportRoot, keep }),
      (error) => error?.code === 'CLEAN_KEEP_INVALID',
    );
  }
  assert.ok((await stat(path.join(reportRoot, runId))).isDirectory());
});
