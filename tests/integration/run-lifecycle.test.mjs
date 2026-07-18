import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import fsPromises, {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
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
  cleanRuns,
  publishRun,
  readPublishedRun,
  readSweepHistory,
} from '../../runtime/history.mjs';
import { RunBoundary } from '../../runtime/lib/fs-boundary.mjs';
import { renderMarkdown } from '../../runtime/report.mjs';

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
const STAGING_NAME = /^\.sentinel-run-staging-[a-f0-9]{64}$/u;

function findingsFor(runId) {
  return { ...structuredClone(canonical), runId };
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function temporaryRoot(t, prefix) {
  const parent = await mkdtemp(path.join(os.tmpdir(), prefix));
  const reportRoot = path.join(parent, 'sentinel-v2');
  await mkdir(reportRoot, { mode: 0o700 });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return reportRoot;
}

async function writeRequiredArtifacts(boundary, findings) {
  await boundary.writeJson('sentinel-manifest.json', manifest);
}

async function publish(reportRoot, findings, extra = async () => {}) {
  return publishRun({
    reportRoot,
    runId: findings.runId,
    findings,
    writeArtifacts: async (boundary) => {
      await writeRequiredArtifacts(boundary, findings);
      await extra(boundary);
    },
  });
}

async function rawHistory(reportRoot) {
  return JSON.parse(await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8'));
}

async function assertNoStaging(reportRoot) {
  assert.deepEqual((await readdir(reportRoot)).filter((name) => STAGING_NAME.test(name)), []);
}

test('publishes one immutable complete run with nested artifacts, history, and latest', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-publish-');
  const findings = findingsFor('2026-07-18T13-00-00-000Z');

  const result = await publish(reportRoot, findings, async (boundary) => {
    await boundary.writeText('collections/bruno/demo.bru', 'meta {\n  name: demo\n}\n');
    await boundary.writeBytes('screenshots/browser.png', Uint8Array.from([137, 80, 78, 71]));
  });

  assert.equal(result.runId, findings.runId);
  assert.equal(result.latestRunId, findings.runId);
  assert.deepEqual(result.findings, findings);
  assert.deepEqual(result.history.runs.map((entry) => entry.runId), [findings.runId]);
  assert.equal(await readlink(path.join(reportRoot, 'latest')), findings.runId);
  assert.equal((await lstat(path.join(reportRoot, findings.runId))).mode & 0o777, 0o700);
  assert.equal(
    (await lstat(path.join(reportRoot, findings.runId, 'collections/bruno'))).mode & 0o777,
    0o700,
  );
  assert.equal(
    (await lstat(path.join(reportRoot, findings.runId, 'collections/bruno/demo.bru'))).mode & 0o777,
    0o600,
  );
  assert.deepEqual(
    await readFile(path.join(reportRoot, findings.runId, 'screenshots/browser.png')),
    Buffer.from([137, 80, 78, 71]),
  );
  await assertNoStaging(reportRoot);
});

test('creates a private sentinel-v2 publication root without following ancestor symlinks', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sentinel-run-root-create-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const reportRoot = path.join(parent, 'sentinel-reports', 'sentinel-v2');
  const findings = findingsFor('2026-07-18T13-00-00-002Z');
  await publish(reportRoot, findings);
  assert.equal((await lstat(path.dirname(reportRoot))).mode & 0o777, 0o700);
  assert.equal((await lstat(reportRoot)).mode & 0o777, 0o700);

  const actual = path.join(parent, 'actual');
  const alias = path.join(parent, 'alias');
  await mkdir(actual, { mode: 0o700 });
  await symlink(actual, alias, 'dir');
  const aliasedRoot = path.join(alias, 'sentinel-v2');
  await assert.rejects(
    publish(aliasedRoot, findingsFor('2026-07-18T13-00-00-003Z')),
    (error) => ['REPORT_ROOT_INVALID', 'REPORT_ROOT_SYMLINK'].includes(error?.code),
  );
  await assert.rejects(access(path.join(actual, 'sentinel-v2'), fsConstants.F_OK));
});

