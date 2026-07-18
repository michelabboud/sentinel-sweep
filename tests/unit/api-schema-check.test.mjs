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

test('fails closed on invalid, non-terminating, or over-budget patterns', () => {
  const oversizedPattern = 'a'.repeat(513);
  const oversizedValue = 'x'.repeat((1024 * 1024) + 1);
  const cases = [
    { value: `${'a'.repeat(40)}!`, pattern: '^(a+)+$' },
    { value: 'value', pattern: '[' },
    { value: oversizedPattern, pattern: oversizedPattern },
    { value: oversizedValue, pattern: '^x+$' },
  ];

  for (const entry of cases) {
    assert.deepEqual(
      checkJsonSchema(entry.value, { type: 'string', pattern: entry.pattern }),
      [{ path: '', keyword: 'pattern' }],
    );
  }
});

test('preserves terminating ECMAScript backreferences, lookbehind, and grouped repetitions', () => {
  const cases = [
    { value: 'aaaa', pattern: '^(a)\\1+$' },
    { value: 'ab', pattern: '(?<=a)b' },
    { value: 'a', pattern: '^a{1,10001}$' },
    { value: 'aaaa', pattern: '^(a|aa)+$' },
  ];

  for (const entry of cases) {
    assert.deepEqual(
      checkJsonSchema(entry.value, { type: 'string', pattern: entry.pattern }),
      [],
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
    const elapsedMs = performance.now() - startedAt;
    const isolatedStartedAt = performance.now();
    const isolatedViolations = checkJsonSchema('a'.repeat(40) + '!', {
      type: 'string',
      pattern: '^a+a+a+a+a+a+a+a+b$',
    });
    process.stdout.write(JSON.stringify({
      elapsedMs,
      isolatedElapsedMs: performance.now() - isolatedStartedAt,
      isolatedViolations,
      violations,
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
  assert.ok(
    result.isolatedElapsedMs < 250,
    `isolated execution exceeded work budget: ${result.isolatedElapsedMs}ms`,
  );
  assert.deepEqual(result.isolatedViolations, [{ path: '', keyword: 'pattern' }]);
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
    const invalidPattern = checkJsonSchema('value', {
      type: 'string',
      pattern: '[',
    });
    process.stdout.write(JSON.stringify({ invalidPattern, targetCalls, violations }));
  `;
  const child = runFreshNode(source);

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    invalidPattern: [{ path: '', keyword: 'pattern' }],
    targetCalls: 0,
    violations: [{ path: '', keyword: 'pattern' }],
  });
});

test('does not dispatch through Script.prototype poisoned before module import', () => {
  const source = `
    const { Script } = await import('node:vm');
    let targetCalls = 0;
    Script.prototype.runInContext = function poisonedRunInContext() {
      targetCalls += 1;
      return true;
    };
    const { checkJsonSchema } = await import(${JSON.stringify(SCHEMA_CHECK_URL)});
    const violations = checkJsonSchema('NOT-SAFE', {
      type: 'string',
      pattern: '^SENTINEL_SAFE$',
    });
    const invalidPattern = checkJsonSchema('value', {
      type: 'string',
      pattern: '[',
    });
    process.stdout.write(JSON.stringify({ invalidPattern, targetCalls, violations }));
  `;
  const child = runFreshNode(source);

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    invalidPattern: [{ path: '', keyword: 'pattern' }],
    targetCalls: 0,
    violations: [{ path: '', keyword: 'pattern' }],
  });
});

test('does not dispatch through Worker.prototype poisoned before module import', () => {
  const source = `
    const { Worker } = await import('node:worker_threads');
    let targetCalls = 0;
    Worker.prototype.postMessage = function poisonedPostMessage({ resultBuffer }) {
      targetCalls += 1;
      const result = new Int32Array(resultBuffer);
      Atomics.store(result, 0, 1);
      Atomics.notify(result, 0);
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

test('keeps unsafe, invalid, timed-out, and exhausted patterns fatal across combinators', () => {
  const catastrophicValue = `${'a'.repeat(40)}!`;
  const safeBranch = { type: 'string', pattern: '^[a!]+$' };
  const cases = [
    {
      schema: {
        anyOf: [
          safeBranch,
          { type: 'string', pattern: '^(a+)+$' },
        ],
      },
      value: catastrophicValue,
      expectedPath: '',
    },
    {
      schema: {
        oneOf: [
          { type: 'string', pattern: '^a+a+a+a+a+a+a+a+b$' },
          safeBranch,
        ],
      },
      value: catastrophicValue,
      expectedPath: '',
    },
    {
      schema: {
        anyOf: [
          safeBranch,
          { type: 'string', pattern: '[' },
        ],
      },
      value: catastrophicValue,
      expectedPath: '',
    },
    {
      schema: {
        anyOf: [
          { type: 'array' },
          {
            type: 'array',
            items: { type: 'string', pattern: '^safe$' },
          },
        ],
      },
      value: Array.from({ length: 257 }, () => 'safe'),
      expectedPath: '/256',
    },
  ];

  for (const entry of cases) {
    assert.deepEqual(checkJsonSchema(entry.value, entry.schema), [
      { path: entry.expectedPath, keyword: 'pattern' },
    ]);
  }
});

test('preserves ordinary bounded IPv4, MAC address, and time patterns', () => {
  const cases = [
    {
      pattern: '^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$',
      valid: '192.168.10.24',
      invalid: '999.168.10.24',
    },
    {
      pattern: '^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$',
      valid: '02:42:ac:11:00:02',
      invalid: '02:42:ac:11:00',
    },
    {
      pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$',
      valid: '23:59:58',
      invalid: '25:61:00',
    },
  ];

  for (const entry of cases) {
    assert.deepEqual(checkJsonSchema(entry.valid, {
      type: 'string',
      pattern: entry.pattern,
    }), []);
    assert.deepEqual(checkJsonSchema(entry.invalid, {
      type: 'string',
      pattern: entry.pattern,
    }), [{ path: '', keyword: 'pattern' }]);
  }
});

test('batches a realistic safe response schema within the repeated-check latency contract', (t) => {
  const schema = {
    type: 'object',
    required: ['host', 'id', 'ip', 'mac', 'observedAt', 'codes'],
    additionalProperties: false,
    properties: {
      host: {
        type: 'string',
        pattern: '^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$',
      },
      id: {
        type: 'string',
        pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      },
      ip: {
        type: 'string',
        pattern: '^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$',
      },
      mac: { type: 'string', pattern: '^(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$' },
      observedAt: {
        type: 'string',
        pattern: '^(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$',
      },
      codes: {
        type: 'array',
        items: { type: 'string', pattern: '^[A-Z]{3}-[0-9]{6}$' },
      },
    },
  };
  const value = {
    host: 'api.sentinel.example',
    id: '123e4567-e89b-42d3-a456-426614174000',
    ip: '192.168.10.24',
    mac: '02:42:ac:11:00:02',
    observedAt: '23:59:58',
    codes: Array.from({ length: 25 }, (_, index) => `SEN-${String(index).padStart(6, '0')}`),
  };
  const repetitions = 10;
  const startedAt = performance.now();
  for (let index = 0; index < repetitions; index += 1) {
    assert.deepEqual(checkJsonSchema(value, schema), []);
  }
  const averageMs = (performance.now() - startedAt) / repetitions;

  t.diagnostic(`realistic safe batch mean: ${averageMs.toFixed(2)} ms/check`);
  assert.ok(averageMs < 200, `safe pattern batch averaged ${averageMs}ms/check`);
});

test('bounds cyclic references and exponential combinators in a fresh process', {
  timeout: 2_000,
}, () => {
  const source = `
    import { performance } from 'node:perf_hooks';
    const { checkJsonSchema } = await import(${JSON.stringify(SCHEMA_CHECK_URL)});
    const schema = { allOf: [{ $ref: '#' }, { $ref: '#' }], pattern: '^x$' };
    const startedAt = performance.now();
    const violations = checkJsonSchema('x', schema);
    process.stdout.write(JSON.stringify({ elapsedMs: performance.now() - startedAt, violations }));
  `;
  const child = runFreshNode(source, { timeout: 1_000 });

  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.ok(result.elapsedMs < 250, `cyclic schema exceeded work budget: ${result.elapsedMs}ms`);
  assert.deepEqual(result.violations, [{ path: '', keyword: '$ref' }]);
});

test('supports finite recursive schemas while bounding total schema work', () => {
  const recursiveSchema = {
    anyOf: [
      { type: 'null' },
      {
        type: 'object',
        required: ['value', 'next'],
        additionalProperties: false,
        properties: {
          value: { type: 'string' },
          next: { $ref: '#' },
        },
      },
    ],
  };
  const value = {
    value: 'first',
    next: {
      value: 'second',
      next: null,
    },
  };

  assert.deepEqual(checkJsonSchema(value, recursiveSchema), []);
  assert.deepEqual(
    checkJsonSchema(null, { allOf: Array.from({ length: 5_000 }, () => ({})) }),
    [{ path: '', keyword: '$ref' }],
  );
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
