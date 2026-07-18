import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { SentinelError } from '../../runtime/lib/errors.mjs';
import { validateAgainstSchema } from '../../runtime/lib/schema.mjs';

function captureError(callback) {
  try {
    callback();
    return null;
  } catch (error) {
    return error;
  }
}

function withPrototypeValue(prototype, key, value, callback) {
  const previous = Object.getOwnPropertyDescriptor(prototype, key);
  Object.defineProperty(prototype, key, {
    configurable: true,
    writable: true,
    value,
  });
  try {
    return callback();
  } finally {
    if (previous === undefined) delete prototype[key];
    else Object.defineProperty(prototype, key, previous);
  }
}

const schema = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
  },
};

test('accepts a strict valid object', () => {
  assert.doesNotThrow(() => {
    validateAgainstSchema({ name: 'app' }, schema, { name: 'sample' });
  });
});

test('rejects missing and unknown properties with a stable error code', () => {
  assert.throws(
    () => validateAgainstSchema({ extra: true }, schema, { name: 'sample' }),
    (error) => error.code === 'SCHEMA_INVALID' && /sample/.test(error.message),
  );
});

test('supports the recursive schema subset used by bundled contracts', () => {
  const recursiveSchema = {
    $defs: {
      item: {
        type: 'object',
        required: ['id', 'score'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', pattern: '^[a-z]+$', minLength: 1 },
          score: { type: 'integer', minimum: 0, maximum: 100 },
        },
      },
    },
    type: 'object',
    required: ['kind', 'items', 'choice'],
    additionalProperties: false,
    properties: {
      kind: { const: 'record' },
      items: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/$defs/item' },
      },
      choice: {
        oneOf: [
          { type: 'string', enum: ['alpha'] },
          { type: 'integer', minimum: 1, maximum: 2 },
        ],
      },
      note: {
        anyOf: [
          { type: 'null' },
          { type: 'string', minLength: 2 },
        ],
      },
    },
    allOf: [
      {
        properties: {
          kind: { type: ['string', 'null'], pattern: '^record$' },
        },
      },
    ],
  };

  assert.doesNotThrow(() => {
    validateAgainstSchema(
      {
        kind: 'record',
        items: [{ id: 'alpha', score: 100 }],
        choice: 2,
        note: null,
      },
      recursiveSchema,
      { name: 'recursive' },
    );
  });
});

