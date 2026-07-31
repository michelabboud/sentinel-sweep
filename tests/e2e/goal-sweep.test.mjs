import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateAgainstSchema } from '../../runtime/lib/schema.mjs';
import { startGoalApp } from '../fixtures/goal-app/server.mjs';

const PACKAGE_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const FIXTURE_ROOT = path.join(PACKAGE_ROOT, 'tests/fixtures/goal-app');
const CLI = path.join(PACKAGE_ROOT, 'runtime/cli.mjs');
const ADMIN_TOKEN = 'goal-admin+secret/2026alpha==';
const USER_TOKEN = 'goal-user+secret/2026beta==';
const TARGET_ENV_CANARY = 'target-env-canary-must-never-appear';
const TARGET_FILE_AUTH_CANARY = 'target-file-must-never-authorize';
const BLOCKED_FILENAME_CANARY = 'blocked-filename-canary-must-never-appear';
const RUN_IDS = Object.freeze({
  first: '2026-07-18T12-00-00-001Z-a1b2c3d4',
  second: '2026-07-18T12-00-00-002Z-b1c2d3e4',
  failed: '2026-07-18T12-00-00-003Z-c1d2e3f4',
  concurrentA: '2026-07-18T12-00-00-004Z-d1e2f3a4',
  concurrentB: '2026-07-18T12-00-00-005Z-e1f2a3b4',
});

const FINDINGS_SCHEMA = JSON.parse(
  await readFile(path.join(PACKAGE_ROOT, 'schemas/findings.schema.json'), 'utf8'),
);
const MANIFEST_SCHEMA = JSON.parse(
  await readFile(path.join(PACKAGE_ROOT, 'schemas/sentinel-manifest.schema.json'), 'utf8'),
);
const HISTORY_SCHEMA = JSON.parse(
  await readFile(path.join(PACKAGE_ROOT, 'schemas/sweep-history.schema.json'), 'utf8'),
);

function childEnvironment(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.SENTINEL_ALLOW_MISSING_CHROME_FOR_UNIT_TESTS;
  return env;
}

