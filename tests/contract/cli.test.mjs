import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import {
  SHORT_USAGE,
  USAGE,
  parseCliArgs,
  runCli,
} from '../../runtime/cli.mjs';
import {
  loadBundledSchema,
  validateAgainstSchema,
} from '../../runtime/lib/schema.mjs';
import { SentinelError } from '../../runtime/lib/errors.mjs';

const ROOT = new URL('../../', import.meta.url);
const CLI = new URL('../../runtime/cli.mjs', import.meta.url);
const RUN_ID = '2026-07-18T12-34-56-789Z-a1b2c3d4';
const AGAINST_RUN_ID = '2026-07-17T01-02-03Z';
const TARGET = '/tmp/Sentinel target/פרויקט בדיקה';
const CONFIG = '/tmp/Sentinel config/הגדרות.json';

function command(command, flags) {
  return parseCliArgs([command, ...flags]);
}

function capture() {
  let text = '';
  return {
    stream: {
      write(chunk) {
        text += String(chunk);
        return true;
      },
    },
    read() {
      return text;
    },
  };
}

test('parses the exact command-first v2 command matrix', () => {
  const cases = [
    {
      argv: ['setup', '--target', TARGET, '--config', CONFIG],
      command: 'setup',
      options: { target: TARGET, config: CONFIG, json: false },
    },
    {
      argv: [
        'manifest', '--output', '/tmp/output manifest.json', '--config', CONFIG,
        '--target', TARGET, '--json',
      ],
      command: 'manifest',
      options: {
        target: TARGET,
        config: CONFIG,
        output: '/tmp/output manifest.json',
        json: true,
      },
    },
    ...['api', 'browser', 'sweep'].map((name) => ({
      argv: [
        name,
        '--target', TARGET,
        '--config', CONFIG,
        '--run-id', RUN_ID,
        '--sandbox-acknowledged',
        '--json',
      ],
      command: name,
      options: {
        target: TARGET,
        config: CONFIG,
        runId: RUN_ID,
        sandboxAcknowledged: true,
        json: true,
      },
    })),
    ...['report', 'dashboard'].map((name) => ({
      argv: [
        name,
        '--target', TARGET,
        '--config', CONFIG,
        '--run', RUN_ID,
        '--output', `/tmp/${name} result`,
      ],
      command: name,
      options: {
        target: TARGET,
        config: CONFIG,
        run: RUN_ID,
        output: `/tmp/${name} result`,
        json: false,
      },
    })),
    {
      argv: [
        'export', '--target', TARGET, '--config', CONFIG, '--run', RUN_ID,
        '--format', 'bruno', '--output', '/tmp/export result', '--json',
      ],
      command: 'export',
      options: {
        target: TARGET,
        config: CONFIG,
        run: RUN_ID,
        format: 'bruno',
        output: '/tmp/export result',
        json: true,
      },
    },
    {
      argv: ['trends', '--target', TARGET, '--config', CONFIG],
      command: 'trends',
      options: { target: TARGET, config: CONFIG, json: false },
    },
    {
      argv: [
        'diff', '--target', TARGET, '--config', CONFIG, '--run', RUN_ID,
        '--against', AGAINST_RUN_ID, '--json',
      ],
      command: 'diff',
      options: {
        target: TARGET,
        config: CONFIG,
        run: RUN_ID,
        against: AGAINST_RUN_ID,
        json: true,
      },
    },
    {
      argv: ['clean', '--target', TARGET, '--config', CONFIG, '--keep', '17'],
      command: 'clean',
      options: { target: TARGET, config: CONFIG, keep: 17, json: false },
    },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const fixture = cases[index];
    const parsed = parseCliArgs(fixture.argv);
    assert.deepEqual({ ...parsed, options: { ...parsed.options } }, {
      type: 'command',
      command: fixture.command,
      options: fixture.options,
    });
  }
});

test('parses top-level help and version only as sole meta invocations', () => {
  assert.deepEqual(parseCliArgs(['--help']), { type: 'meta', action: 'help' });
  assert.deepEqual(parseCliArgs(['--version']), { type: 'meta', action: 'version' });

  for (const argv of [
    ['--help', '--json'],
    ['--version', 'setup'],
    ['setup', '--help'],
    ['setup', '--version'],
  ]) {
    assert.throws(
      () => parseCliArgs(argv),
      (error) => error?.code === 'CLI_META_EXCLUSIVE',
    );
  }
});

