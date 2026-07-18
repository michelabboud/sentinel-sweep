import test from 'node:test';
import assert from 'node:assert/strict';

import { SentinelError } from '../../runtime/lib/errors.mjs';
import { validateAgainstSchema } from '../../runtime/lib/schema.mjs';

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
