import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { checkJsonSchema } from '../../runtime/api/schema-check.mjs';

const SCHEMA_CHECK_URL = new URL('../../runtime/api/schema-check.mjs', import.meta.url).href;

function runFreshNode(source, options = {}) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', source],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: options.timeout ?? 2_000,
    },
  );
}

test('accepts a value that satisfies a nested response schema', () => {
  const schema = {
    type: 'object',
    required: ['healthy', 'items'],
    additionalProperties: false,
    properties: {
      healthy: { type: 'boolean' },
      items: {
        type: 'array',
        minItems: 1,
        items: { $ref: 'schema:fixture:item' },
      },
    },
  };
  const registry = {
    'schema:fixture:item': {
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'string', minLength: 1 } },
      },
    },
  };

  assert.deepEqual(
    checkJsonSchema({ healthy: true, items: [{ id: 'item-1' }] }, schema, registry),
    [],
  );
});

test('reports deterministic paths and keywords for response schema drift', () => {
  const violations = checkJsonSchema(
    { healthy: 'yes', extra: true },
    {
      type: 'object',
      required: ['healthy', 'version'],
      additionalProperties: false,
      properties: {
        healthy: { type: 'boolean' },
        version: { type: 'integer', minimum: 1 },
      },
    },
    {},
  );

  assert.deepEqual(violations, [
    { path: '/extra', keyword: 'additionalProperties' },
    { path: '/healthy', keyword: 'type' },
    { path: '/version', keyword: 'required' },
  ]);
});

test('reports an unresolved registry reference without throwing or inventing a schema', () => {
  assert.deepEqual(
    checkJsonSchema({ id: 'item-1' }, { $ref: 'schema:fixture:missing' }, {}),
    [{ path: '', keyword: '$ref' }],
  );
});

test('keeps local references anchored to the registered schema document', () => {
  const registry = {
    'schema:fixture:envelope': {
      schema: {
        $defs: {
          identifier: { type: 'string', minLength: 1 },
          item: {
            type: 'object',
            required: ['id'],
            properties: { id: { $ref: '#/$defs/identifier' } },
          },
        },
        $ref: '#/$defs/item',
      },
    },
  };

  assert.deepEqual(
    checkJsonSchema(
      { id: 'item-1' },
      { $ref: 'schema:fixture:envelope' },
      registry,
    ),
    [],
  );
});

test('preserves supported safe JSON Schema pattern behavior', () => {
  const cases = [
    { value: 'sentinel', pattern: '^[a-z]+$', expected: [] },
    {
      value: 'Sentinel',
      pattern: '^[a-z]+$',
      expected: [{ path: '', keyword: 'pattern' }],
    },
    { value: 'operator', pattern: '^(?!(?:password|token)$).+', expected: [] },
    {
      value: 'password',
      pattern: '^(?!(?:password|token)$).+',
      expected: [{ path: '', keyword: 'pattern' }],
    },
    { value: 'Σεντινελ', pattern: '^\\p{Letter}+$', expected: [] },
  ];

  for (const entry of cases) {
    assert.deepEqual(checkJsonSchema(entry.value, {
      type: 'string',
      pattern: entry.pattern,
    }), entry.expected);
  }
});

test('fails closed on structurally unsafe or over-budget patterns', () => {
  const oversizedPattern = 'a'.repeat(513);
  const cases = [
    { value: 'aaaa', pattern: '^(a+)+$' },
    { value: 'aaaa', pattern: '^(a|aa)+$' },
    { value: 'aaaa', pattern: '^(a)\\1+$' },
    { value: 'ab', pattern: '(?<=a)b' },
    { value: 'a', pattern: '^a{1,10001}$' },
    { value: oversizedPattern, pattern: oversizedPattern },
  ];

  for (const entry of cases) {
    assert.deepEqual(
      checkJsonSchema(entry.value, { type: 'string', pattern: entry.pattern }),
      [{ path: '', keyword: 'pattern' }],
    );
  }
});

test('bounds catastrophic target patterns and returns only stable redacted violations', {
  timeout: 2_000,
}, () => {
  const source = `
    import { performance } from 'node:perf_hooks';
    const { checkJsonSchema } = await import(${JSON.stringify(SCHEMA_CHECK_URL)});
    const value = 'a'.repeat(30) + '!';
    const startedAt = performance.now();
    const violations = checkJsonSchema(value, { type: 'string', pattern: '^(a+)+$' });
    const vmStartedAt = performance.now();
    const vmViolations = checkJsonSchema('a'.repeat(40) + '!', {
      type: 'string',
      pattern: '^a+a+a+a+a+a+a+a+b$',
    });
    process.stdout.write(JSON.stringify({
      elapsedMs: performance.now() - startedAt,
      violations,
      vmElapsedMs: performance.now() - vmStartedAt,
      vmViolations,
    }));
  `;
  const startedAt = performance.now();
  const child = runFreshNode(source, { timeout: 1_000 });
  const wallMs = performance.now() - startedAt;

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.ok(wallMs < 1_000, `fresh process exceeded wall budget: ${wallMs}ms`);

  const result = JSON.parse(child.stdout);
  assert.ok(result.elapsedMs < 250, `schema check exceeded work budget: ${result.elapsedMs}ms`);
  assert.deepEqual(result.violations, [{ path: '', keyword: 'pattern' }]);
  assert.ok(result.vmElapsedMs < 250, `isolated VM exceeded work budget: ${result.vmElapsedMs}ms`);
  assert.deepEqual(result.vmViolations, [{ path: '', keyword: 'pattern' }]);
  assert.equal(child.stdout.includes('^(a+)+$'), false);
  assert.equal(child.stdout.includes(`${'a'.repeat(30)}!`), false);
});

test('does not invoke a RegExp.prototype.test poisoned before module import', () => {
  const source = `
    const originalTest = RegExp.prototype.test;
    let targetCalls = 0;
    RegExp.prototype.test = function poisonedTest(value) {
      if (this.source === '^SENTINEL_SAFE$') {
        targetCalls += 1;
        return true;
      }
      return Reflect.apply(originalTest, this, [value]);
    };
    const { checkJsonSchema } = await import(${JSON.stringify(SCHEMA_CHECK_URL)});
    const violations = checkJsonSchema('NOT-SAFE', {
      type: 'string',
      pattern: '^SENTINEL_SAFE$',
    });
    process.stdout.write(JSON.stringify({ targetCalls, violations }));
  `;
  const child = runFreshNode(source);

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    targetCalls: 0,
    violations: [{ path: '', keyword: 'pattern' }],
  });
});

test('fails closed after exhausting the per-check pattern evaluation budget', () => {
  const values = Array.from({ length: 300 }, () => 'safe');
  const violations = checkJsonSchema(values, {
    type: 'array',
    items: { type: 'string', pattern: '^safe$' },
  });

  assert.ok(violations.length > 0);
  assert.ok(violations.every((violation) => violation.keyword === 'pattern'));
});