test('rejects aliases, equals syntax, duplicates, unknown flags, and positionals', () => {
  const invalid = [
    { argv: [], code: 'CLI_COMMAND_REQUIRED' },
    { argv: ['unknown'], code: 'CLI_COMMAND_UNKNOWN' },
    { argv: ['-h'], code: 'CLI_COMMAND_REQUIRED' },
    { argv: ['setup', '-t', TARGET, '--config', CONFIG], code: 'CLI_FLAG_UNKNOWN' },
    { argv: ['setup', `--target=${TARGET}`, '--config', CONFIG], code: 'CLI_FLAG_EQUALS' },
    {
      argv: ['setup', '--target', TARGET, '--target', TARGET, '--config', CONFIG],
      code: 'CLI_FLAG_DUPLICATE',
    },
    { argv: ['setup', '--target', TARGET, '--config', CONFIG, '--wat'], code: 'CLI_FLAG_UNKNOWN' },
    { argv: ['setup', '--target', TARGET, '--config', CONFIG, 'extra'], code: 'CLI_POSITIONAL' },
    { argv: ['setup', '--target', TARGET, '--config', CONFIG, '--json', '--json'], code: 'CLI_FLAG_DUPLICATE' },
    {
      argv: ['api', '--target', TARGET, '--config', CONFIG, '--sandbox-acknowledged', 'yes'],
      code: 'CLI_POSITIONAL',
    },
  ];

  for (let index = 0; index < invalid.length; index += 1) {
    const fixture = invalid[index];
    assert.throws(
      () => parseCliArgs(fixture.argv),
      (error) => error?.code === fixture.code,
    );
  }
});

test('rejects missing, empty, control-bearing, and command-inapplicable values', () => {
  const base = ['setup', '--target', TARGET, '--config', CONFIG];
  const invalid = [
    { argv: ['setup', '--config', CONFIG], code: 'CLI_FLAG_REQUIRED' },
    { argv: ['setup', '--target', TARGET], code: 'CLI_FLAG_REQUIRED' },
    { argv: ['setup', '--target'], code: 'CLI_FLAG_VALUE_REQUIRED' },
    { argv: ['setup', '--target', '--config', CONFIG], code: 'CLI_FLAG_VALUE_REQUIRED' },
    { argv: ['setup', '--target', '', '--config', CONFIG], code: 'CLI_FLAG_VALUE_EMPTY' },
    { argv: ['setup', '--target', '   ', '--config', CONFIG], code: 'CLI_FLAG_VALUE_EMPTY' },
    {
      argv: ['setup', '--target', 'x'.repeat(32768), '--config', CONFIG],
      code: 'CLI_FLAG_VALUE_LIMIT',
    },
    { argv: ['setup', '--target', 'line\nbreak', '--config', CONFIG], code: 'CLI_FLAG_VALUE_CONTROL' },
    { argv: [...base, '--output', '/tmp/result'], code: 'CLI_FLAG_INAPPLICABLE' },
    {
      argv: ['manifest', '--target', TARGET, '--config', CONFIG],
      code: 'CLI_FLAG_REQUIRED',
    },
    {
      argv: ['api', '--target', TARGET, '--config', CONFIG, '--run', RUN_ID],
      code: 'CLI_FLAG_INAPPLICABLE',
    },
    {
      argv: ['report', '--target', TARGET, '--config', CONFIG, '--run-id', RUN_ID],
      code: 'CLI_FLAG_INAPPLICABLE',
    },
  ];

  for (let index = 0; index < invalid.length; index += 1) {
    const fixture = invalid[index];
    assert.throws(
      () => parseCliArgs(fixture.argv),
      (error) => error?.code === fixture.code,
    );
  }
});

