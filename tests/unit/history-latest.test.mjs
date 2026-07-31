import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishRun } from '../../runtime/history.mjs';
import { RunBoundary } from '../../runtime/lib/fs-boundary.mjs';

const canonical = JSON.parse(
  await readFile(new URL('../fixtures/report/canonical-findings.json', import.meta.url), 'utf8'),
);
const manifestFixture = JSON.parse(
  await readFile(
    new URL('../fixtures/discovery/openapi-complete.manifest.json', import.meta.url),
    'utf8',
  ),
);
const manifest = { ...manifestFixture, generatedAt: canonical.manifestGeneratedAt };

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sentinel-history-latest-'));
  const reportRoot = path.join(parent, 'sentinel-v2');
  await mkdir(reportRoot, { mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { parent, reportRoot };
}

async function publish(reportRoot, runId) {
  return publishRun({
    reportRoot,
    runId,
    findings: { ...structuredClone(canonical), runId },
    writeArtifacts: async (boundary) => {
      await boundary.writeJson('sentinel-manifest.json', manifest);
    },
  });
}

test('live history publication atomically replaces a valid dangling latest pointer', async (t) => {
  assert.equal(RunBoundary.prototype.replaceLatest, undefined);
  const { reportRoot } = await fixture(t);
  const staleRunId = '2026-07-18T12-00-00-000Z';
  const runId = '2026-07-18T13-00-00-000Z';
  await symlink(staleRunId, path.join(reportRoot, 'latest'), 'dir');

  const result = await publish(reportRoot, runId);

  assert.equal(result.latestRunId, runId);
  assert.equal(await readlink(path.join(reportRoot, 'latest')), runId);
});

test('live history rejects an external latest target without touching its victim', async (t) => {
  const { parent, reportRoot } = await fixture(t);
  const victim = path.join(parent, 'victim');
  const marker = path.join(victim, 'marker.txt');
  await mkdir(victim);
  await writeFile(marker, 'untouched\n');
  await symlink(victim, path.join(reportRoot, 'latest'), 'dir');

  await assert.rejects(
    publish(reportRoot, '2026-07-18T13-00-00-001Z'),
    (error) => error?.code === 'LATEST_INVALID',
  );
  assert.equal(await readFile(marker, 'utf8'), 'untouched\n');
  assert.equal(await readlink(path.join(reportRoot, 'latest')), victim);
});