test('collects sorted violations without including inspected values', () => {
  const secretValue = 'do-not-leak-this-value';
  let caught;

  try {
    validateAgainstSchema(
      { name: '', extra: secretValue },
      schema,
      { name: 'secret-safe' },
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof SentinelError);
  assert.equal(caught.code, 'SCHEMA_INVALID');
  assert.deepEqual(caught.details.violations, [
    { path: '/extra', keyword: 'additionalProperties' },
    { path: '/name', keyword: 'minLength' },
  ]);
  assert.doesNotMatch(JSON.stringify(caught.toJSON()), /do-not-leak-this-value/);
});

test('rejects every assertion keyword with exact paths and keywords', () => {
  const cases = [
    {
      name: 'type',
      value: 1,
      schema: { type: 'string' },
      expected: [{ path: '', keyword: 'type' }],
    },
    {
      name: 'type array',
      value: true,
      schema: { type: ['string', 'null'] },
      expected: [{ path: '', keyword: 'type' }],
    },
    {
      name: 'const',
      value: 'other',
      schema: { const: 'fixed' },
      expected: [{ path: '', keyword: 'const' }],
    },
    {
      name: 'enum',
      value: 'other',
      schema: { enum: ['fixed'] },
      expected: [{ path: '', keyword: 'enum' }],
    },
    {
      name: 'required',
      value: {},
      schema: { type: 'object', required: ['name'] },
      expected: [{ path: '/name', keyword: 'required' }],
    },
    {
      name: 'additionalProperties',
      value: { extra: true },
      schema: { type: 'object', additionalProperties: false },
      expected: [{ path: '/extra', keyword: 'additionalProperties' }],
    },
    {
      name: 'minItems',
      value: [],
      schema: { type: 'array', minItems: 1 },
      expected: [{ path: '', keyword: 'minItems' }],
    },
    {
      name: 'maxItems',
      value: [1, 2],
      schema: { type: 'array', maxItems: 1 },
      expected: [{ path: '', keyword: 'maxItems' }],
    },
    {
      name: 'minLength',
      value: '',
      schema: { type: 'string', minLength: 1 },
      expected: [{ path: '', keyword: 'minLength' }],
    },
    {
      name: 'pattern',
      value: 'lower',
      schema: { type: 'string', pattern: '^[A-Z]+$' },
      expected: [{ path: '', keyword: 'pattern' }],
    },
    {
      name: 'minimum',
      value: -1,
      schema: { type: 'number', minimum: 0 },
      expected: [{ path: '', keyword: 'minimum' }],
    },
    {
      name: 'maximum',
      value: 11,
      schema: { type: 'number', maximum: 10 },
      expected: [{ path: '', keyword: 'maximum' }],
    },
    {
      name: 'anyOf',
      value: true,
      schema: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      expected: [{ path: '', keyword: 'anyOf' }],
    },
    {
      name: 'oneOf',
      value: 1,
      schema: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
      expected: [{ path: '', keyword: 'oneOf' }],
    },
  ];

  for (const entry of cases) {
    assert.throws(
      () => validateAgainstSchema(entry.value, entry.schema, { name: entry.name }),
      (error) => {
        assert.deepEqual(error.details.violations, entry.expected);
        return true;
      },
      entry.name,
    );
  }
});

test('applies ref, properties, items, and allOf recursively', () => {
  const recursiveCases = [
    {
      name: '$ref',
      value: { payload: 1 },
      schema: {
        $defs: { text: { type: 'string' } },
        properties: { payload: { $ref: '#/$defs/text' } },
      },
      expected: [{ path: '/payload', keyword: 'type' }],
    },
    {
      name: 'properties',
      value: { outer: { inner: 1 } },
      schema: {
        properties: {
          outer: { properties: { inner: { type: 'string' } } },
        },
      },
      expected: [{ path: '/outer/inner', keyword: 'type' }],
    },
    {
      name: 'items',
      value: { items: ['ok', 1] },
      schema: {
        properties: {
          items: { type: 'array', items: { type: 'string' } },
        },
      },
      expected: [{ path: '/items/1', keyword: 'type' }],
    },
    {
      name: 'additionalProperties schema',
      value: { labels: { valid: 'yes', invalid: 1 } },
      schema: {
        properties: {
          labels: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
      },
      expected: [{ path: '/labels/invalid', keyword: 'type' }],
    },
    {
      name: 'allOf',
      value: { value: 'x' },
      schema: {
        properties: {
          value: { allOf: [{ type: 'string' }, { minLength: 2 }] },
        },
      },
      expected: [{ path: '/value', keyword: 'minLength' }],
    },
  ];

  for (const entry of recursiveCases) {
    assert.throws(
      () => validateAgainstSchema(entry.value, entry.schema, { name: entry.name }),
      (error) => {
        assert.deepEqual(error.details.violations, entry.expected);
        return true;
      },
      entry.name,
    );
  }
});

test('reports nested unknown properties at the nested JSON pointer', () => {
  const nestedSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      config: {
        type: 'object',
        additionalProperties: false,
        properties: { known: { type: 'boolean' } },
      },
    },
  };

  assert.throws(
    () => validateAgainstSchema(
      { config: { known: true, unexpected: true } },
      nestedSchema,
      { name: 'nested' },
    ),
    (error) => {
      assert.deepEqual(error.details.violations, [
        { path: '/config/unexpected', keyword: 'additionalProperties' },
      ]);
      return true;
    },
  );
});

test('sorts Unicode JSON pointers by deterministic code-unit order', () => {
  assert.throws(
    () => validateAgainstSchema(
      { 'ä': true, z: true },
      { type: 'object', additionalProperties: false },
      { name: 'unicode-order' },
    ),
    (error) => {
      assert.deepEqual(error.details.violations, [
        { path: '/z', keyword: 'additionalProperties' },
        { path: '/ä', keyword: 'additionalProperties' },
      ]);
      return true;
    },
  );
});

test('serializes Sentinel errors with the stable public fields', () => {
  const error = new SentinelError('EXAMPLE', 'example message', {
    violations: [{ path: '/field', keyword: 'type' }],
  });

  assert.deepEqual(error.toJSON(), {
    name: 'SentinelError',
    code: 'EXAMPLE',
    message: 'example message',
    details: {
      violations: [{ path: '/field', keyword: 'type' }],
    },
  });
});