function runProcess(executable, args, { cwd, env, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    const observation = typeof onSpawn === 'function'
      ? Promise.resolve().then(() => onSpawn(child.pid))
      : Promise.resolve(null);
    observation.catch(() => child.kill('SIGKILL'));
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const collect = (target, chunk, stream) => {
      const next = stream === 'stdout' ? stdoutBytes + chunk.length : stderrBytes + chunk.length;
      if (next > 16 * 1024 * 1024) {
        child.kill('SIGKILL');
        reject(new Error(`child ${stream} exceeded the test capture limit`));
        return;
      }
      if (stream === 'stdout') stdoutBytes = next;
      else stderrBytes = next;
      target.push(chunk);
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(stderr, chunk, 'stderr'));
    child.once('error', reject);
    child.once('close', async (exitCode, signal) => {
      try {
        resolve({
          pid: child.pid,
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          observation: await observation,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runCli(args, context) {
  return runProcess(process.execPath, [CLI, ...args], context);
}

async function executableChrome() {
  const candidates = [
    process.env.SENTINEL_E2E_CHROME,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/google-chrome',
  ].filter((value) => typeof value === 'string' && path.isAbsolute(value));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through the trusted fixed candidate list. E2E never skips.
    }
  }
  throw new Error('Task 11 requires a real system Chrome executable');
}

function trustedConfig(origin, chromePath, overrides = {}) {
  return {
    schemaVersion: '2.0',
    requireConfigPath: true,
    reportDir: 'sentinel-output',
    approvedOrigins: [origin],
    roles: {
      admin: { tokenRef: 'env:SENTINEL_GOAL_ADMIN_TOKEN' },
      user: { tokenRef: 'env:SENTINEL_GOAL_USER_TOKEN' },
    },
    allowMutations: false,
    mutationAllowlist: [],
    allowNonLoopback: false,
    targetEnvironment: 'test',
    requireCompleteCoverage: true,
    responseTimeoutMs: 5000,
    browserSettleMs: 150,
    viewports: [375],
    chromePath,
    emptyContainerSelectors: ['#empty'],
    screenshotOnError: true,
    maxResponseBytes: 1024,
    discovery: {
      openapi: ['openapi.json'],
      vueRouter: ['src/router.js'],
    },
    trustedOverrides: {
      operations: {
        '4ebcfbf48f6c96aeeb09c6a09bb2ae383d006ff8198a62c0fe6a1d3335c00acf': {
          allowedRoles: ['admin'],
        },
        '53714ab482f1ca024f22a9c46a33a7b232860ddae7ae0439e5da0666625fbcef': {
          allowedRoles: ['user'],
        },
      },
      routes: {
        '9fce8a089929fb3b2fcd7c2b4f4dabd2aa5f0ad6581e4eb955b5308bfd0ad345': {
          allowedRoles: ['admin'],
        },
        'a8bee89b1786a13f5c87c4956d3b5231f76dc80d0d64077bf28231ae006b7444': {
          allowedRoles: ['admin'],
        },
      },
    },
    services: [{ name: 'goal', approvedOrigin: origin }],
    ...overrides,
  };
}

async function writeConfig(filePath, config, mode = 0o600) {
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode });
  await chmod(filePath, mode);
}

function parseJsonOutput(result) {
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const parsed = JSON.parse(result.stdout);
  assert.equal(typeof parsed, 'object');
  return parsed;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function manifestContract(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    coverage: manifest.coverage.status,
    operationIds: manifest.operations.map((entry) => entry.id).sort(),
    routeIds: manifest.routes.map((entry) => entry.id).sort(),
  };
}

function findingIdentityContract(findings) {
  return findings.findings.map((entry) => ({
    id: entry.id,
    reasonCode: entry.reasonCode,
    outcome: entry.outcome,
    severity: entry.severity,
    category: entry.category,
    subject: entry.subject,
    role: entry.role,
  })).sort((left, right) => {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
}

function markdownSummary(markdown) {
  const labels = {
    Critical: 'critical',
    Error: 'error',
    Warning: 'warning',
    Info: 'info',
    Skipped: 'skipped',
  };
  const summary = {};
  for (const [label, key] of Object.entries(labels)) {
    const match = new RegExp(`\\| ${label} \\| ([0-9]+) \\|`, 'u').exec(markdown);
    assert.ok(match, `Markdown is missing the ${label} summary row`);
    summary[key] = Number(match[1]);
  }
  return summary;
}

function dashboardSummary(dashboard) {
  const match = /<script id="sentinel-summary" type="application\/json">([^<]+)<\/script>/u
    .exec(dashboard);
  assert.ok(match, 'dashboard is missing canonical summary JSON');
  return JSON.parse(match[1]);
}

function assertPrSummary(prComment, summary) {
  const text = `**Summary:** Critical ${summary.critical} · Error ${summary.error}`
    + ` · Warning ${summary.warning} · Info ${summary.info} · Skipped ${summary.skipped}`;
  assert.ok(prComment.includes(text));
}

async function collectFiles(root) {
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) files.push(fullPath);
    }
  }
  await visit(root);
  return files;
}

async function assertPrivateTree(root) {
  async function visit(current) {
    const currentStat = await lstat(current);
    assert.equal(currentStat.mode & 0o777, 0o700, `directory is not private: ${path.basename(current)}`);
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) {
        const stat = await lstat(fullPath);
        assert.equal(stat.mode & 0o777, 0o600, `artifact is not private: ${entry.name}`);
      }
    }
  }
  await visit(root);
}

function encodedNeedles(value) {
  return new Set([
    value,
    Buffer.from(value).toString('base64'),
    Buffer.from(value).toString('base64url'),
    encodeURIComponent(value),
  ]);
}