test('accepts canonical findings returned after run-scoped execution in hidden staging', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-callback-findings-');
  const findings = findingsFor('2026-07-18T13-00-00-001Z');
  let executedInsideStaging = false;

  const result = await publishRun({
    reportRoot,
    runId: findings.runId,
    writeArtifacts: async (boundary) => {
      assert.deepEqual(Object.keys(boundary).sort(), [
        'root',
        'writeBytes',
        'writeJson',
        'writeText',
      ]);
      assert.equal(Object.isFrozen(boundary), true);
      assert.equal(boundary.commit, undefined);
      assert.equal(boundary.abort, undefined);
      assert.equal(boundary.writeIdentityMarker, undefined);
      assert.equal(boundary.replaceLatest, undefined);
      executedInsideStaging = STAGING_NAME.test(path.basename(boundary.root));
      await writeRequiredArtifacts(boundary, findings);
      return { findings };
    },
  });

  assert.equal(executedInsideStaging, true);
  assert.equal(result.runId, findings.runId);
  assert.deepEqual(result.findings, findings);
  assert.deepEqual((await rawHistory(reportRoot)).runs.map((entry) => entry.runId), [findings.runId]);
  assert.equal(await readlink(path.join(reportRoot, 'latest')), findings.runId);
});

test('aborts staging on callback or required-artifact failure without metadata publication', async (t) => {
  const callbackRoot = await temporaryRoot(t, 'sentinel-run-abort-callback-');
  const callbackFindings = findingsFor('2026-07-18T13-00-01-000Z');
  await assert.rejects(
    publishRun({
      reportRoot: callbackRoot,
      runId: callbackFindings.runId,
      findings: callbackFindings,
      writeArtifacts: async (boundary) => {
        await boundary.writeText('partial.txt', 'partial\n');
        throw new Error('injected artifact failure');
      },
    }),
    (error) => error?.code === 'RUN_ARTIFACT_WRITE_FAILED',
  );
  await assert.rejects(access(path.join(callbackRoot, callbackFindings.runId), fsConstants.F_OK));
  await assert.rejects(access(path.join(callbackRoot, 'sweep-history.json'), fsConstants.F_OK));
  await assert.rejects(access(path.join(callbackRoot, 'latest'), fsConstants.F_OK));
  await assertNoStaging(callbackRoot);

  const incompleteRoot = await temporaryRoot(t, 'sentinel-run-abort-incomplete-');
  const incomplete = findingsFor('2026-07-18T13-00-02-000Z');
  await assert.rejects(
    publishRun({
      reportRoot: incompleteRoot,
      runId: incomplete.runId,
      findings: incomplete,
      writeArtifacts: async (boundary) => {
        await boundary.writeJson('sentinel-findings.json', incomplete);
      },
    }),
    (error) => error?.code === 'RUN_ARTIFACT_MISSING',
  );
  await assert.rejects(access(path.join(incompleteRoot, incomplete.runId), fsConstants.F_OK));
  await assertNoStaging(incompleteRoot);
});

test('surfaces an abort failure instead of hiding transaction debris', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-abort-failure-');
  const findings = findingsFor('2026-07-18T13-00-02-000Z-deadbeef');
  const originalUnlink = fsPromises.unlink;
  let blocked = false;
  fsPromises.unlink = async (candidate, ...arguments_) => {
    if (!blocked
        && STAGING_NAME.test(path.basename(path.dirname(String(candidate))))
        && path.basename(String(candidate)) === 'partial.txt') {
      blocked = true;
      throw Object.assign(new Error('injected abort failure'), { code: 'EACCES' });
    }
    return originalUnlink(candidate, ...arguments_);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      publishRun({
        reportRoot,
        runId: findings.runId,
        findings,
        writeArtifacts: async (boundary) => {
          await boundary.writeText('partial.txt', 'partial\n');
          throw new Error('injected callback failure');
        },
      }),
      (error) => error?.code === 'RUN_ABORT_FAILED',
    );
  } finally {
    fsPromises.unlink = originalUnlink;
    syncBuiltinESMExports();
  }
  assert.equal(blocked, true);
  assert.equal((await readdir(reportRoot)).some((name) => STAGING_NAME.test(name)), true);
  await assert.rejects(access(path.join(reportRoot, findings.runId), fsConstants.F_OK));
});