test('validates typed run, export format, and retention values at the parser boundary', () => {
  assert.throws(
    () => command('api', [
      '--target', TARGET, '--config', CONFIG, '--run-id', '2026-07-18T12-34-56Z',
    ]),
    (error) => error?.code === 'CLI_RUN_ID_INVALID',
  );
  for (const value of [
    'run',
    '../run',
    '2026-07-18T12:34:56Z',
    `${RUN_ID}/child`,
    '2026-13-18T12-34-56Z',
    '2026-02-30T12-34-56Z',
    '2025-02-29T12-34-56Z',
    '2026-07-18T24-00-00Z',
    '2026-07-18T23-60-00Z',
    '2026-07-18T23-59-60Z',
  ]) {
    assert.throws(
      () => command('report', [
        '--target', TARGET, '--config', CONFIG, '--run', value, '--output', '/tmp/report',
      ]),
      (error) => error?.code === 'CLI_RUN_ID_INVALID',
    );
  }

  for (const value of ['curl', 'POSTMAN', 'postman\nextra']) {
    assert.throws(
      () => command('export', [
        '--target', TARGET, '--config', CONFIG, '--run', RUN_ID,
        '--format', value, '--output', '/tmp/export',
      ]),
      (error) => error?.code === (value.includes('\n')
        ? 'CLI_FLAG_VALUE_CONTROL'
        : 'CLI_FORMAT_INVALID'),
    );
  }

  for (const value of ['0', '-1', '01', '1.5', '129', '9007199254740992']) {
    assert.throws(
      () => command('clean', [
        '--target', TARGET, '--config', CONFIG, '--keep', value,
      ]),
      (error) => error?.code === 'CLI_KEEP_INVALID',
    );
  }
});

test('does not dispatch strict value checks through mutable RegExp or String prototypes', () => {
  const source = `
    RegExp.prototype.test = () => true;
    String.prototype.charCodeAt = () => 0x41;
    const { parseCliArgs } = await import(${JSON.stringify(CLI.href)});
    const cases = [
      ['report', '--target', '/tmp/target', '--config', '/tmp/config', '--run', '../escape', '--output', '/tmp/report'],
      ['setup', '--target', 'line\\nbreak', '--config', '/tmp/config'],
    ];
    const codes = [];
    for (let index = 0; index < cases.length; index += 1) {
      try {
        parseCliArgs(cases[index]);
        codes.push('accepted');
      } catch (error) {
        codes.push(error.code);
      }
    }
    process.stdout.write(JSON.stringify(codes));
  `;
  const result = spawnSync(process.execPath, [
    '--input-type=module', '--eval', source,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    'CLI_RUN_ID_INVALID',
    'CLI_FLAG_VALUE_CONTROL',
  ]);
});