async function assertSecretFree({ roots, captures }) {
  const needles = new Set([
    ...encodedNeedles(ADMIN_TOKEN),
    ...encodedNeedles(USER_TOKEN),
    ...encodedNeedles(TARGET_ENV_CANARY),
    ...encodedNeedles(TARGET_FILE_AUTH_CANARY),
    ...encodedNeedles(BLOCKED_FILENAME_CANARY),
  ]);
  const buffers = captures.map((value) => Buffer.from(value));
  for (const root of roots) {
    for (const file of await collectFiles(root)) buffers.push(await readFile(file));
  }
  for (const buffer of buffers) {
    for (const needle of needles) {
      assert.equal(buffer.includes(Buffer.from(needle)), false, 'a credential canary escaped');
    }
  }
}

async function chromeProfileProcessSnapshot() {
  if (process.platform !== 'linux') return new Map();
  const processes = new Map();
  const entries = await readdir('/proc', { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) continue;
    try {
      const command = await readFile(path.join('/proc', entry.name, 'cmdline'));
      if (command.includes(Buffer.from('.chrome-profile-'))
          || command.includes(Buffer.from('chrome_crashpad_handler'))) {
        processes.set(entry.name, command.toString('utf8'));
      }
    } catch {
      // Processes may exit while /proc is inspected.
    }
  }
  return processes;
}

function relevantChromeProcesses(baseline, current, processMarkers, uniqueRoot) {
  return [...current]
    .filter(([pid, command]) => baseline.get(pid) !== command
      && (processMarkers.some((marker) => command.includes(marker))
        || command.includes(uniqueRoot)))
    .map(([pid, command]) => ({ pid, command }));
}

async function observeSpawnedChromeProfile(baseline, cliPid, uniqueRoot) {
  assert.equal(Number.isInteger(cliPid), true, 'CLI child PID was not captured');
  const processMarkers = [
    `/proc/${cliPid}/fd/`,
    `.chrome-profile-${cliPid}-`,
  ];
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const observed = relevantChromeProcesses(
      baseline,
      await chromeProfileProcessSnapshot(),
      processMarkers,
      uniqueRoot,
    ).filter(({ command }) => command.includes('--user-data-dir='));
    if (observed.length > 0) return observed;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [];
}

