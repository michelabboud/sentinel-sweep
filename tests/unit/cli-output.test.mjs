import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createCommandDispatcher, parseCliArgs } from '../../runtime/cli.mjs';

const RUN_ID = '2026-07-31T12-34-56-789Z-a1b2c3d4';

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

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'sentinel-cli-output-'));
  const target = path.join(parent, 'target');
  const trusted = path.join(parent, 'trusted');
  await mkdir(target, { mode: 0o700 });
  await mkdir(trusted, { mode: 0o700 });
  await writeFile(
    path.join(target, 'router.js'),
    "export const routes = [{ path: '/', meta: { public: true } }];\n",
    { mode: 0o600 },
  );
  const config = path.join(trusted, 'sentinel.json');
  await writeFile(config, `${JSON.stringify({
    schemaVersion: '2.0',
    requireConfigPath: true,
    reportDir: 'sentinel-reports',
    approvedOrigins: ['http://127.0.0.1:1'],
    roles: { observer: { tokenRef: 'env:SENTINEL_DETAIL_TOKEN' } },
    allowMutations: false,
    mutationAllowlist: [],
    allowNonLoopback: false,
    targetEnvironment: 'test',
    requireCompleteCoverage: true,
    responseTimeoutMs: 1000,
    browserSettleMs: 10,
    viewports: [375],
    screenshotOnError: true,
    discovery: { vueRouter: ['router.js'] },
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(config, 0o600);
  t.after(() => rm(parent, { recursive: true, force: true }));
  return parseCliArgs([
    'browser',
    '--target', target,
    '--config', config,
    '--run-id', RUN_ID,
    '--json',
  ]);
}

function dispatcher(invocation, token) {
  const stdout = capture();
  const stderr = capture();
  const dispatch = createCommandDispatcher({
    env: { SENTINEL_DETAIL_TOKEN: token },
    stdin: { isTTY: false },
    stdout: stdout.stream,
    stderr: stderr.stream,
    sweepBrowser: async () => {
      throw new Error('injected browser failure');
    },
  });
  return { invocation, dispatch, stdout, stderr };
}

test('writeCommandFailure emits safe dynamic details', async (t) => {
  const invocation = await fixture(t);
  const { dispatch, stdout, stderr } = dispatcher(invocation, 'safe-token');

  assert.equal(await dispatch(invocation), 1);
  assert.equal(stderr.read(), '');
  assert.deepEqual(JSON.parse(stdout.read()), {
    ok: false,
    code: 'SWEEP_INCOMPLETE',
    message: 'One or more required sweep engines did not complete',
    failedEngines: ['browser'],
  });
});

test('writeCommandFailure rejects a secret-bearing dynamic detail before output', async (t) => {
  const invocation = await fixture(t);
  const { dispatch, stdout, stderr } = dispatcher(invocation, 'failedEngines');

  await assert.rejects(
    dispatch(invocation),
    (error) => error?.code === 'CLI_DATA_UNSAFE'
      && error?.message === 'Unsafe string rejected at command failure',
  );
  assert.equal(stdout.read(), '');
  assert.equal(stderr.read(), '');
});