test('rejects non-canonical rendered reports before public rename', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-report-mismatch-');
  const findings = findingsFor('2026-07-18T13-00-02-001Z');
  await assert.rejects(
    publishRun({
      reportRoot,
      runId: findings.runId,
      findings,
      writeArtifacts: async (boundary) => {
        await writeRequiredArtifacts(boundary, findings);
        await boundary.writeText('sweep.md', '# forged report\n');
      },
    }),
    (error) => error?.code === 'RUN_REPORT_MISMATCH',
  );
  await assert.rejects(access(path.join(reportRoot, findings.runId), fsConstants.F_OK));
  await assertNoStaging(reportRoot);
});

test('revalidates canonical artifacts after the public rename before metadata commit', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-post-rename-validation-');
  const findings = findingsFor('2026-07-18T13-00-02-007Z');
  const originalRename = fsPromises.rename;
  let injected = false;
  fsPromises.rename = async (source, destination) => {
    const result = await originalRename(source, destination);
    if (!injected
        && STAGING_NAME.test(path.basename(String(source)))
        && path.basename(String(destination)) === findings.runId) {
      injected = true;
      await writeFile(path.join(destination, 'sweep.md'), 'tampered after rename\n');
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      publish(reportRoot, findings),
      (error) => error?.code === 'RUN_REPORT_MISMATCH',
    );
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(injected, true);
  assert.ok((await stat(path.join(reportRoot, findings.runId))).isDirectory());
  await assert.rejects(access(path.join(reportRoot, 'sweep-history.json'), fsConstants.F_OK));
  await assert.rejects(access(path.join(reportRoot, 'latest'), fsConstants.F_OK));
});

test('recovers only exact marker-bound staging and preserves unrelated children', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-stage-recovery-');
  const token = 'a'.repeat(64);
  const stale = await RunBoundary.createStaging(reportRoot, token);
  await stale.writeText('partial.txt', 'stale\n');
  const unrelated = path.join(reportRoot, '.sentinel-run-staging-operator-notes');
  await mkdir(unrelated, { mode: 0o700 });
  await writeFile(path.join(unrelated, 'canary.txt'), 'preserve\n', { mode: 0o600 });

  await publish(reportRoot, findingsFor('2026-07-18T13-00-02-002Z'));
  await assert.rejects(access(stale.root, fsConstants.F_OK));
  assert.equal(await readFile(path.join(unrelated, 'canary.txt'), 'utf8'), 'preserve\n');

  const mismatchToken = 'b'.repeat(64);
  const mismatched = path.join(reportRoot, `.sentinel-run-staging-${mismatchToken}`);
  await mkdir(mismatched, { mode: 0o700 });
  await writeFile(
    path.join(mismatched, '.sentinel-run-identity-v2'),
    `${'c'.repeat(64)}\n`,
    { mode: 0o600 },
  );
  await writeFile(path.join(mismatched, 'canary.txt'), 'do-not-delete\n', { mode: 0o600 });
  let callbackRan = false;
  const next = findingsFor('2026-07-18T13-00-02-003Z');
  await assert.rejects(
    publishRun({
      reportRoot,
      runId: next.runId,
      findings: next,
      writeArtifacts: async () => { callbackRan = true; },
    }),
    (error) => error?.code === 'RUN_STAGE_RECOVERY_FAILED',
  );
  assert.equal(callbackRan, false);
  assert.equal(await readFile(path.join(mismatched, 'canary.txt'), 'utf8'), 'do-not-delete\n');
});

test('rejects run collisions before callback without clobbering the immutable publication', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-no-clobber-');
  const findings = findingsFor('2026-07-18T13-00-02-004Z');
  await publish(reportRoot, findings);
  const runPath = path.join(reportRoot, findings.runId);
  const before = await stat(runPath, { bigint: true });
  const historyBefore = await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8');
  let callbackRan = false;
  await assert.rejects(
    publishRun({
      reportRoot,
      runId: findings.runId,
      findings,
      writeArtifacts: async () => { callbackRan = true; },
    }),
    (error) => error?.code === 'RUN_ALREADY_EXISTS',
  );
  const after = await stat(runPath, { bigint: true });
  assert.equal(callbackRan, false);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8'), historyBefore);
});

