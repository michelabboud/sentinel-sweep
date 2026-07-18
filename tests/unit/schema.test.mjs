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
