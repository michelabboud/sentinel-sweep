import { types as utilTypes } from 'node:util';

import { SentinelError } from './errors.mjs';

function snapshotFailure(code, message) {
  return new SentinelError(code, message);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  for (let index = 0; index < keys.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
      deepFreeze(descriptor.value, seen);
    }
  }
  return Object.freeze(value);
}

function defineJsonProperty(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function useString(value, context) {
  if (value.length > context.maxStringLength) throw context.limitFailure;
  context.stringUnits += value.length;
  if (context.stringUnits > context.maxStringUnits) throw context.limitFailure;
}

function useProperties(amount, context) {
  context.properties += amount;
  if (context.properties > context.maxProperties) throw context.limitFailure;
}

function snapshotNode(value, context, depth = 0) {
  if (depth > context.maxDepth) throw context.limitFailure;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    useString(value, context);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw context.failure;
    return value;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) throw context.failure;
  if (context.active.has(value)) throw context.failure;
  if (context.memo.has(value)) return context.memo.get(value);

  context.nodes += 1;
  if (context.nodes > context.maxNodes) throw context.limitFailure;
  context.active.add(value);
  try {
    const keys = Reflect.ownKeys(value);
    const array = Array.isArray(value);
    useProperties(array ? keys.length - 1 : keys.length, context);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (typeof key !== 'string') throw context.failure;
      useString(key, context);
    }

    if (array) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw context.failure;
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (lengthDescriptor === undefined
          || !Object.hasOwn(lengthDescriptor, 'value')
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0) {
        throw context.failure;
      }
      const length = lengthDescriptor.value;
      if (length > context.maxArrayLength) throw context.limitFailure;
      if (keys.length !== length + 1) throw context.failure;
      const result = new Array(length);
      context.memo.set(value, result);
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined
            || !Object.hasOwn(descriptor, 'value')
            || descriptor.enumerable !== true) {
          throw context.failure;
        }
        defineJsonProperty(
          result,
          String(index),
          snapshotNode(descriptor.value, context, depth + 1),
        );
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw context.failure;
    const result = Object.create(null);
    context.memo.set(value, result);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw context.failure;
      }
      defineJsonProperty(result, key, snapshotNode(descriptor.value, context, depth + 1));
    }
    return result;
  } finally {
    context.active.delete(value);
  }
}

/**
 * Captures recursively plain, own-data JSON without invoking accessors or proxy traps.
 * The returned graph is immutable and detached from the caller's objects.
 */
export function snapshotJson(value, {
  code = 'JSON_INPUT_INVALID',
  message = 'Input must be recursively plain own-data JSON',
  maxNodes = 200_000,
  maxArrayLength = 100_000,
  maxDepth = 512,
  maxProperties = maxNodes,
  maxStringLength = 1_000_000,
  maxStringUnits = maxStringLength * 4,
  limitCode = code,
  limitMessage = message,
} = {}) {
  const failure = snapshotFailure(code, message);
  const limitFailure = snapshotFailure(limitCode, limitMessage);
  let snapshot;
  try {
    snapshot = snapshotNode(value, {
      active: new WeakSet(),
      memo: new WeakMap(),
      nodes: 0,
      properties: 0,
      stringUnits: 0,
      maxNodes,
      maxArrayLength,
      maxDepth,
      maxProperties,
      maxStringLength,
      maxStringUnits,
      failure,
      limitFailure,
    });
  } catch (error) {
    if (error === failure) throw failure;
    if (error === limitFailure) throw limitFailure;
    throw failure;
  }
  return deepFreeze(snapshot);
}