test('rejects accessor inputs and accessor callback results before unsafe side effects', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sentinel-run-accessor-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const reportRoot = path.join(parent, 'sentinel-v2');
  const findings = findingsFor('2026-07-18T13-00-02-005Z');
  let inputReads = 0;
  const options = {
    reportRoot,
    runId: findings.runId,
    writeArtifacts: async () => {},
  };
  Object.defineProperty(options, 'findings', {
    enumerable: true,
    get() {
      inputReads += 1;
      return findings;
    },
  });
  await assert.rejects(
    publishRun(options),
    (error) => error?.code === 'RUN_PUBLISH_INPUT_INVALID',
  );
  assert.equal(inputReads, 0);
  await assert.rejects(access(reportRoot, fsConstants.F_OK));

  const proxyCanary = 'proxy-secret-must-not-escape';
  await assert.rejects(
    publishRun(new Proxy({}, {
      getPrototypeOf() {
        throw new Error(proxyCanary);
      },
    })),
    (error) => error?.code === 'RUN_PUBLISH_INPUT_INVALID'
      && !error.message.includes(proxyCanary),
  );

  const symbolOptions = {
    reportRoot,
    runId: findings.runId,
    writeArtifacts: async () => {},
  };
  symbolOptions[Symbol('hidden-input')] = 'rejected';
  await assert.rejects(
    publishRun(symbolOptions),
    (error) => error?.code === 'RUN_PUBLISH_INPUT_INVALID',
  );
  await assert.rejects(access(reportRoot, fsConstants.F_OK));

  await mkdir(reportRoot, { mode: 0o700 });
  let resultReads = 0;
  await assert.rejects(
    publishRun({
      reportRoot,
      runId: findings.runId,
      writeArtifacts: async (boundary) => {
        await boundary.writeJson('sentinel-manifest.json', manifest);
        const result = {};
        Object.defineProperty(result, 'findings', {
          enumerable: true,
          get() {
            resultReads += 1;
            return findings;
          },
        });
        return result;
      },
    }),
    (error) => error?.code === 'RUN_FINDINGS_INVALID',
  );
  assert.equal(resultReads, 0);
  await assertNoStaging(reportRoot);
});

test('rejects symlinked required artifacts without reading or changing the target', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-artifact-symlink-');
  const findings = findingsFor('2026-07-18T13-00-02-006Z');
  const victim = path.join(path.dirname(reportRoot), 'victim.json');
  await writeFile(victim, '{"outside":true}\n', { mode: 0o600 });
  await assert.rejects(
    publishRun({
      reportRoot,
      runId: findings.runId,
      writeArtifacts: async (boundary) => {
        await symlink(victim, path.join(boundary.root, 'sentinel-manifest.json'));
        return { findings };
      },
    }),
    (error) => error?.code === 'RUN_MANIFEST_INVALID',
  );
  assert.equal(await readFile(victim, 'utf8'), '{"outside":true}\n');
  await assert.rejects(access(path.join(reportRoot, findings.runId), fsConstants.F_OK));
  await assertNoStaging(reportRoot);
});

test('recovers a complete marker-bound run interrupted after public rename before new work', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-rename-crash-');
  const orphan = findingsFor('2026-07-18T13-00-03-000Z');
  const originalRename = fsPromises.rename;
  let interrupted = false;
  fsPromises.rename = async (source, destination) => {
    if (!interrupted
        && STAGING_NAME.test(path.basename(source))
        && path.basename(destination) === orphan.runId) {
      interrupted = true;
      await originalRename(source, destination);
      throw Object.assign(new Error('injected crash gap'), { code: 'EIO' });
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      publish(reportRoot, orphan),
      (error) => error?.code === 'RUN_PUBLISH_FAILED',
    );
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(interrupted, true);
  assert.ok((await stat(path.join(reportRoot, orphan.runId))).isDirectory());
  await assert.rejects(access(path.join(reportRoot, 'sweep-history.json'), fsConstants.F_OK));

  const next = findingsFor('2026-07-18T13-00-04-000Z');
  let recoveredBeforeCallback = false;
  await publish(reportRoot, next, async () => {
    recoveredBeforeCallback = (await rawHistory(reportRoot)).runs
      .some((entry) => entry.runId === orphan.runId);
  });
  assert.equal(recoveredBeforeCallback, true);
  assert.deepEqual(
    (await rawHistory(reportRoot)).runs.map((entry) => entry.runId),
    [orphan.runId, next.runId],
  );
  assert.equal(await readlink(path.join(reportRoot, 'latest')), next.runId);
});

