import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCommandDispatcher, runCli } from '../../runtime/cli.mjs';
import { operationId } from '../../runtime/lib/identity.mjs';

const RUN_ID = '2026-07-18T12-34-56-789Z-a1b2c3d4';
const RUN_ID_2 = '2026-07-18T12-34-57-789Z-b1c2d3e4';
const CLI_PATH = fileURLToPath(new URL('../../runtime/cli.mjs', import.meta.url));

function capture() {
  let value = '';
  return {
    stream: {
      write(chunk) {
        value += String(chunk);
        return true;
      },
    },
    read: () => value,
  };
}

async function fixture(t, configOverrides = {}) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sentinel-cli-orchestration-'));
  const target = path.join(parent, 'target');
  const trusted = path.join(parent, 'trusted');
  const output = path.join(parent, 'output');
  await mkdir(target, { mode: 0o700 });
  await mkdir(trusted, { mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  await writeFile(path.join(target, 'openapi.json'), `${JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'CLI fixture', version: '1.0.0' },
    paths: {
      '/health': {
        get: {
          security: [],
          responses: {
            200: {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['ok'],
                    properties: { ok: { type: 'boolean' } },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const config = path.join(trusted, 'sentinel.json');
  await writeFile(config, `${JSON.stringify({
    schemaVersion: '2.0',
    requireConfigPath: true,
    reportDir: 'sentinel-reports',
    approvedOrigins: [],
    roles: {},
    allowMutations: false,
    mutationAllowlist: [],
    allowNonLoopback: false,
    targetEnvironment: 'test',
    requireCompleteCoverage: true,
    responseTimeoutMs: 1000,
    browserSettleMs: 10,
    viewports: [375],
    screenshotOnError: true,
    discovery: { openapi: ['openapi.json'] },
    ...configOverrides,
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(config, 0o600);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return { config, output, parent, target };
}

async function loopbackServer(t) {
  let valid = true;
  const server = createServer((request, response) => {
    if (request.url !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"not found"}');
      return;
    }
    response.writeHead(valid ? 200 : 500, { 'content-type': 'application/json' });
    response.end(valid ? '{"ok":true}' : '{"ok":"wrong"}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setValid(value) { valid = value; },
  };
}

async function invoke(dispatchOptions, argv) {
  const stdout = capture();
  const stderr = capture();
  const dispatch = createCommandDispatcher({
    ...dispatchOptions,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  const exit = await runCli(argv, {
    dispatch,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { exit, stdout: stdout.read(), stderr: stderr.read() };
}

async function spawnCli(argv, env = Object.create(null)) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...argv], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exit, signal) => resolve({ exit, signal, stdout, stderr }));
  });
}

function assertSingleJsonDocument(result, expectedExit) {
  assert.equal(result.exit, expectedExit, `${result.stderr}${result.stdout}`);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const document = JSON.parse(result.stdout);
  assert.equal(result.stdout, `${JSON.stringify(document)}\n`);
  return document;
}

test('setup is read-only and reports trusted readiness without creating report state', async (t) => {
  const { config, target } = await fixture(t);
  const stdout = capture();
  const stderr = capture();
  const dispatch = createCommandDispatcher({
    env: Object.create(null),
    stdin: { isTTY: false },
    stdout: stdout.stream,
    stderr: stderr.stream,
    resolveChrome: async () => {
      throw new Error('fixture intentionally has no Chrome');
    },
  });
  const exit = await runCli([
    'setup', '--target', target, '--config', config, '--json',
  ], { dispatch, stdout: stdout.stream, stderr: stderr.stream });

  assert.equal(exit, 0, `${stderr.read()}${stdout.read()}`);
  assert.equal(stderr.read(), '');
  assert.deepEqual(JSON.parse(stdout.read()), {
    ok: true,
    command: 'setup',
    schemaVersion: '2.0',
    executionReady: false,
    apiReady: false,
    browserReady: false,
    sweepReady: false,
    discovery: { openapi: ['openapi.json'], vueRouter: [] },
    discoveryAvailable: true,
    coverage: 'complete',
    origins: [],
    roles: [],
    chromeAvailable: false,
  });
  assert.deepEqual((await readdir(target)).sort(), ['openapi.json']);
});

test('setup reports missing discovery candidates as unavailable without publishing state', async (t) => {
  const { config, target } = await fixture(t, {
    discovery: { openapi: ['missing-openapi.json'] },
  });
  const result = await invoke({
    env: Object.create(null),
    stdin: { isTTY: false },
    resolveChrome: async () => '/fixture/chrome',
  }, ['setup', '--target', target, '--config', config, '--json']);

  assert.equal(result.exit, 0, `${result.stderr}${result.stdout}`);
  assert.equal(result.stderr, '');
  const document = JSON.parse(result.stdout);
  assert.equal(document.ok, true);
  assert.equal(document.command, 'setup');
  assert.equal(document.executionReady, false);
  assert.equal(document.apiReady, false);
  assert.equal(document.browserReady, false);
  assert.equal(document.sweepReady, false);
  assert.equal(document.discoveryAvailable, false);
  assert.equal(document.coverage, null);
  assert.deepEqual((await readdir(target)).sort(), ['openapi.json']);
});

test('setup readiness is derived from executable policy decisions for each mode', async (t) => {
  const app = await loopbackServer(t);
  const blocked = await fixture(t, {
    approvedOrigins: [app.origin],
  });
  await writeFile(path.join(blocked.target, 'openapi.json'), `${JSON.stringify({
    openapi: '3.0.3',
    info: { title: 'Blocked setup fixture', version: '1.0.0' },
    paths: {
      '/items/{id}': {
        get: {
          security: [],
          parameters: [{
            in: 'path', name: 'id', required: true, schema: { type: 'string' },
          }],
          responses: { 200: { description: 'ok' } },
        },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  const dispatchOptions = {
    env: Object.create(null),
    stdin: { isTTY: false },
    resolveChrome: async () => '/fixture/chrome',
  };

  const blockedResult = await invoke(dispatchOptions, [
    'setup', '--target', blocked.target, '--config', blocked.config, '--json',
  ]);
  assert.equal(blockedResult.exit, 0, `${blockedResult.stderr}${blockedResult.stdout}`);
  const blockedDocument = JSON.parse(blockedResult.stdout);
  assert.equal(blockedDocument.discoveryAvailable, true);
  assert.equal(blockedDocument.coverage, 'complete');
  assert.equal(blockedDocument.apiReady, false);
  assert.equal(blockedDocument.browserReady, true);
  assert.equal(blockedDocument.sweepReady, false);
  assert.equal(blockedDocument.executionReady, false);

  const ready = await fixture(t, {
    approvedOrigins: [app.origin],
    trustedOverrides: {
      operations: {
        [operationId('GET', '/health')]: { sideEffects: { classes: [] } },
      },
    },
  });
  const readyResult = await invoke(dispatchOptions, [
    'setup', '--target', ready.target, '--config', ready.config, '--json',
  ]);
  assert.equal(readyResult.exit, 0, `${readyResult.stderr}${readyResult.stdout}`);
  const readyDocument = JSON.parse(readyResult.stdout);
  assert.equal(readyDocument.apiReady, true);
  assert.equal(readyDocument.browserReady, true);
  assert.equal(readyDocument.sweepReady, true);
  assert.equal(readyDocument.executionReady, true);
});

test('manifest builds fresh discovery and publishes one exclusive v2 JSON file', async (t) => {
  const { config, output, target } = await fixture(t);
  const destination = path.join(output, 'manifest.json');
  const stdout = capture();
  const stderr = capture();
  const dispatch = createCommandDispatcher({
    env: Object.create(null),
    stdin: { isTTY: false },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  const exit = await runCli([
    'manifest', '--target', target, '--config', config,
    '--output', destination, '--json',
  ], { dispatch, stdout: stdout.stream, stderr: stderr.stream });

  assert.equal(exit, 0, `${stderr.read()}${stdout.read()}`);
  assert.equal(stderr.read(), '');
  const manifest = JSON.parse(await readFile(destination, 'utf8'));
  assert.equal(manifest.schemaVersion, '2.0');
  assert.equal(manifest.operations.length, 1);
  assert.equal(manifest.routes.length, 1);
  assert.deepEqual(JSON.parse(stdout.read()), {
    ok: true,
    command: 'manifest',
    schemaVersion: '2.0',
    coverage: 'complete',
    operations: 1,
    routes: 1,
  });
  const duplicateOut = capture();
  const duplicateErr = capture();
  assert.equal(
    await runCli([
      'manifest', '--target', target, '--config', config,
      '--output', destination, '--json',
    ], { dispatch, stdout: duplicateOut.stream, stderr: duplicateErr.stream }),
    1,
  );
  assert.equal(duplicateErr.read(), '');
  assert.deepEqual(JSON.parse(duplicateOut.read()), {
    ok: false,
    code: 'CLI_COMMAND_FAILED',
    message: 'Command failed',
  });
});

test('non-TTY sandbox acknowledgement fails before target, config, or network I/O', async () => {
  let randomCalled = false;
  const stdout = capture();
  const stderr = capture();
  const dispatch = createCommandDispatcher({
    env: { SENTINEL_CI_SANDBOX_ACK: `${RUN_ID}-wrong` },
    stdin: { isTTY: false },
    stdout: stdout.stream,
    stderr: stderr.stream,
    randomBytes: (...args) => {
      randomCalled = true;
      return randomBytes(...args);
    },
  });
  const exit = await runCli([
    'sweep', '--target', '/does/not/exist', '--config', '/also/missing',
    '--run-id', RUN_ID, '--sandbox-acknowledged', '--json',
  ], { dispatch, stdout: stdout.stream, stderr: stderr.stream });

  assert.equal(exit, 1);
  assert.equal(stderr.read(), '');
  assert.deepEqual(JSON.parse(stdout.read()), {
    ok: false,
    code: 'CLI_COMMAND_FAILED',
    message: 'Command failed',
  });
  assert.equal(randomCalled, false);
});

test('api and browser isolate engines while sweep settles both failures before aborting', async (t) => {
  const { config, target } = await fixture(t, {
    approvedOrigins: ['http://127.0.0.1:1'],
    trustedOverrides: {
      operations: {
        [operationId('GET', '/health')]: {
          sideEffects: { classes: [] },
        },
      },
    },
  });
  const calls = { api: 0, browser: 0 };
  const dispatchOptions = {
    env: Object.create(null),
    stdin: { isTTY: false },
    sweepApi: async () => {
      calls.api += 1;
      throw new Error('injected api failure');
    },
    sweepBrowser: async () => {
      calls.browser += 1;
      throw new Error('injected browser failure');
    },
  };
  const base = ['--target', target, '--config', config, '--json'];
  const api = await invoke(dispatchOptions, ['api', ...base, '--run-id', RUN_ID]);
  assert.equal(api.exit, 1);
  assert.deepEqual(calls, { api: 1, browser: 0 });

  const browser = await invoke(dispatchOptions, [
    'browser', ...base, '--run-id', RUN_ID,
  ]);
  assert.equal(browser.exit, 1);
  assert.deepEqual(calls, { api: 1, browser: 1 });

  const sweep = await invoke(dispatchOptions, [
    'sweep', ...base, '--run-id', RUN_ID,
  ]);
  assert.equal(sweep.exit, 1);
  assert.deepEqual(calls, { api: 2, browser: 2 });
  for (const [result, failedEngines] of [
    [api, ['api']],
    [browser, ['browser']],
    [sweep, ['api', 'browser']],
  ]) {
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      code: 'SWEEP_INCOMPLETE',
      message: 'One or more required sweep engines did not complete',
      failedEngines,
    });
  }
  const reportRoot = path.join(target, 'sentinel-reports', 'sentinel-v2');
  assert.deepEqual(await readdir(reportRoot), []);
});

test('required modes fail closed when trusted policy selects no executable work', async (t) => {
  const { config, target } = await fixture(t);
  const result = await invoke({
    env: Object.create(null),
    stdin: { isTTY: false },
  }, ['api', '--target', target, '--config', config, '--run-id', RUN_ID, '--json']);

  assert.equal(result.exit, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    code: 'CLI_COMMAND_FAILED',
    message: 'Command failed',
  });
  const reportRoot = path.join(target, 'sentinel-reports', 'sentinel-v2');
  const entries = await readdir(reportRoot).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(entries, []);
});

test('API execution publishes canonical runs and every existing-run command consumes them', async (t) => {
  const app = await loopbackServer(t);
  const { config, output, target } = await fixture(t, {
    approvedOrigins: [app.origin, app.origin],
    trustedOverrides: {
      operations: {
        [operationId('GET', '/health')]: {
          sideEffects: { classes: [] },
        },
      },
    },
  });
  const dispatchOptions = {
    env: Object.create(null),
    stdin: { isTTY: false },
  };
  const base = ['--target', target, '--config', config, '--json'];

  const cleanRun = await invoke(dispatchOptions, [
    'api', ...base, '--run-id', RUN_ID,
  ]);
  assert.equal(cleanRun.exit, 0, `${cleanRun.stderr}${cleanRun.stdout}`);
  assert.equal(cleanRun.stderr, '');
  const cleanResult = JSON.parse(cleanRun.stdout);
  assert.equal(cleanResult.ok, true);
  assert.equal(cleanResult.runId, RUN_ID);
  assert.equal(cleanResult.coverage, 'complete');
  assert.equal(cleanResult.summary.critical, 0);
  assert.equal(cleanResult.summary.error, 0);

  app.setValid(false);
  const findingRun = await invoke(dispatchOptions, [
    'api', ...base, '--run-id', RUN_ID_2,
  ]);
  const reportRoot = path.join(target, 'sentinel-reports', 'sentinel-v2');
  assert.equal(
    findingRun.exit,
    2,
    `${findingRun.stderr}${findingRun.stdout}${await readFile(
      path.join(reportRoot, RUN_ID_2, 'sentinel-findings.json'),
      'utf8',
    )}`,
  );
  const findingResult = JSON.parse(findingRun.stdout);
  assert.equal(findingResult.ok, true);
  assert.equal(findingResult.runId, RUN_ID_2);
  assert.ok(findingResult.summary.error > 0);

  assert.deepEqual((await readdir(path.join(reportRoot, RUN_ID))).sort(), [
    '.sentinel-run-identity-v2',
    'dashboard.html',
    'pr-comment.md',
    'sentinel-findings.json',
    'sentinel-manifest.json',
    'sweep.md',
  ]);
  assert.deepEqual((await readdir(path.join(reportRoot, RUN_ID_2))).sort(), [
    '.sentinel-run-identity-v2',
    'dashboard.html',
    'pr-comment.md',
    'sentinel-findings.json',
    'sentinel-manifest.json',
    'sweep.md',
  ]);
  assert.equal(
    await readFile(path.join(reportRoot, 'latest'), 'utf8').catch(() => null),
    null,
    'latest is a symlink, never a mutable text file',
  );
  assert.equal(await readlink(path.join(reportRoot, 'latest')), RUN_ID_2);

  const reportPath = path.join(output, 'finding.md');
  const report = await invoke(dispatchOptions, [
    'report', ...base, '--run', RUN_ID_2, '--output', reportPath,
  ]);
  assert.equal(report.exit, 0, `${report.stderr}${report.stdout}`);
  assert.equal(
    await readFile(reportPath, 'utf8'),
    await readFile(path.join(reportRoot, RUN_ID_2, 'sweep.md'), 'utf8'),
  );

  const dashboardPath = path.join(output, 'finding.html');
  const dashboard = await invoke(dispatchOptions, [
    'dashboard', ...base, '--run', RUN_ID_2, '--output', dashboardPath,
  ]);
  assert.equal(dashboard.exit, 0, `${dashboard.stderr}${dashboard.stdout}`);
  assert.equal(
    await readFile(dashboardPath, 'utf8'),
    await readFile(path.join(reportRoot, RUN_ID_2, 'dashboard.html'), 'utf8'),
  );

  const exportPath = path.join(output, 'postman');
  const exported = await invoke(dispatchOptions, [
    'export', ...base, '--run', RUN_ID_2, '--format', 'postman', '--output', exportPath,
  ]);
  assert.equal(exported.exit, 0, `${exported.stderr}${exported.stdout}`);
  const collection = JSON.parse(
    await readFile(path.join(exportPath, 'sentinel.postman_collection.json'), 'utf8'),
  );
  assert.equal(collection.info.name, 'Sentinel export');
  assert.ok(!JSON.stringify(collection).includes('Bearer '));

  const insomniaPath = path.join(output, 'insomnia');
  const insomnia = await invoke(dispatchOptions, [
    'export', ...base, '--run', RUN_ID_2, '--format', 'insomnia', '--output', insomniaPath,
  ]);
  assert.equal(insomnia.exit, 0, `${insomnia.stderr}${insomnia.stdout}`);
  const insomniaDocument = JSON.parse(
    await readFile(path.join(insomniaPath, 'sentinel.insomnia.json'), 'utf8'),
  );
  assert.equal(insomniaDocument._type, 'export');
  assert.ok(!JSON.stringify(insomniaDocument).includes('Bearer '));

  const brunoPath = path.join(output, 'bruno');
  const bruno = await invoke(dispatchOptions, [
    'export', ...base, '--run', RUN_ID_2, '--format', 'bruno', '--output', brunoPath,
  ]);
  assert.equal(bruno.exit, 0, `${bruno.stderr}${bruno.stdout}`);
  assert.deepEqual(
    (await readdir(brunoPath)).sort(),
    ['bruno.json', 'environments', 'requests'],
  );
  const brunoRequests = await readdir(path.join(brunoPath, 'requests'));
  assert.equal(brunoRequests.length, 1);
  assert.ok(!(await readFile(
    path.join(brunoPath, 'requests', brunoRequests[0]),
    'utf8',
  )).includes('Bearer '));

  const trends = await invoke(dispatchOptions, ['trends', ...base]);
  assert.equal(trends.exit, 0, `${trends.stderr}${trends.stdout}`);
  assert.equal(JSON.parse(trends.stdout).trends.runs.length, 2);

  const diff = await invoke(dispatchOptions, [
    'diff', ...base, '--run', RUN_ID_2, '--against', RUN_ID,
  ]);
  assert.equal(diff.exit, 0, `${diff.stderr}${diff.stdout}`);
  assert.equal(JSON.parse(diff.stdout).runId, RUN_ID_2);

  const cleaned = await invoke(dispatchOptions, ['clean', ...base, '--keep', '1']);
  assert.equal(cleaned.exit, 0, `${cleaned.stderr}${cleaned.stdout}`);
  const cleanDocument = JSON.parse(cleaned.stdout);
  assert.deepEqual(cleanDocument.removed, [RUN_ID]);
  assert.deepEqual(cleanDocument.kept, [RUN_ID_2]);
  await assert.rejects(lstat(path.join(reportRoot, RUN_ID)));
  assert.equal((await lstat(path.join(reportRoot, RUN_ID_2))).isDirectory(), true);
});

test('the packaged CLI executes real setup and terminal 0, 2, and 1 paths', async (t) => {
  const app = await loopbackServer(t);
  const ready = await fixture(t, {
    approvedOrigins: [app.origin],
    trustedOverrides: {
      operations: {
        [operationId('GET', '/health')]: { sideEffects: { classes: [] } },
      },
    },
  });
  const base = ['--target', ready.target, '--config', ready.config, '--json'];

  const setup = assertSingleJsonDocument(
    await spawnCli(['setup', ...base]),
    0,
  );
  assert.equal(setup.command, 'setup');
  assert.equal(setup.discoveryAvailable, true);

  const clean = assertSingleJsonDocument(
    await spawnCli(['api', ...base, '--run-id', RUN_ID]),
    0,
  );
  assert.equal(clean.runId, RUN_ID);
  assert.equal(clean.summary.error, 0);

  app.setValid(false);
  const findings = assertSingleJsonDocument(
    await spawnCli(['api', ...base, '--run-id', RUN_ID_2]),
    2,
  );
  assert.equal(findings.runId, RUN_ID_2);
  assert.ok(findings.summary.error > 0);

  const unavailable = await fixture(t);
  const failed = assertSingleJsonDocument(await spawnCli([
    'api', '--target', unavailable.target, '--config', unavailable.config,
    '--run-id', RUN_ID, '--json',
  ]), 1);
  assert.deepEqual(failed, {
    ok: false,
    code: 'CLI_COMMAND_FAILED',
    message: 'Command failed',
  });
});

test('concurrent generated runs remain unique, immutable, and represented in history', async (t) => {
  const app = await loopbackServer(t);
  const { config, target } = await fixture(t, {
    approvedOrigins: [app.origin],
    trustedOverrides: {
      operations: {
        [operationId('GET', '/health')]: { sideEffects: { classes: [] } },
      },
    },
  });
  const options = { env: Object.create(null), stdin: { isTTY: false } };
  const base = ['--target', target, '--config', config, '--json'];
  const results = await Promise.all([
    invoke(options, ['api', ...base]),
    invoke(options, ['api', ...base]),
  ]);
  for (const result of results) {
    assert.equal(result.exit, 0, `${result.stderr}${result.stdout}`);
    assert.equal(result.stderr, '');
  }
  const runIds = results.map((result) => JSON.parse(result.stdout).runId).sort();
  assert.match(runIds[0], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/u);
  assert.match(runIds[1], /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}$/u);
  assert.notEqual(runIds[0], runIds[1]);

  const reportRoot = path.join(target, 'sentinel-reports', 'sentinel-v2');
  for (const runId of runIds) {
    assert.equal((await lstat(path.join(reportRoot, runId))).isDirectory(), true);
  }
  assert.ok(runIds.includes(await readlink(path.join(reportRoot, 'latest'))));
  const trends = await invoke(options, ['trends', ...base]);
  assert.equal(trends.exit, 0, `${trends.stderr}${trends.stdout}`);
  assert.deepEqual(
    JSON.parse(trends.stdout).trends.runs.map((entry) => entry.runId).sort(),
    runIds,
  );
});

test('discovered values that collide with configured secrets fail before publication', async (t) => {
  const canary = 'SentinelCanary+/Token';
  const { config, target } = await fixture(t, {
    roles: { admin: { tokenRef: 'env:SENTINEL_CANARY_TOKEN' } },
  });
  const openapiPath = path.join(target, 'openapi.json');
  const document = JSON.parse(await readFile(openapiPath, 'utf8'));
  document.paths['/health'].get.summary = canary;
  await writeFile(openapiPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });

  const result = await invoke({
    env: { SENTINEL_CANARY_TOKEN: canary },
    stdin: { isTTY: false },
  }, ['api', '--target', target, '--config', config, '--run-id', RUN_ID, '--json']);
  assert.equal(result.exit, 1);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes(canary), false);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    code: 'CLI_COMMAND_FAILED',
    message: 'Command failed',
  });

  const reportRoot = path.join(target, 'sentinel-reports', 'sentinel-v2');
  const entries = await readdir(reportRoot).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  assert.deepEqual(entries, []);
});

test('present short or non-bearer credentials fail before standalone artifact writes', async (t) => {
  const { config, output, target } = await fixture(t, {
    roles: { admin: { tokenRef: 'env:API_TOKEN' } },
  });
  const openapiPath = path.join(target, 'openapi.json');
  const original = JSON.parse(await readFile(openapiPath, 'utf8'));

  for (const [label, secret] of [
    ['short', 'abc'],
    ['punctuation', 'abc,def'],
  ]) {
    const document = structuredClone(original);
    document.paths['/health'].get.summary = secret;
    await writeFile(openapiPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    const destination = path.join(output, `${label}.json`);
    const result = await invoke({
      env: { API_TOKEN: secret },
      stdin: { isTTY: false },
    }, [
      'manifest', '--target', target, '--config', config,
      '--output', destination, '--json',
    ]);
    assert.equal(result.exit, 1);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes(secret), false);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      code: 'CLI_COMMAND_FAILED',
      message: 'Command failed',
    });
    await assert.rejects(lstat(destination), { code: 'ENOENT' });
  }
});

test('credential rotation blocks every old-run consumer before a new secret can escape', async (t) => {
  const canary = 'LaterSecret+/Token';
  const app = await loopbackServer(t);
  const { config, output, target } = await fixture(t, {
    approvedOrigins: [app.origin],
    trustedOverrides: {
      operations: {
        [operationId('GET', '/health')]: { sideEffects: { classes: [] } },
      },
    },
  });
  const openapiPath = path.join(target, 'openapi.json');
  const openapi = JSON.parse(await readFile(openapiPath, 'utf8'));
  openapi.paths['/health'].get.summary = canary;
  await writeFile(openapiPath, `${JSON.stringify(openapi, null, 2)}\n`, { mode: 0o600 });
  const base = ['--target', target, '--config', config, '--json'];
  const initial = await invoke({
    env: Object.create(null),
    stdin: { isTTY: false },
  }, ['api', ...base, '--run-id', RUN_ID]);
  assert.equal(initial.exit, 0, `${initial.stderr}${initial.stdout}`);

  const rotated = JSON.parse(await readFile(config, 'utf8'));
  rotated.roles = { admin: { tokenRef: 'env:NEW_ADMIN_TOKEN' } };
  await writeFile(config, `${JSON.stringify(rotated, null, 2)}\n`);
  await chmod(config, 0o600);
  const dispatchOptions = {
    env: { NEW_ADMIN_TOKEN: canary },
    stdin: { isTTY: false },
  };
  const reportPath = path.join(output, 'rotated.md');
  const exportPath = path.join(output, 'rotated-postman');
  const attempts = [
    invoke(dispatchOptions, [
      'report', ...base, '--run', RUN_ID, '--output', reportPath,
    ]),
    invoke(dispatchOptions, [
      'export', ...base, '--run', RUN_ID, '--format', 'postman', '--output', exportPath,
    ]),
    invoke(dispatchOptions, [
      'diff', ...base, '--run', RUN_ID, '--against', RUN_ID,
    ]),
  ];
  for (const result of await Promise.all(attempts)) {
    assert.equal(result.exit, 1);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes(canary), false);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      code: 'CLI_COMMAND_FAILED',
      message: 'Command failed',
    });
  }
  await assert.rejects(lstat(reportPath), { code: 'ENOENT' });
  await assert.rejects(lstat(exportPath), { code: 'ENOENT' });
});