async function assertNoSpawnedChromeProfiles(baseline, results, uniqueRoot, phase) {
  for (const result of results) {
    assert.equal(Number.isInteger(result.pid), true, `${phase} did not capture a CLI child PID`);
  }
  const processMarkers = results.flatMap((result) => [
    `/proc/${result.pid}/fd/`,
    `.chrome-profile-${result.pid}-`,
  ]);
  let leaked = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await chromeProfileProcessSnapshot();
    leaked = relevantChromeProcesses(baseline, current, processMarkers, uniqueRoot);
    if (leaked.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(leaked, [], `${phase} left Chrome profile processes running`);
}

async function invokeConsumer(command, args, context, expectedExit = 0) {
  const result = await runCli([command, ...args, '--json'], context);
  assert.equal(result.exitCode, expectedExit, JSON.stringify({
    command,
    args,
    stdout: result.stdout,
    stderr: result.stderr,
  }));
  parseJsonOutput(result);
  return result;
}

test('proves the packaged Sentinel goal against real HTTP and mandatory Chrome', {
  timeout: 180_000,
}, async (t) => {
  // The documented floor is Node 18+. Pinning the proof to exactly 18 would
  // force running an EOL runtime (18 left support 2025-04); instead the gate
  // asserts the floor and the evidence records which runtime actually proved it.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  assert.ok(nodeMajor >= 18, `goal proof requires Node 18+; running on ${process.versions.node}`);
  const chromePath = await executableChrome();
  const chromeVersion = await runProcess(chromePath, ['--version']);
  assert.equal(chromeVersion.exitCode, 0, chromeVersion.stderr);
  assert.match(
    chromeVersion.stdout.trim(),
    /^(?:Google Chrome(?: for Testing)?|Chromium) [0-9]+(?:\.[0-9]+){3}$/u,
  );
  const chromeBaseline = await chromeProfileProcessSnapshot();
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-goal-e2e-'));
  const targetRoot = path.join(temporary, 'target app פרויקט');
  const operatorRoot = path.join(temporary, 'operator');
  const unrelatedCwd = path.join(temporary, 'unrelated cwd');
  const consumersRoot = path.join(temporary, 'consumer artifacts');
  await Promise.all([
    cp(FIXTURE_ROOT, targetRoot, { recursive: true, dereference: false }),
    mkdir(operatorRoot, { mode: 0o700 }),
    mkdir(unrelatedCwd, { mode: 0o700 }),
    mkdir(consumersRoot, { mode: 0o700 }),
  ]);
  const fixture = await startGoalApp({ root: targetRoot, adminToken: ADMIN_TOKEN, userToken: USER_TOKEN });
  t.after(async () => {
    await fixture.close();
    await rm(temporary, { recursive: true, force: true });
  });

  const configPath = path.join(operatorRoot, 'sentinel trusted config.json');
  const config = trustedConfig(fixture.origin, chromePath);
  await writeConfig(configPath, config);
  const env = childEnvironment({
    SENTINEL_GOAL_ADMIN_TOKEN: ADMIN_TOKEN,
    SENTINEL_GOAL_USER_TOKEN: USER_TOKEN,
  });
  const context = { cwd: unrelatedCwd, env };
  const common = ['--target', targetRoot, '--config', configPath];
  const captures = [];

  const insecurePath = path.join(operatorRoot, 'insecure.json');
  await writeConfig(insecurePath, config, 0o644);
  const beforeInsecure = await fixture.readCounters();
  const insecure = await runCli([
    'sweep', '--target', targetRoot, '--config', insecurePath, '--run-id', RUN_IDS.failed, '--json',
  ], context);
  captures.push(insecure.stdout, insecure.stderr);
  assert.equal(insecure.exitCode, 1);
  assert.equal(JSON.parse(insecure.stdout).code, 'CLI_COMMAND_FAILED');
  assert.deepEqual(await fixture.readCounters(), beforeInsecure, 'insecure config caused target traffic');

  const first = await runCli(['sweep', ...common, '--run-id', RUN_IDS.first, '--json'], {
    ...context,
    onSpawn: (pid) => observeSpawnedChromeProfile(chromeBaseline, pid, temporary),
  });
  assert.ok(first.observation.length > 0, JSON.stringify({
    message: 'controlled sweep did not expose its Chrome profile process',
    exitCode: first.exitCode,
    stdout: first.stdout,
    stderr: first.stderr,
  }));
  await assertNoSpawnedChromeProfiles(chromeBaseline, [first], temporary, 'first sweep');
  const second = await runCli(['sweep', ...common, '--run-id', RUN_IDS.second, '--json'], context);
  await assertNoSpawnedChromeProfiles(chromeBaseline, [second], temporary, 'second sweep');
  captures.push(first.stdout, first.stderr, second.stdout, second.stderr);
  const firstStatus = JSON.parse(first.stdout);
  const secondStatus = JSON.parse(second.stdout);
  assert.equal(first.exitCode, 2, JSON.stringify({
    code: firstStatus.code,
    failedEngines: firstStatus.failedEngines,
  }));
  assert.equal(second.exitCode, 2, JSON.stringify({
    code: secondStatus.code,
    failedEngines: secondStatus.failedEngines,
  }));
  const firstTerminal = parseJsonOutput(first);
  const secondTerminal = parseJsonOutput(second);

  const reportRoot = path.join(targetRoot, 'sentinel-output', 'sentinel-v2');
  const firstRoot = path.join(reportRoot, RUN_IDS.first);
  const secondRoot = path.join(reportRoot, RUN_IDS.second);
  const [firstManifest, secondManifest, expectedManifest] = await Promise.all([
    readJson(path.join(firstRoot, 'sentinel-manifest.json')),
    readJson(path.join(secondRoot, 'sentinel-manifest.json')),
    readJson(path.join(targetRoot, 'expected-manifest.json')),
  ]);
  validateAgainstSchema(firstManifest, MANIFEST_SCHEMA, { name: 'first goal manifest' });
  validateAgainstSchema(secondManifest, MANIFEST_SCHEMA, { name: 'second goal manifest' });
  assert.deepEqual(manifestContract(firstManifest), expectedManifest);
  assert.deepEqual(manifestContract(secondManifest), expectedManifest);
  assert.deepEqual(manifestContract(firstManifest), manifestContract(secondManifest));
  assert.equal(firstManifest.coverage.diagnostics.length, 0);
  assert.equal(secondManifest.coverage.diagnostics.length, 0);

  const [firstFindings, secondFindings, expectedFindings] = await Promise.all([
    readJson(path.join(firstRoot, 'sentinel-findings.json')),
    readJson(path.join(secondRoot, 'sentinel-findings.json')),
    readJson(path.join(targetRoot, 'expected-findings.json')),
  ]);
  validateAgainstSchema(firstFindings, FINDINGS_SCHEMA, { name: 'first goal findings' });
  validateAgainstSchema(secondFindings, FINDINGS_SCHEMA, { name: 'second goal findings' });
  assert.equal(firstFindings.coverage.status, 'complete');
  assert.equal(secondFindings.coverage.status, 'complete');
  assert.deepEqual(firstFindings.summary, secondFindings.summary);
  assert.deepEqual(firstTerminal.summary, firstFindings.summary);
  assert.deepEqual(secondTerminal.summary, secondFindings.summary);
  assert.deepEqual(findingIdentityContract(firstFindings), findingIdentityContract(secondFindings));
  if (firstFindings.findings.length !== expectedFindings.count) {
    // Environment-sensitive checks (fonts, GPU, viewport metrics) surface as
    // count drift; the histogram names exactly which findings differ.
    const histogram = {};
    for (const finding of firstFindings.findings) {
      const key = `${finding.source}:${finding.category}:${finding.reasonCode}:${finding.subjectId}`;
      histogram[key] = (histogram[key] ?? 0) + 1;
    }
    console.error(`finding histogram (${firstFindings.findings.length} findings):`, JSON.stringify(histogram, null, 1));
  }
  assert.equal(firstFindings.findings.length, expectedFindings.count);
  assert.deepEqual(firstFindings.summary, expectedFindings.summary);
  assert.deepEqual(findingIdentityContract(firstFindings), expectedFindings.identities);
  assert.ok(firstFindings.summary.critical > 0 || firstFindings.summary.error > 0);

  for (const [runRoot, findings] of [[firstRoot, firstFindings], [secondRoot, secondFindings]]) {
    const [markdown, dashboard, prComment] = await Promise.all([
      readFile(path.join(runRoot, 'sweep.md'), 'utf8'),
      readFile(path.join(runRoot, 'dashboard.html'), 'utf8'),
      readFile(path.join(runRoot, 'pr-comment.md'), 'utf8'),
    ]);
    assert.deepEqual(markdownSummary(markdown), findings.summary);
    assert.deepEqual(dashboardSummary(dashboard), findings.summary);
    assertPrSummary(prComment, findings.summary);
    assert.ok(findings.findings.filter((entry) => entry.role !== null)
      .every((entry) => entry.evidence.screenshotPath === undefined));
    assert.ok(findings.findings.filter((entry) => entry.evidence.screenshotPath !== undefined)
      .every((entry) => entry.role === null));
  }

  const history = await readJson(path.join(reportRoot, 'sweep-history.json'));
  validateAgainstSchema(history, HISTORY_SCHEMA, { name: 'goal sweep history' });
  assert.deepEqual(history.runs.map((entry) => entry.runId), [RUN_IDS.first, RUN_IDS.second]);
  assert.deepEqual(history.runs[0].summary, firstFindings.summary);
  assert.deepEqual(history.runs[1].summary, secondFindings.summary);
  assert.equal(await readlink(path.join(reportRoot, 'latest')), RUN_IDS.second);

  const failedConfigPath = path.join(operatorRoot, 'missing chrome.json');
  await writeConfig(failedConfigPath, { ...config, chromePath: '/definitely/missing/chrome' });
  const failedBrowser = await runCli([
    'browser', '--target', targetRoot, '--config', failedConfigPath,
    '--run-id', RUN_IDS.failed, '--json',
  ], context);
  await assertNoSpawnedChromeProfiles(
    chromeBaseline,
    [failedBrowser],
    temporary,
    'failed browser run',
  );
  captures.push(failedBrowser.stdout, failedBrowser.stderr);
  assert.equal(failedBrowser.exitCode, 1);
  assert.equal(await readlink(path.join(reportRoot, 'latest')), RUN_IDS.second);
  await assert.rejects(lstat(path.join(reportRoot, RUN_IDS.failed)), { code: 'ENOENT' });

  const concurrentArgs = (runId) => [
    'api', '--target', targetRoot, '--config', failedConfigPath, '--run-id', runId, '--json',
  ];
  const [concurrentA, concurrentB] = await Promise.all([
    runCli(concurrentArgs(RUN_IDS.concurrentA), context),
    runCli(concurrentArgs(RUN_IDS.concurrentB), context),
  ]);
  await assertNoSpawnedChromeProfiles(
    chromeBaseline,
    [concurrentA, concurrentB],
    temporary,
    'concurrent API-only runs',
  );
  captures.push(concurrentA.stdout, concurrentA.stderr, concurrentB.stdout, concurrentB.stderr);
  assert.equal(concurrentA.exitCode, 2, 'API-only mode incorrectly required Chrome');
  assert.equal(concurrentB.exitCode, 2, 'API-only mode incorrectly required Chrome');
  parseJsonOutput(concurrentA);
  parseJsonOutput(concurrentB);
  const concurrentHistory = await readJson(path.join(reportRoot, 'sweep-history.json'));
  validateAgainstSchema(concurrentHistory, HISTORY_SCHEMA, { name: 'concurrent history' });
  assert.deepEqual(new Set(concurrentHistory.runs.map((entry) => entry.runId)), new Set([
    RUN_IDS.first,
    RUN_IDS.second,
    RUN_IDS.concurrentA,
    RUN_IDS.concurrentB,
  ]));
  const latestAfterConcurrent = await readlink(path.join(reportRoot, 'latest'));
  assert.ok([RUN_IDS.concurrentA, RUN_IDS.concurrentB].includes(latestAfterConcurrent));
  await Promise.all([
    access(path.join(reportRoot, RUN_IDS.concurrentA, 'sentinel-findings.json')),
    access(path.join(reportRoot, RUN_IDS.concurrentB, 'sentinel-findings.json')),
  ]);

  const reportCopy = path.join(consumersRoot, 'report.md');
  const dashboardCopy = path.join(consumersRoot, 'dashboard.html');
  captures.push((await invokeConsumer('report', [
    ...common, '--run', RUN_IDS.second, '--output', reportCopy,
  ], context)).stdout);
  captures.push((await invokeConsumer('dashboard', [
    ...common, '--run', RUN_IDS.second, '--output', dashboardCopy,
  ], context)).stdout);
  assert.equal(await readFile(reportCopy, 'utf8'), await readFile(path.join(secondRoot, 'sweep.md'), 'utf8'));
  assert.equal(await readFile(dashboardCopy, 'utf8'), await readFile(path.join(secondRoot, 'dashboard.html'), 'utf8'));
  for (const format of ['postman', 'insomnia', 'bruno']) {
    const output = path.join(consumersRoot, `${format}-export`);
    const result = await invokeConsumer('export', [
      ...common, '--run', RUN_IDS.second, '--format', format, '--output', output,
    ], context);
    captures.push(result.stdout, result.stderr);
  }
  const trends = await invokeConsumer('trends', common, context);
  const diff = await invokeConsumer('diff', [
    ...common, '--run', RUN_IDS.second, '--against', RUN_IDS.first,
  ], context);
  captures.push(trends.stdout, trends.stderr, diff.stdout, diff.stderr);

  const partialConfigPath = path.join(operatorRoot, 'partial discovery.json');
  await writeConfig(partialConfigPath, trustedConfig(fixture.origin, chromePath, {
    requireCompleteCoverage: false,
    discovery: { vueRouter: ['adversarial/hostile-router.js'] },
    trustedOverrides: { operations: {}, routes: {} },
  }));
  const partialOutput = path.join(consumersRoot, 'partial-manifest.json');
  const partial = await runCli([
    'manifest', '--target', targetRoot, '--config', partialConfigPath,
    '--output', partialOutput, '--json',
  ], context);
  captures.push(partial.stdout, partial.stderr);
  assert.equal(partial.exitCode, 0);
  assert.equal(parseJsonOutput(partial).coverage, 'partial');
  const partialManifest = await readJson(partialOutput);
  assert.deepEqual(partialManifest.routes.map((entry) => entry.id), [
    'c6825cc0659af85cd3a428e81ace06f246f2cef78f82e7572280d2b4a53d6917',
  ]);
  assert.equal(partialManifest.operations.length, 0);
  assert.ok(partialManifest.coverage.diagnostics.length > 0);

  await symlink('openapi.json', path.join(targetRoot, 'linked-openapi.json'));
  const linkedConfigPath = path.join(operatorRoot, 'linked discovery.json');
  await writeConfig(linkedConfigPath, trustedConfig(fixture.origin, chromePath, {
    discovery: { openapi: ['linked-openapi.json'] },
    trustedOverrides: { operations: {}, routes: {} },
  }));
  const linked = await runCli([
    'manifest', '--target', targetRoot, '--config', linkedConfigPath,
    '--output', path.join(consumersRoot, 'must-not-exist.json'), '--json',
  ], context);
  captures.push(linked.stdout, linked.stderr);
  assert.equal(linked.exitCode, 1);
  assert.equal(JSON.parse(linked.stdout).code, 'CLI_COMMAND_FAILED');

  const traversalConfigPath = path.join(operatorRoot, 'traversal discovery.json');
  await writeConfig(traversalConfigPath, trustedConfig(fixture.origin, chromePath, {
    discovery: { openapi: ['../outside.json'] },
    trustedOverrides: { operations: {}, routes: {} },
  }));
  const traversal = await runCli([
    'manifest', '--target', targetRoot, '--config', traversalConfigPath,
    '--output', path.join(consumersRoot, 'must-not-exist-traversal.json'), '--json',
  ], context);
  captures.push(traversal.stdout, traversal.stderr);
  assert.equal(traversal.exitCode, 1);
  assert.equal(JSON.parse(traversal.stdout).code, 'CLI_COMMAND_FAILED');

  const counters = await fixture.readCounters();
  assert.deepEqual(counters.mutations, {
    apiPost: 0,
    apiDelete: 0,
    pagePost: 0,
    pageDelete: 0,
    dedicatedWorkerMutation: 0,
    sharedWorkerMutation: 0,
    serviceWorkerMutation: 0,
    popupMutation: 0,
    framePost: 0,
    frameDelete: 0,
    internalNavigation: 0,
    pageWebSocket: 0,
    workerWebSocket: 0,
  });
  assert.deepEqual(counters.receiver, { requests: 0, authorizationHeaders: 0 });
  for (const entry of await readdir(reportRoot)) {
    assert.equal(entry.startsWith('.chrome-profile-'), false, 'Chrome profile survived cleanup');
  }

  await assertPrivateTree(reportRoot);
  await assertPrivateTree(consumersRoot);
  await assertSecretFree({ roots: [reportRoot, consumersRoot], captures });
});
