import assert from 'node:assert/strict';
import test from 'node:test';

import { snapshotJson } from '../../runtime/lib/json-snapshot.mjs';

test('snapshots every JSON object into a null-prototype container', () => {
  const snapshot = snapshotJson({
    nested: { value: true },
    items: [{ value: false }],
  });

  assert.equal(Object.getPrototypeOf(snapshot), null);
  assert.equal(Object.getPrototypeOf(snapshot.nested), null);
  assert.equal(Object.getPrototypeOf(snapshot.items[0]), null);
  assert.equal(Object.getPrototypeOf(snapshot.items), Array.prototype);
});

test('defines array indices without invoking inherited numeric setters', () => {
  const poisonedIndex = 2048;
  const input = Array.from({ length: poisonedIndex + 1 }, (_, index) => ({ index }));
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, poisonedIndex);
  let setterCalls = 0;
  let snapshot;
  Object.defineProperty(Array.prototype, poisonedIndex, {
    configurable: true,
    set() {
      setterCalls += 1;
    },
  });

  try {
    snapshot = snapshotJson(input);
  } finally {
    if (previous === undefined) delete Array.prototype[poisonedIndex];
    else Object.defineProperty(Array.prototype, poisonedIndex, previous);
  }

  assert.equal(setterCalls, 0);
  assert.equal(Object.hasOwn(snapshot, poisonedIndex), true);
  assert.equal(snapshot[poisonedIndex].index, poisonedIndex);
});

test('routes excessive acyclic depth through the configured limit failure', () => {
  let input = null;
  for (let depth = 0; depth < 256; depth += 1) input = { child: input };

  assert.throws(
    () => snapshotJson(input, {
      code: 'SNAPSHOT_INPUT_INVALID',
      limitCode: 'SNAPSHOT_LIMIT_EXCEEDED',
      maxDepth: 64,
    }),
    (error) => error?.code === 'SNAPSHOT_LIMIT_EXCEEDED',
  );
});

test('routes excessive own-property work through the configured limit failure', () => {
  const input = Object.fromEntries(
    Array.from({ length: 1025 }, (_, index) => [`property${index}`, index]),
  );

  assert.throws(
    () => snapshotJson(input, {
      code: 'SNAPSHOT_INPUT_INVALID',
      limitCode: 'SNAPSHOT_LIMIT_EXCEEDED',
      maxProperties: 1024,
    }),
    (error) => error?.code === 'SNAPSHOT_LIMIT_EXCEEDED',
  );
});

test('routes excessive scalar-string work through the configured limit failure', () => {
  assert.throws(
    () => snapshotJson('x'.repeat(1025), {
      code: 'SNAPSHOT_INPUT_INVALID',
      limitCode: 'SNAPSHOT_LIMIT_EXCEEDED',
      maxStringLength: 1024,
    }),
    (error) => error?.code === 'SNAPSHOT_LIMIT_EXCEEDED',
  );

  assert.throws(
    () => snapshotJson({ first: 'x'.repeat(600), second: 'y'.repeat(600) }, {
      code: 'SNAPSHOT_INPUT_INVALID',
      limitCode: 'SNAPSHOT_LIMIT_EXCEEDED',
      maxStringLength: 1024,
      maxStringUnits: 1000,
    }),
    (error) => error?.code === 'SNAPSHOT_LIMIT_EXCEEDED',
  );
});

test('deep-freezes every child even when Array iteration is ambiently poisoned', () => {
  const previous = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
  let snapshot;
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    configurable: true,
    writable: true,
    value: function* emptyIterator() {},
  });

  try {
    snapshot = snapshotJson({ nested: { value: true } });
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, previous);
  }

  assert.equal(Object.hasOwn(snapshot, 'nested'), true);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.nested), true);
});
