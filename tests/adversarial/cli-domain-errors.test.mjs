import assert from 'node:assert/strict';
import test from 'node:test';

import { runCli } from '../../runtime/cli.mjs';
import { SentinelError } from '../../runtime/lib/errors.mjs';

const TARGET = '/tmp/sentinel-adversarial-target';
const CONFIG = '/tmp/sentinel-adversarial-config.json';

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

async function invoke(error) {
  const stdout = capture();
  const stderr = capture();
  const exit = await runCli([
    'setup', '--target', TARGET, '--config', CONFIG, '--json',
  ], {
    dispatch: async () => { throw error; },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });
  return { exit, stdout: stdout.read(), stderr: stderr.read() };
}

test('keeps non-public config, path, internal, and unknown domain errors generic', async () => {
  const canary = 'sentinel-non-public-error-canary';
  for (const code of [
    'CONFIG_MODE_INSECURE',
    'CONFIG_UNTRUSTED_LOCATION',
    'CLI_DATA_UNSAFE',
    'FUTURE_INTERNAL_FAILURE',
  ]) {
    const result = await invoke(new SentinelError(
      code,
      `${canary}:${code}:/private/path`,
      { code, secret: canary, path: '/private/path' },
    ));
    assert.equal(result.exit, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      code: 'CLI_COMMAND_FAILED',
      message: 'Command failed',
    });
    assert.ok(!result.stdout.includes(canary));
    assert.ok(!result.stdout.includes('/private/path'));
    assert.ok(!result.stdout.includes(code));
  }
});

test('contains hostile non-Sentinel throwables without inspecting their fields', async () => {
  const canary = 'sentinel-hostile-throwable-canary';
  const hostile = new Proxy(Object.create(null), {
    get() {
      throw new Error(canary);
    },
    getOwnPropertyDescriptor() {
      throw new Error(canary);
    },
    getPrototypeOf() {
      throw new Error(canary);
    },
  });

  const result = await invoke(hostile);
  assert.equal(result.exit, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: false,
    code: 'CLI_COMMAND_FAILED',
    message: 'Command failed',
  });
  assert.ok(!result.stdout.includes(canary));
});