test('rolls history and latest back on a known latest failure and retries the orphan exactly', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-latest-rollback-');
  const older = findingsFor('2026-07-18T13-00-05-000Z');
  const newer = findingsFor('2026-07-18T13-00-06-000Z');
  await publish(reportRoot, older);
  const historyBefore = await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8');
  const latestBefore = await readlink(path.join(reportRoot, 'latest'));

  const originalRename = fsPromises.rename;
  let blocked = false;
  fsPromises.rename = async (source, destination) => {
    if (!blocked && path.basename(destination) === 'latest') {
      blocked = true;
      throw Object.assign(new Error('injected latest failure'), { code: 'EIO' });
    }
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      publish(reportRoot, newer),
      (error) => error?.code === 'LATEST_REPLACE_FAILED',
    );
  } finally {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(blocked, true);
  assert.equal(await readFile(path.join(reportRoot, 'sweep-history.json'), 'utf8'), historyBefore);
  assert.equal(await readlink(path.join(reportRoot, 'latest')), latestBefore);
  assert.ok((await stat(path.join(reportRoot, newer.runId))).isDirectory());

  let callbackRan = false;
  const retried = await publish(reportRoot, newer, async () => {
    callbackRan = true;
  });
  assert.equal(callbackRan, false);
  assert.deepEqual(retried.history.runs.map((entry) => entry.runId), [older.runId, newer.runId]);
  assert.equal(await readlink(path.join(reportRoot, 'latest')), newer.runId);
});

test('keeps latest monotonic when an older run finishes after a newer run', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-monotonic-');
  const newer = findingsFor('2026-07-18T13-00-08-000Z');
  const older = findingsFor('2026-07-18T13-00-07-000Z');
  await publish(reportRoot, newer);
  const result = await publish(reportRoot, older);
  assert.deepEqual(result.history.runs.map((entry) => entry.runId), [older.runId, newer.runId]);
  assert.equal(result.latestRunId, newer.runId);
  assert.equal(await readlink(path.join(reportRoot, 'latest')), newer.runId);
});

test('waits for a healthy long-running owner instead of failing at five seconds', {
  timeout: 15_000,
}, async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-long-owner-');
  const first = findingsFor('2026-07-18T13-00-09-000Z');
  const second = findingsFor('2026-07-18T13-00-10-000Z');
  let releaseFirst;
  const firstReady = new Promise((resolve) => { releaseFirst = resolve; });
  const slow = publish(reportRoot, first, async () => {
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 5_250));
  });
  await firstReady;
  const waiting = publish(reportRoot, second);
  const [firstResult, secondResult] = await Promise.all([slow, waiting]);
  assert.equal(firstResult.runId, first.runId);
  assert.equal(secondResult.runId, second.runId);
  assert.equal(await readlink(path.join(reportRoot, 'latest')), second.runId);
});