test('freezes parsed intent before handing it to the lifecycle dispatch seam', async () => {
  let received = null;
  const stdout = capture();
  const stderr = capture();
  const exitCode = await runCli(
    ['api', '--target', TARGET, '--config', CONFIG, '--json'],
    {
      dispatch: async (invocation) => {
        received = invocation;
        assert.ok(Object.isFrozen(invocation));
        assert.ok(Object.isFrozen(invocation.options));
        assert.throws(() => {
          invocation.options.target = '/different';
        }, TypeError);
        return 2;
      },
      readVersion: async () => {
        throw new Error('version must not be read for commands');
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    },
  );

  assert.equal(exitCode, 2);
  assert.equal(received.command, 'api');
  assert.equal(received.options.target, TARGET);
  assert.equal(stdout.read(), '');
  assert.equal(stderr.read(), '');
});

test('renders meta output and concise human parser failures on the correct streams', async () => {
  const helpOut = capture();
  const helpErr = capture();
  assert.equal(await runCli(['--help'], {
    stdout: helpOut.stream,
    stderr: helpErr.stream,
  }), 0);
  assert.equal(helpOut.read(), USAGE);
  assert.equal(helpErr.read(), '');

  const versionOut = capture();
  const versionErr = capture();
  assert.equal(await runCli(['--version'], {
    readVersion: async () => '9.8.7',
    stdout: versionOut.stream,
    stderr: versionErr.stream,
  }), 0);
  assert.equal(versionOut.read(), '9.8.7\n');
  assert.equal(versionErr.read(), '');

  const failureOut = capture();
  const failureErr = capture();
  assert.equal(await runCli(['not-a-command'], {
    stdout: failureOut.stream,
    stderr: failureErr.stream,
  }), 1);
  assert.equal(failureOut.read(), '');
  assert.match(failureErr.read(), /^Error \[CLI_COMMAND_UNKNOWN\]:/u);
  assert.ok(failureErr.read().endsWith(SHORT_USAGE));
  assert.ok(!failureErr.read().includes('not-a-command'));
});

test('emits one secret-free JSON document for parser and dispatched-command failures', async () => {
  const canary = 'TOKEN-canary-raw\nsecond-document';
  const parseOut = capture();
  const parseErr = capture();
  assert.equal(await runCli([
    'setup', '--target', canary, '--json',
  ], {
    stdout: parseOut.stream,
    stderr: parseErr.stream,
  }), 1);
  assert.equal(parseErr.read(), '');
  assert.ok(parseOut.read().endsWith('\n'));
  assert.equal(parseOut.read().split('\n').length, 2);
  assert.deepEqual(JSON.parse(parseOut.read()), {
    ok: false,
    code: 'CLI_FLAG_VALUE_CONTROL',
    message: 'Flag value contains unsupported control characters',
  });
  assert.ok(!parseOut.read().includes('TOKEN-canary'));

  const dispatchOut = capture();
  const dispatchErr = capture();
  assert.equal(await runCli([
    'setup', '--target', '/tmp/TOKEN-canary-target', '--config', CONFIG, '--json',
  ], {
    dispatch: async () => {
      throw new Error('TOKEN-dispatch-canary');
    },
    stdout: dispatchOut.stream,
    stderr: dispatchErr.stream,
  }), 1);
  assert.equal(dispatchErr.read(), '');
  assert.deepEqual(JSON.parse(dispatchOut.read()), {
    ok: false,
    code: 'CLI_COMMAND_FAILED',
    message: 'Command failed',
  });
  assert.ok(!dispatchOut.read().includes('TOKEN-canary'));
  assert.ok(!dispatchOut.read().includes('TOKEN-dispatch-canary'));
});

test('surfaces only the documented multi-service domain code with a fixed safe message', async () => {
  const canary = 'sentinel-domain-message-canary';
  const stdout = capture();
  const stderr = capture();
  const exit = await runCli([
    'setup', '--target', TARGET, '--config', CONFIG, '--json',
  ], {
    dispatch: async () => {
      throw new SentinelError(
        'CONFIG_MULTI_SERVICE_UNSUPPORTED',
        `hostile message ${canary} /private/operator/config.json`,
        { secret: canary, path: '/private/operator/config.json' },
      );
    },
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  assert.equal(exit, 1);
  assert.equal(stderr.read(), '');
  assert.deepEqual(JSON.parse(stdout.read()), {
    ok: false,
    code: 'CONFIG_MULTI_SERVICE_UNSUPPORTED',
    message: 'Trusted config supports at most one canonical origin and one service per invocation',
  });
  assert.ok(!stdout.read().includes(canary));
  assert.ok(!stdout.read().includes('/private/operator/config.json'));
});

test('top-level CLI help, version, and failures honor stable exit and output framing', async () => {
  const node = process.execPath;
  const help = spawnSync(node, [CLI.pathname, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.equal(help.stdout, USAGE);
  assert.equal(help.stderr, '');

  const expectedVersion = (await readFile(new URL('VERSION', ROOT), 'utf8')).trim();
  const version = spawnSync(node, [CLI.pathname, '--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `${expectedVersion}\n`);
  assert.equal(version.stderr, '');

  const invalid = spawnSync(node, [CLI.pathname], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /^Error \[CLI_COMMAND_REQUIRED\]:/u);

});

test('Codex example configuration is a complete strict v2 trusted config', async () => {
  const example = JSON.parse(
    await readFile(new URL('../../codex/config.example.json', import.meta.url), 'utf8'),
  );
  const schema = await loadBundledSchema('settings');
  validateAgainstSchema(example, schema, { name: 'Codex config example' });

  assert.equal(example.schemaVersion, '2.0');
  assert.equal(example.requireConfigPath, true);
  assert.equal(example.reportDir, 'sentinel-reports');
  assert.equal(example.allowMutations, false);
  assert.equal(example.allowNonLoopback, false);
  assert.ok(Object.keys(example.roles).length > 0);
  for (const role of Object.values(example.roles)) {
    assert.match(role.tokenRef, /^env:[A-Z][A-Z0-9_]+$/u);
    assert.ok(!Object.hasOwn(role, 'token'));
  }
});