test('rejects accessor-backed values and schemas without invoking attacker code', () => {
  let valueReads = 0;
  const accessorValue = {};
  Object.defineProperty(accessorValue, 'name', {
    enumerable: true,
    get() {
      valueReads += 1;
      return 'app';
    },
  });
  assert.throws(
    () => validateAgainstSchema(accessorValue, schema, { name: 'accessor value' }),
    (error) => error?.code === 'SCHEMA_INVALID',
  );
  assert.equal(valueReads, 0);

  let schemaReads = 0;
  const accessorSchema = {};
  Object.defineProperty(accessorSchema, 'type', {
    enumerable: true,
    get() {
      schemaReads += 1;
      return 'object';
    },
  });
  assert.throws(
    () => validateAgainstSchema({}, accessorSchema, { name: 'accessor schema' }),
    (error) => error?.code === 'SCHEMA_DEFINITION_INVALID',
  );
  assert.equal(schemaReads, 0);

  let optionReads = 0;
  const accessorOptions = {};
  Object.defineProperty(accessorOptions, 'name', {
    enumerable: true,
    get() {
      optionReads += 1;
      return 'accessor options';
    },
  });
  assert.throws(
    () => validateAgainstSchema({}, { type: 'object' }, accessorOptions),
    (error) => error?.code === 'SCHEMA_INVALID',
  );
  assert.equal(optionReads, 0);
});

test('fails closed when schema validation exceeds its global work budget', () => {
  const excessive = Array.from({ length: 100_000 }, () => 'valid');

  assert.throws(
    () => validateAgainstSchema(
      excessive,
      { type: 'array', items: { type: 'string' } },
      { name: 'excessive' },
    ),
    (error) => error?.code === 'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
  );
});

test('reports every exact path when the same invalid object appears more than once', () => {
  const sharedInvalid = { name: 42 };

  assert.throws(
    () => validateAgainstSchema(
      { items: [sharedInvalid, sharedInvalid] },
      {
        properties: {
          items: {
            type: 'array',
            items: { properties: { name: { type: 'string' } } },
          },
        },
      },
      { name: 'shared invalid object' },
    ),
    (error) => {
      assert.deepEqual(error?.details?.violations, [
        { path: '/items/0/name', keyword: 'type' },
        { path: '/items/1/name', keyword: 'type' },
      ]);
      return true;
    },
  );
});

test('bounds validation of a deeply shared invalid DAG', () => {
  let sharedInvalid = { value: 42 };
  for (let depth = 0; depth < 20; depth += 1) {
    sharedInvalid = { allOf: [sharedInvalid, sharedInvalid] };
  }

  assert.throws(
    () => validateAgainstSchema(
      sharedInvalid,
      {
        properties: {
          allOf: { type: 'array', items: { $ref: '#' } },
          value: { type: 'string' },
        },
      },
      { name: 'shared invalid DAG' },
    ),
    (error) => error?.code === 'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
  );
});

test('maps deeply acyclic value and schema inputs to the validation limit', () => {
  let deepValue = null;
  let deepSchema = { type: 'null' };
  for (let depth = 0; depth < 20_000; depth += 1) {
    deepValue = { child: deepValue };
    deepSchema = { properties: { child: deepSchema } };
  }

  assert.throws(
    () => validateAgainstSchema(deepValue, { type: 'object' }),
    (error) => error?.code === 'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
  );
  assert.throws(
    () => validateAgainstSchema({}, deepSchema),
    (error) => error?.code === 'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
  );
});

test('rejects oversized scalar strings before minLength and pattern work', () => {
  const oversized = 'x'.repeat(10_000_000);

  assert.throws(
    () => validateAgainstSchema(oversized, { type: 'string', minLength: oversized.length + 1 }),
    (error) => error?.code === 'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
  );
  assert.throws(
    () => validateAgainstSchema('safe', { type: 'string', pattern: oversized }),
    (error) => error?.code === 'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
  );
  assert.throws(
    () => validateAgainstSchema('safe', { const: oversized }),
    (error) => error?.code === 'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
  );
  assert.throws(
    () => validateAgainstSchema('safe', { enum: [oversized] }),
    (error) => error?.code === 'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
  );
});

test('does not memoize successful primitive validations across negative and positive zero', () => {
  const itemSchema = { type: 'array', items: { const: -0 } };

  for (const [values, invalidIndex] of [
    [[-0, +0], 1],
    [[+0, -0], 0],
  ]) {
    assert.throws(
      () => validateAgainstSchema(values, itemSchema),
      (error) => {
        assert.deepEqual(error?.details?.violations, [
          { path: `/${invalidIndex}`, keyword: 'const' },
        ]);
        return true;
      },
    );
  }
});