test('rejects the 129th run before creating staging or invoking the artifact callback', {
  timeout: 30_000,
}, async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-capacity-');
  const runs = [];
  for (let index = 0; index < 128; index += 1) {
    const runId = `2026-07-18T13-01-00-000Z-${index.toString(16).padStart(8, '0')}`;
    const findings = findingsFor(runId);
    const directory = path.join(reportRoot, runId);
    const markerToken = (index + 1).toString(16).padStart(64, '0');
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, '.sentinel-run-identity-v2'), `${markerToken}\n`, {
      mode: 0o600,
    });
    const identity = await stat(directory, { bigint: true });
    runs.push({
      runId,
      startedAt: findings.startedAt,
      finishedAt: findings.finishedAt,
      coverageStatus: findings.coverage.status,
      summary: findings.summary,
      findingsDigest: digest(findings),
      markerToken,
      dev: String(identity.dev),
      ino: String(identity.ino),
      birthtimeNs: String(identity.birthtimeNs),
      uid: String(identity.uid),
      mode: String(identity.mode),
    });
  }
  await writeFile(
    path.join(reportRoot, 'sweep-history.json'),
    `${JSON.stringify({ schemaVersion: '2.0', runs }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await symlink(runs.at(-1).runId, path.join(reportRoot, 'latest'), 'dir');
  let callbackRan = false;
  const next = findingsFor('2026-07-18T13-02-00-000Z');
  await assert.rejects(
    publishRun({
      reportRoot,
      runId: next.runId,
      findings: next,
      writeArtifacts: async () => { callbackRan = true; },
    }),
    (error) => error?.code === 'HISTORY_LIMIT_EXCEEDED',
  );
  assert.equal(callbackRan, false);
  await assert.rejects(access(path.join(reportRoot, next.runId), fsConstants.F_OK));
  await assertNoStaging(reportRoot);
});

test('clean recovers metadata and leaves latest pointing at a retained complete run', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-clean-latest-');
  const runs = [
    findingsFor('2026-07-18T13-03-00-000Z'),
    findingsFor('2026-07-18T13-03-01-000Z'),
    findingsFor('2026-07-18T13-03-02-000Z'),
  ];
  for (const findings of runs) await publish(reportRoot, findings);
  await unlink(path.join(reportRoot, 'latest'));
  await symlink(runs[0].runId, path.join(reportRoot, 'latest'), 'dir');

  const result = await cleanRuns({ reportRoot, keep: 1 });
  assert.deepEqual(result, {
    kept: [runs[2].runId],
    removed: [runs[0].runId, runs[1].runId],
  });
  assert.equal(await readlink(path.join(reportRoot, 'latest')), runs[2].runId);
  assert.ok((await stat(path.join(reportRoot, runs[2].runId))).isDirectory());
});

test('safe readers validate tracked runs and never follow report/run symlinks', async (t) => {
  const reportRoot = await temporaryRoot(t, 'sentinel-run-reader-');
  const findings = findingsFor('2026-07-18T13-04-00-000Z');
  await publish(reportRoot, findings);
  const history = await readSweepHistory({ reportRoot });
  const published = await readPublishedRun({ reportRoot, runId: findings.runId });
  assert.deepEqual(history.runs.map((entry) => entry.runId), [findings.runId]);
  assert.deepEqual(published.findings, findings);
  assert.deepEqual(published.manifest, manifest);
  assert.equal(published.markdown, renderMarkdown(findings));

  const exactHistory = await rawHistory(reportRoot);
  const tamperedHistory = structuredClone(exactHistory);
  tamperedHistory.runs[0].summary.warning += 1;
  await writeFile(
    path.join(reportRoot, 'sweep-history.json'),
    `${JSON.stringify(tamperedHistory, null, 2)}\n`,
    { mode: 0o600 },
  );
  await assert.rejects(
    readPublishedRun({ reportRoot, runId: findings.runId }),
    (error) => error?.code === 'HISTORY_RUN_METADATA_INVALID',
  );
  await writeFile(
    path.join(reportRoot, 'sweep-history.json'),
    `${JSON.stringify(exactHistory, null, 2)}\n`,
    { mode: 0o600 },
  );

  const parent = path.dirname(reportRoot);
  const alias = path.join(parent, 'alias-v2');
  await symlink(reportRoot, alias, 'dir');
  await assert.rejects(
    readSweepHistory({ reportRoot: alias }),
    (error) => ['REPORT_ROOT_VERSION_INVALID', 'REPORT_ROOT_SYMLINK'].includes(error?.code),
  );

  const outside = path.join(parent, 'outside-run');
  await mkdir(outside, { mode: 0o700 });
  await chmod(outside, 0o700);
  const runPath = path.join(reportRoot, findings.runId);
  await rm(runPath, { recursive: true });
  await symlink(outside, runPath, 'dir');
  await assert.rejects(
    readPublishedRun({ reportRoot, runId: findings.runId }),
    (error) => [
      'CLEAN_RUN_SYMLINK',
      'CLEAN_HISTORY_MISMATCH',
      'HISTORY_RUN_IDENTITY_INVALID',
      'HISTORY_RUN_MISSING',
    ]
      .includes(error?.code),
  );
});
