import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { resolveSecret } from '../../runtime/lib/secrets.mjs';

const ROOT = new URL('../../', import.meta.url);

async function read(relativePath) {
  return readFile(new URL(relativePath, ROOT), 'utf8');
}

test('documented environment canaries are valid supported bearer values', async () => {
  for (const relativePath of [
    'README.md',
    'codex/README.md',
    'docs/guides/migrating-to-2.0.md',
  ]) {
    const document = await read(relativePath);
    const exports = [...document.matchAll(
      /export (SENTINEL_(?:ADMIN|USER)_TOKEN)='([^']+)'/gu,
    )];
    assert.equal(exports.length, 2, `${relativePath} must show both role canaries`);
    for (const [, name, value] of exports) {
      assert.equal(resolveSecret(`env:${name}`, { [name]: value }), value);
      assert.match(value, /canary/iu);
    }
    assert.doesNotMatch(document, /export SENTINEL_[A-Z_]+='value supplied/iu);
  }
});

test('security docs state the actual credential capture and Chrome environment timing', async () => {
  for (const relativePath of [
    'README.md',
    'SECURITY.md',
    'ARCHITECTURE.md',
    'docs/adr/0001-deterministic-trusted-core.md',
    'docs/superpowers/specs/2026-07-18-sentinel-2.0-goal-hardening-design.md',
  ]) {
    const document = await read(relativePath);
    assert.match(
      document,
      /resolves\s+currently\s+available\s+configured\s+secrets\s+to\s+build\s+(?:the|its)\s+redactor/iu,
      relativePath,
    );
    assert.match(
      document,
      /synchronously\s+captures\s+only\s+the\s+planned-role\s+credentials\s+before\s+that\s+engine\s+begins\s+application\s+I\/O/iu,
      relativePath,
    );
    assert.match(
      document,
      /Chrome\s+receives\s+a\s+fixed\s+minimal\s+environment\s+with\s+run-scoped\s+`HOME`,\s+`XDG_[A-Z_]+`,\s+and\s+`TMPDIR`/iu,
      relativePath,
    );
    assert.match(document, /bearer-token\s+environment\s+variables\s+are\s+not\s+inherited/iu, relativePath);
    assert.doesNotMatch(document, /resolved? immediately before an approved request/iu);
    assert.doesNotMatch(document, /resolving only `env:NAME` references at\s+request time/iu);
  }
});

test('migration creates the config privately before editing and documents valid lineage', async () => {
  const migration = await read('docs/guides/migrating-to-2.0.md');
  assert.match(
    migration,
    /install -m 0600 codex\/config\.example\.json \/home\/alice\/\.config\/sentinel\/example\.json/u,
  );
  assert.doesNotMatch(migration, /chmod 0600 \/home\/alice\/\.config\/sentinel\/example\.json/u);

  const changelog = await read('CHANGELOG.md');
  assert.match(
    changelog,
    /exports\s+built\s+from\s+the\s+validated\s+published\s+manifest\s+and\s+current\s+trusted\s+config/iu,
  );
  assert.doesNotMatch(changelog, /findings that drive[^\n]*exports/iu);
});

test('Claude and Codex hosts state exact exit and returned-result semantics', async () => {
  const claudeCommand = await read('commands/sentinel.md');
  const claudeSkill = await read('skills/run/SKILL.md');
  const codexCommand = await read('codex/commands/sentinel.md');
  const claudeBody = claudeCommand.slice(claudeCommand.indexOf('You are the Sentinel'));
  const skillBody = claudeSkill.slice(claudeSkill.indexOf('You are the Sentinel'));
  assert.equal(claudeBody, skillBody);

  for (const [relativePath, document] of [
    ['commands/sentinel.md', claudeCommand],
    ['skills/run/SKILL.md', claudeSkill],
    ['codex/commands/sentinel.md', codexCommand],
  ]) {
    assert.match(document, /Exit\s+code\s+`0`\s+means\s+any\s+command\s+completed/iu, relativePath);
    assert.match(
      document,
      /for\s+`api`,\s+`browser`,\s+or\s+`sweep`,\s+the\s+completed\s+execution\s+has\s+no\s+critical\/error\s+findings/iu,
      relativePath,
    );
    assert.match(document, /Exit\s+code\s+`2`\s+is\s+returned\s+only\s+by\s+`api`,\s+`browser`,\s+or\s+`sweep`/iu);
    assert.match(document, /report\s+the\s+public\s+terminal\s+error\s+code\s+exactly/iu, relativePath);
    assert.match(document, /does\s+not\s+return\s+a\s+canonical\s+artifact\s+path/iu, relativePath);
    assert.doesNotMatch(document, /canonical artifact path returned by the (?:core|wrapper)/iu);
  }
});

test('superseded plans and examples cannot masquerade as current Sentinel 2.0 guidance', async () => {
  for (const relativePath of [
    'docs/2026-03-15-sentinel-design.md',
    'docs/2026-03-15-sentinel-plan.md',
  ]) {
    const opening = (await read(relativePath)).slice(0, 1400);
    assert.match(opening, /SUPERSEDED 1\.x/iu, relativePath);
    assert.match(opening, /adr\/0001-deterministic-trusted-core\.md/u, relativePath);
    assert.match(opening, /superpowers\/specs\/2026-07-18-sentinel-2\.0-goal-hardening-design\.md/u, relativePath);
    assert.match(opening, /superpowers\/plans\/2026-07-18-sentinel-2\.0-goal-hardening\.md/u, relativePath);
  }

  for (const relativePath of [
    'docs/example-report/README.md',
    'docs/example-report/sweep.md',
  ]) {
    const opening = (await read(relativePath)).slice(0, 800);
    assert.match(opening, /LEGACY 1\.x EXAMPLE/iu, relativePath);
    assert.match(opening, /not (?:a )?current Sentinel 2\.0/iu, relativePath);
  }
});
