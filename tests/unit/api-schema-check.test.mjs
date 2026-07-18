import assert from 'node:assert/strict';
import test from 'node:test';

import { checkJsonSchema } from '../../runtime/api/schema-check.mjs';

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