test('does not trust ambient Array prototype methods during validation', () => {
  const forEachError = withPrototypeValue(
    Array.prototype,
    'forEach',
    function suppressedForEach() {},
    () => captureError(() => validateAgainstSchema(
      ['bad'],
      { type: 'array', items: { type: 'number' } },
    )),
  );
  assert.deepEqual(forEachError?.details?.violations, [{ path: '/0', keyword: 'type' }]);

  const someError = withPrototypeValue(
    Array.prototype,
    'some',
    function forgedSome() { return true; },
    () => captureError(() => validateAgainstSchema('bad', { enum: ['good'] })),
  );
  assert.deepEqual(someError?.details?.violations, [{ path: '', keyword: 'enum' }]);

  const reduceError = withPrototypeValue(
    Array.prototype,
    'reduce',
    function forgedReduce() { return 1; },
    () => captureError(() => validateAgainstSchema(
      true,
      { oneOf: [{ type: 'string' }, { type: 'number' }] },
    )),
  );
  assert.deepEqual(reduceError?.details?.violations, [{ path: '', keyword: 'oneOf' }]);

  const orderingError = withPrototypeValue(
    Array.prototype,
    'sort',
    function suppressedSort() { return this; },
    () => withPrototypeValue(
      Array.prototype,
      'filter',
      function suppressedFilter() { return []; },
      () => captureError(() => validateAgainstSchema(
        { z: true, a: true },
        { type: 'object', additionalProperties: false },
      )),
    ),
  );
  assert.deepEqual(orderingError?.details?.violations, [
    { path: '/a', keyword: 'additionalProperties' },
    { path: '/z', keyword: 'additionalProperties' },
  ]);
});

test('does not trust ambient Array or String iterators during validation', () => {
  const arrayIteratorError = withPrototypeValue(
    Array.prototype,
    Symbol.iterator,
    function* emptyIterator() {},
    () => captureError(() => validateAgainstSchema(
      'bad',
      { allOf: [{ type: 'number' }] },
    )),
  );
  assert.deepEqual(arrayIteratorError?.details?.violations, [{ path: '', keyword: 'type' }]);

  const stringIteratorError = withPrototypeValue(
    String.prototype,
    Symbol.iterator,
    function forgedStringIterator() {
      let emitted = false;
      return {
        next() {
          if (emitted) return { done: true, value: undefined };
          emitted = true;
          return { done: false, value: 'x' };
        },
      };
    },
    () => captureError(() => validateAgainstSchema('', { type: 'string', minLength: 1 })),
  );
  assert.deepEqual(stringIteratorError?.details?.violations, [
    { path: '', keyword: 'minLength' },
  ]);
});

test('does not dispatch pattern checks through a mutable RegExp prototype', () => {
  let calls = 0;
  const error = withPrototypeValue(
    RegExp.prototype,
    'test',
    function forgedPatternMatch() {
      calls += 1;
      return true;
    },
    () => captureError(() => validateAgainstSchema(
      'lower',
      { type: 'string', pattern: '^[A-Z]+$' },
      { name: 'pattern poison' },
    )),
  );

  assert.equal(calls, 0);
  assert.deepEqual(error?.details?.violations, [{ path: '', keyword: 'pattern' }]);
});

test('uses pristine pattern matching when RegExp.test is poisoned before import', () => {
  const moduleUrl = new URL('../../runtime/lib/schema.mjs', import.meta.url).href;
  const script = `
    let calls = 0;
    RegExp.prototype.test = function poisonedTest() {
      calls += 1;
      return true;
    };
    const { validateAgainstSchema: validate } = await import(${JSON.stringify(moduleUrl)});
    let code = null;
    try {
      validate('attacker', { type: 'string', pattern: '^trusted$' });
    } catch (error) {
      code = error?.code ?? String(error);
    }
    process.stdout.write(JSON.stringify({ calls, code }));
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { calls: 0, code: 'SCHEMA_INVALID' });
});

test('does not dispatch JSON pointer escaping through a mutable String prototype', () => {
  let calls = 0;
  const error = withPrototypeValue(
    String.prototype,
    'replaceAll',
    function forgedReplacement() {
      calls += 1;
      return String(this);
    },
    () => captureError(() => validateAgainstSchema(
      { 'a/b~c': true },
      { type: 'object', additionalProperties: false },
      { name: 'pointer poison' },
    )),
  );

  assert.equal(calls, 0);
  assert.deepEqual(error?.details?.violations, [
    { path: '/a~1b~0c', keyword: 'additionalProperties' },
  ]);
});
