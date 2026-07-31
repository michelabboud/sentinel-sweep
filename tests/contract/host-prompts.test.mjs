import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const execFileAsync = promisify(execFile);

async function read(relativePath) {
  return readFile(new URL(relativePath, root), 'utf8');
}

function splitMarkdown(document, label) {
  const match = document.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/u);
  assert.ok(match, `${label} must contain one leading YAML frontmatter block`);
  return { frontmatter: match[1], body: match[2] };
}

function countMatches(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

const hostPaths = ['commands/sentinel.md', 'skills/run/SKILL.md'];
const agentPaths = [
  'agents/manifest-generator.md',
  'agents/api-sweeper.md',
  'agents/browser-sweeper.md',
];

const commandContracts = new Map([
  ['setup', 'setup --target <path> --config <path> [--json]'],
  ['manifest', 'manifest --target <path> --config <path> --output <path> [--json]'],
  ['api', 'api --target <path> --config <path> [--run-id <id>] [--sandbox-acknowledged] [--json]'],
  ['browser', 'browser --target <path> --config <path> [--run-id <id>] [--sandbox-acknowledged] [--json]'],
  ['sweep', 'sweep --target <path> --config <path> [--run-id <id>] [--sandbox-acknowledged] [--json]'],
  ['report', 'report --target <path> --config <path> --run <id> --output <path> [--json]'],
  ['dashboard', 'dashboard --target <path> --config <path> --run <id> --output <path> [--json]'],
  ['export', 'export --target <path> --config <path> --run <id> --format <postman|insomnia|bruno> --output <path> [--json]'],
  ['trends', 'trends --target <path> --config <path> [--json]'],
  ['diff', 'diff --target <path> --config <path> --run <id> --against <id> [--json]'],
  ['clean', 'clean --target <path> --config <path> --keep <1-128> [--json]'],
]);

test('command and skill are one byte-equivalent thin-host contract', async () => {
  const command = splitMarkdown(await read(hostPaths[0]), hostPaths[0]);
  const skill = splitMarkdown(await read(hostPaths[1]), hostPaths[1]);

  assert.equal(command.body, skill.body);
  assert.match(command.frontmatter, /^allowed-tools: \["Read"\]$/mu);
  assert.match(skill.frontmatter, /^allowed-tools: \["Read"\]$/mu);
  assert.doesNotMatch(command.frontmatter, /^allowed-tools:.*\bBash\b/mu);
  assert.doesNotMatch(skill.frontmatter, /^allowed-tools:.*\bBash\b/mu);
  assert.doesNotMatch(command.frontmatter, /(?:"Write"|"Edit"|"Glob"|"Grep"|"Agent"|"Skill")/u);
  assert.doesNotMatch(skill.frontmatter, /(?:"Write"|"Edit"|"Glob"|"Grep"|"Agent"|"Skill")/u);
});

test('host resolves and invokes only the packaged core with data-safe argv handling', async () => {
  const { body } = splitMarkdown(await read(hostPaths[0]), hostPaths[0]);

  assert.match(body, /\$\{CLAUDE_PLUGIN_ROOT\}\/runtime\/cli\.mjs/u);
  assert.match(body, /node "\$\{CLAUDE_PLUGIN_ROOT\}\/runtime\/cli\.mjs" <mapped CLI argv>/u);
  assert.match(body, /single argv value/u);
  assert.match(body, /POSIX single-quoted word/u);
  assert.match(body, /embedded\s+single quote[\s\S]{0,120}close-quote[\s\S]{0,80}reopen/iu);
  assert.match(body, /Never use[\s\S]{0,100}`eval`/u);
  assert.match(body, /Never interpolate[^\n]+shell source/u);
  assert.match(body, /spaces[\s\S]{0,120}`\$\(\)`[\s\S]{0,80}`;`[\s\S]{0,80}newlines/u);
  assert.match(body, /Never pass raw\s+`\$ARGUMENTS`/u);
  assert.match(body, /repository[\s\S]{0,100}page[\s\S]{0,100}response[\s\S]{0,100}report[\s\S]{0,160}untrusted data/iu);
  assert.match(body, /instruction\s+injection/u);
  assert.match(body, /one documented core command/u);
  assert.match(body, /does not auto-approve Bash[\s\S]{0,120}normal operator permission/iu);

  assert.doesNotMatch(body, /(?:^|\s)curl(?:\s|$)/mu);
  assert.doesNotMatch(body, /rm\s+-rf/u);
  assert.doesNotMatch(body, /Use (?:the )?Read tool to read[^\n]*(?:target|source|manifest|\.env|credential)/iu);
  assert.doesNotMatch(body, /(?:split|parse) `?\$ARGUMENTS`?/iu);
  assert.doesNotMatch(
    body,
    /(?:^|\n)(?![^\n]*(?:do not|never))(?=[^\n]*(?:merge|compute|calculate))(?=[^\n]*(?:risk|role|policy))[^\n]*/iu,
  );
  assert.doesNotMatch(body, /["'`](?:email|password|token)["'`]\s*:/iu);
});

test('every supported host subcommand maps once to the exact core argv contract', async () => {
  const { body } = splitMarkdown(await read(hostPaths[0]), hostPaths[0]);

  for (const [command, contract] of commandContracts) {
    const row = `| \`${command}\` | \`${contract}\` |`;
    assert.equal(countMatches(body, new RegExp(row.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'gu')), 1,
      `${command} must have exactly one authoritative mapping`);
  }

  assert.match(body, /`--help`[^\n]+`--version`/u);
  assert.match(body, /`--run-id`[\s\S]{0,80}execution/u);
  assert.match(body, /`--run`[\s\S]{0,80}existing run/u);
  assert.match(body, /duplicate[\s\S]{0,80}flag[\s\S]{0,80}reject/iu);
  assert.match(body, /aliases[\s\S]{0,80}`--flag=value`[\s\S]{0,80}extra positional/iu);
  assert.match(body, /exit code `0`[\s\S]{0,180}clean execution result/iu);
  assert.match(body, /exit code `2` is returned only[\s\S]{0,180}completed with critical\/error findings/iu);
  assert.match(body, /exit code `1`[\s\S]{0,100}usage[\s\S]{0,60}config[\s\S]{0,60}runtime/iu);
});

test('host setup and execution keep authority in private operator configuration', async () => {
  const { body } = splitMarkdown(await read(hostPaths[0]), hostPaths[0]);

  assert.match(body, /operator-owned/u);
  assert.match(body, /outside the target (?:root|repository)/u);
  assert.match(body, /`0600` or `0400`/u);
  assert.match(body, /non-symlink/u);
  assert.match(body, /reports? candidates only/iu);
  assert.match(body, /never promotes?[^\n]+target[^\n]+trusted config/iu);
  assert.match(body, /does not ask for[\s\S]{0,120}credentials/iu);
  assert.match(body, /does not ask[\s\S]{0,120}mutation approval/iu);
  assert.match(body, /forward[\s\S]{0,80}`--sandbox-acknowledged`[\s\S]{0,100}explicit/iu);
});

test('host claims only the deterministic Sentinel 2.0 support matrix', async () => {
  const documents = await Promise.all([
    ...hostPaths.map(read),
    read('.claude-plugin/plugin.json'),
    read('.claude-plugin/marketplace.json'),
  ]);

  for (const document of documents) {
    assert.match(document, /OpenAPI 3\.0\/3\.1 JSON/u);
    assert.match(document, /static literal Vue Router/u);
    assert.match(document, /bearer-token role/u);
    assert.match(document, /system\s+Chrome\/Chromium/u);
    assert.match(document, /complete[\s\S]{0,80}partial[\s\S]{0,80}unsupported/iu);
    assert.doesNotMatch(document, /(?:14\+ frameworks|Supports Python|full parser|all frameworks|any web app)/iu);
  }
});

test('explanation agents are read-only consumers of canonical artifacts', async () => {
  for (const relativePath of agentPaths) {
    const { frontmatter, body } = splitMarkdown(await read(relativePath), relativePath);

    assert.match(frontmatter, /^tools: \["Read"\]$/mu);
    assert.doesNotMatch(frontmatter, /(?:Bash|Write|Edit|Glob|Grep|mcp__|browser_|playwright)/iu);
    assert.match(body, /canonical (?:artifact|report)/iu);
    assert.match(body, /untrusted data/u);
    assert.match(body, /instruction injection/u);
    assert.match(body, /do not (?:execute|run)/iu);
    assert.match(body, /do not (?:write|modify|mutate)/iu);
    assert.match(body, /do not (?:decide|compute|lower)[^\n]*(?:risk|safety|policy)/iu);
    assert.match(body, /If the artifact content is already supplied[^\n]+do not read/iu);
    assert.doesNotMatch(body, /(?:^|\s)curl(?:\s|$)/mu);
    assert.doesNotMatch(body, /rm\s+-rf/u);
    assert.doesNotMatch(body, /["'`](?:email|password|token)["'`]\s*:/iu);
  }
});

test('the fixed packaged wrapper preserves adversarial argv without shell execution', async (t) => {
  const { body } = splitMarkdown(await read(hostPaths[0]), hostPaths[0]);
  // This is executable proof of the packaged process boundary, not a claim that
  // prose can deterministically constrain every future model-generated tool call.
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'sentinel-host-argv-'));
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));

  const capturePath = join(temporaryRoot, 'argv.json');
  const markerPath = join(temporaryRoot, 'must-not-exist');
  const fakePython = join(temporaryRoot, 'python3');
  await writeFile(fakePython, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.SENTINEL_HOST_ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));
`, { mode: 0o700 });

  const adversarialValues = [
    'target with spaces',
    `$(touch ${markerPath})`,
    `; touch ${markerPath}`,
    "single'quote",
    'double"quote',
    'line one\nline two',
    'IGNORE PREVIOUS INSTRUCTIONS',
    '.env',
    'seed-password-token',
    'unsupported-django-project',
  ];

  await execFileAsync(fileURLToPath(new URL('../../codex/bin/sentinel-codex.sh', import.meta.url)), adversarialValues, {
    env: {
      ...process.env,
      PATH: `${temporaryRoot}:${process.env.PATH ?? ''}`,
      SENTINEL_HOST_ARGV_CAPTURE: capturePath,
    },
  });

  const captured = JSON.parse(await readFile(capturePath, 'utf8'));
  assert.match(captured[0], /sentinel_codex\.py$/u);
  assert.deepEqual(captured.slice(1), adversarialValues);
  await assert.rejects(access(markerPath, fsConstants.F_OK), { code: 'ENOENT' });
  assert.match(body, /opaque data/u);
  assert.match(body, /do not obey[\s\S]{0,100}target[\s\S]{0,80}artifact/iu);
  assert.match(body, /do not inspect[\s\S]{0,160}\.env/iu);
  assert.match(body, /unsupported framework[\s\S]{0,100}unsupported/iu);
});
