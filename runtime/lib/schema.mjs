import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';

import { SentinelError } from './errors.mjs';
import { snapshotJson } from './json-snapshot.mjs';

const MAX_VALIDATION_WORK = 100_000;
const MAX_VALIDATION_NODES = 100_000;
const MAX_VALIDATION_ARRAY_LENGTH = 100_000;
const MAX_VALIDATION_DEPTH = 256;
const MAX_VALIDATION_PROPERTIES = 100_000;
const MAX_VALIDATION_STRING_LENGTH = 1_000_000;
const MAX_VALIDATION_STRING_UNITS = 4_000_000;
const MAX_PATTERN_LENGTH = 4096;

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_SORT = Array.prototype.sort;
const MAP_GET = Map.prototype.get;
const MAP_HAS = Map.prototype.has;
const MAP_SET = Map.prototype.set;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_INTEGER = Number.isInteger;
const OBJECT_HAS_OWN = Object.hasOwn;
const REFLECT_APPLY = Reflect.apply;
const PRISTINE_REGEXP = runInNewContext(
  '({ RegExp, test: RegExp.prototype.test })',
  Object.create(null),
);
const SET_ADD = Set.prototype.add;
const SET_DELETE = Set.prototype.delete;
const SET_HAS = Set.prototype.has;
const STRING = String;
const STRING_CHAR_CODE_AT = String.prototype.charCodeAt;
const STRING_SLICE = String.prototype.slice;
const STRING_SPLIT = String.prototype.split;
const STRING_STARTS_WITH = String.prototype.startsWith;
const WEAK_MAP_GET = WeakMap.prototype.get;
const WEAK_MAP_SET = WeakMap.prototype.set;
const WEAK_SET_ADD = WeakSet.prototype.add;
const WEAK_SET_HAS = WeakSet.prototype.has;

const SCHEMA_FILES = new Map([
  ['settings', 'settings.schema.json'],
  ['settings.schema.json', 'settings.schema.json'],
  ['sentinel-settings-v2', 'settings.schema.json'],
  ['sentinel-manifest', 'sentinel-manifest.schema.json'],
  ['manifest', 'sentinel-manifest.schema.json'],
  ['sentinel-manifest.schema.json', 'sentinel-manifest.schema.json'],
  ['sentinel-manifest-v2', 'sentinel-manifest.schema.json'],
  ['findings', 'findings.schema.json'],
  ['findings.schema.json', 'findings.schema.json'],
  ['sentinel-findings-v2', 'findings.schema.json'],
  ['sweep-history', 'sweep-history.schema.json'],
  ['history', 'sweep-history.schema.json'],
  ['sweep-history.schema.json', 'sweep-history.schema.json'],
  ['sentinel-history-v2', 'sweep-history.schema.json'],
]);

const hasOwn = (value, key) => OBJECT_HAS_OWN(value, key);

function applyIntrinsic(intrinsic, receiver, argumentsList) {
  return REFLECT_APPLY(intrinsic, receiver, argumentsList);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !ARRAY_IS_ARRAY(value);
}

function matchesType(value, type) {
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isObject(value);
    case 'array':
      return ARRAY_IS_ARRAY(value);
    case 'number':
      return typeof value === 'number' && NUMBER_IS_FINITE(value);
    case 'integer':
      return NUMBER_IS_INTEGER(value);
    case 'string':
      return typeof value === 'string';
    default:
      return false;
  }
}

function escapePointerSegment(segment) {
  const value = STRING(segment);
  let escaped = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '~') escaped += '~0';
    else if (value[index] === '/') escaped += '~1';
    else escaped += value[index];
  }
  return escaped;
}

function appendPointer(pointer, segment) {
  return `${pointer}/${escapePointerSegment(segment)}`;
}

function decodePointerSegment(segment) {
  let decoded = '';
  for (let index = 0; index < segment.length; index += 1) {
    if (segment[index] === '~' && segment[index + 1] === '1') {
      decoded += '/';
      index += 1;
    } else if (segment[index] === '~' && segment[index + 1] === '0') {
      decoded += '~';
      index += 1;
    } else {
      decoded += segment[index];
    }
  }
  return decoded;
}

function resolveLocalReference(rootSchema, reference) {
  if (reference === '#') {
    return rootSchema;
  }
  if (typeof reference !== 'string'
      || !applyIntrinsic(STRING_STARTS_WITH, reference, ['#/'])) {
    throw new SentinelError(
      'SCHEMA_DEFINITION_INVALID',
      'Bundled schema contains an unsupported reference',
      { keyword: '$ref' },
    );
  }

  let current = rootSchema;
  const encodedSegments = applyIntrinsic(
    STRING_SPLIT,
    applyIntrinsic(STRING_SLICE, reference, [2]),
    ['/'],
  );
  for (let index = 0; index < encodedSegments.length; index += 1) {
    const encodedSegment = encodedSegments[index];
    const segment = decodePointerSegment(encodedSegment);
    if (!isObject(current) || !hasOwn(current, segment)) {
      throw new SentinelError(
        'SCHEMA_DEFINITION_INVALID',
        'Bundled schema contains an unresolved reference',
        { keyword: '$ref' },
      );
    }
    current = current[segment];
  }

  if (!isObject(current)) {
    throw new SentinelError(
      'SCHEMA_DEFINITION_INVALID',
      'Bundled schema reference does not resolve to a schema object',
      { keyword: '$ref' },
    );
  }
  return current;
}

function branchIsValid(value, schema, context) {
  const branchViolations = [];
  validateNode(value, schema, { ...context, depth: context.depth + 1 }, branchViolations);
  return branchViolations.length === 0;
}

function pushArray(array, value) {
  Object.defineProperty(array, String(array.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function isMemoizable(value) {
  return value !== null && typeof value === 'object';
}

function comparisonWork(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return 1;
  if (typeof value === 'string') return Math.min(MAX_VALIDATION_WORK + 1, value.length + 1);
  if (typeof value !== 'object' || applyIntrinsic(WEAK_SET_HAS, seen, [value])) return 1;
  applyIntrinsic(WEAK_SET_ADD, seen, [value]);
  const keys = Reflect.ownKeys(value);
  let total = 1 + keys.length;
  for (let index = 0; index < keys.length && total <= MAX_VALIDATION_WORK; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, keys[index]);
    if (descriptor !== undefined && Object.hasOwn(descriptor, 'value')) {
      total += comparisonWork(descriptor.value, seen);
    }
  }
  return Math.min(MAX_VALIDATION_WORK + 1, total);
}

function codePointLength(value, context) {
  useWork(context, value.length);
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = applyIntrinsic(STRING_CHAR_CODE_AT, value, [index]);
    if (first >= 0xD800 && first <= 0xDBFF && index + 1 < value.length) {
      const second = applyIntrinsic(STRING_CHAR_CODE_AT, value, [index + 1]);
      if (second >= 0xDC00 && second <= 0xDFFF) index += 1;
    }
    count += 1;
  }
  return count;
}

function useWork(context, amount = 1) {
  context.budget.work += amount;
  if (context.budget.work > MAX_VALIDATION_WORK) {
    throw new SentinelError(
      'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
      'Schema validation exceeded its global work budget',
    );
  }
}

function memoForSchema(context, schema) {
  let memo = applyIntrinsic(WEAK_MAP_GET, context.memo, [schema]);
  if (memo === undefined) {
    memo = new Map();
    applyIntrinsic(WEAK_MAP_SET, context.memo, [schema, memo]);
  }
  return memo;
}

function activeForSchema(context, schema) {
  let active = applyIntrinsic(WEAK_MAP_GET, context.active, [schema]);
  if (active === undefined) {
    active = new Set();
    applyIntrinsic(WEAK_MAP_SET, context.active, [schema, active]);
  }
  return active;
}

function validateNode(value, schema, context, violations) {
  if (context.depth > MAX_VALIDATION_DEPTH) {
    throw new SentinelError(
      'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
      'Schema validation exceeded its global depth budget',
    );
  }
  useWork(context);
  if (!isObject(schema)) {
    throw new SentinelError(
      'SCHEMA_DEFINITION_INVALID',
      'Bundled schema contains an invalid schema node',
      { keyword: 'schema' },
    );
  }

  const { rootSchema, path } = context;
  const addViolation = (keyword, violationPath = path) => {
    useWork(context);
    pushArray(violations, { path: violationPath, keyword });
  };

  let memo;
  let active;
  if (isMemoizable(value)) {
    memo = memoForSchema(context, schema);
    if (applyIntrinsic(MAP_HAS, memo, [value])) return;
    active = activeForSchema(context, schema);
    if (applyIntrinsic(SET_HAS, active, [value])) {
      throw new SentinelError(
        'SCHEMA_DEFINITION_INVALID',
        'Bundled schema contains a non-progressing recursive reference',
        { keyword: '$ref' },
      );
    }
    applyIntrinsic(SET_ADD, active, [value]);
  }
  const violationStart = violations.length;

  try {
    if (hasOwn(schema, '$ref')) {
      const referencedSchema = resolveLocalReference(rootSchema, schema.$ref);
      validateNode(
        value,
        referencedSchema,
        { ...context, depth: context.depth + 1 },
        violations,
      );
    }

    if (hasOwn(schema, 'type')) {
      const acceptedTypes = ARRAY_IS_ARRAY(schema.type) ? schema.type : [schema.type];
      useWork(context, acceptedTypes.length);
      let accepted = false;
      for (let index = 0; index < acceptedTypes.length; index += 1) {
        if (matchesType(value, acceptedTypes[index])) {
          accepted = true;
          break;
        }
      }
      if (!accepted) addViolation('type');
    }

    if (hasOwn(schema, 'const')) {
      useWork(context, comparisonWork(value) + comparisonWork(schema.const));
      if (!isDeepStrictEqual(value, schema.const)) addViolation('const');
    }

    if (ARRAY_IS_ARRAY(schema.enum)) {
      useWork(context, schema.enum.length);
      let matched = false;
      for (let index = 0; index < schema.enum.length; index += 1) {
        const candidate = schema.enum[index];
        useWork(context, comparisonWork(value) + comparisonWork(candidate));
        if (isDeepStrictEqual(value, candidate)) {
          matched = true;
          break;
        }
      }
      if (!matched) addViolation('enum');
    }

    if (ARRAY_IS_ARRAY(schema.allOf)) {
      useWork(context, schema.allOf.length);
      for (let index = 0; index < schema.allOf.length; index += 1) {
        validateNode(
          value,
          schema.allOf[index],
          { ...context, depth: context.depth + 1 },
          violations,
        );
      }
    }

    if (ARRAY_IS_ARRAY(schema.anyOf)) {
      useWork(context, schema.anyOf.length);
      let validBranch = false;
      for (let index = 0; index < schema.anyOf.length; index += 1) {
        if (branchIsValid(value, schema.anyOf[index], context)) {
          validBranch = true;
          break;
        }
      }
      if (!validBranch) addViolation('anyOf');
    }

    if (ARRAY_IS_ARRAY(schema.oneOf)) {
      useWork(context, schema.oneOf.length);
      let validBranches = 0;
      for (let index = 0; index < schema.oneOf.length; index += 1) {
        if (branchIsValid(value, schema.oneOf[index], context)) validBranches += 1;
      }
      if (validBranches !== 1) addViolation('oneOf');
    }

    if (typeof value === 'string') {
      if (NUMBER_IS_INTEGER(schema.minLength)
          && codePointLength(value, context) < schema.minLength) {
        addViolation('minLength');
      }
      if (typeof schema.pattern === 'string') {
        if (schema.pattern.length > MAX_PATTERN_LENGTH) {
          throw new SentinelError(
            'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
            'Schema pattern exceeds its validation budget',
          );
        }
        useWork(context, value.length + schema.pattern.length);
        let expression;
        try {
          expression = new PRISTINE_REGEXP.RegExp(schema.pattern, 'u');
        } catch {
          throw new SentinelError(
            'SCHEMA_DEFINITION_INVALID',
            'Bundled schema contains an invalid pattern',
            { keyword: 'pattern' },
          );
        }
        if (!applyIntrinsic(PRISTINE_REGEXP.test, expression, [value])) {
          addViolation('pattern');
        }
      }
    }

    if (typeof value === 'number' && NUMBER_IS_FINITE(value)) {
      if (typeof schema.minimum === 'number' && value < schema.minimum) {
        addViolation('minimum');
      }
      if (typeof schema.maximum === 'number' && value > schema.maximum) {
        addViolation('maximum');
      }
    }

    if (ARRAY_IS_ARRAY(value)) {
      useWork(context, value.length);
      if (NUMBER_IS_INTEGER(schema.minItems) && value.length < schema.minItems) {
        addViolation('minItems');
      }
      if (NUMBER_IS_INTEGER(schema.maxItems) && value.length > schema.maxItems) {
        addViolation('maxItems');
      }
      if (isObject(schema.items)) {
        for (let index = 0; index < value.length; index += 1) {
          validateNode(
            value[index],
            schema.items,
            { ...context, path: appendPointer(path, index), depth: context.depth + 1 },
            violations,
          );
        }
      }
    }

    if (isObject(value)) {
      if (ARRAY_IS_ARRAY(schema.required)) {
        useWork(context, schema.required.length);
        for (let index = 0; index < schema.required.length; index += 1) {
          const requiredProperty = schema.required[index];
          if (!hasOwn(value, requiredProperty)) {
            addViolation('required', appendPointer(path, requiredProperty));
          }
        }
      }

      const properties = isObject(schema.properties) ? schema.properties : Object.create(null);
      const propertySchemas = Object.entries(properties);
      useWork(context, propertySchemas.length);
      for (let index = 0; index < propertySchemas.length; index += 1) {
        const property = propertySchemas[index][0];
        const childSchema = propertySchemas[index][1];
        if (hasOwn(value, property)) {
          validateNode(
            value[property],
            childSchema,
            {
              ...context,
              path: appendPointer(path, property),
              depth: context.depth + 1,
            },
            violations,
          );
        }
      }

      const valueProperties = Object.keys(value);
      useWork(context, valueProperties.length);
      for (let index = 0; index < valueProperties.length; index += 1) {
        const property = valueProperties[index];
        if (hasOwn(properties, property)) {
          continue;
        }
        const propertyPath = appendPointer(path, property);
        if (schema.additionalProperties === false) {
          addViolation('additionalProperties', propertyPath);
        } else if (isObject(schema.additionalProperties)) {
          validateNode(
            value[property],
            schema.additionalProperties,
            { ...context, path: propertyPath, depth: context.depth + 1 },
            violations,
          );
        }
      }
    }
    if (memo !== undefined && violations.length === violationStart) {
      applyIntrinsic(MAP_SET, memo, [value, true]);
    }
  } finally {
    if (active !== undefined) applyIntrinsic(SET_DELETE, active, [value]);
  }
}

function normalizeViolations(violations) {
  applyIntrinsic(ARRAY_SORT, violations, [(left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    if (left.keyword < right.keyword) return -1;
    if (left.keyword > right.keyword) return 1;
    return 0;
  }]);

  const normalized = [];
  for (let index = 0; index < violations.length; index += 1) {
    const violation = violations[index];
    if (index === 0
        || violation.path !== violations[index - 1].path
        || violation.keyword !== violations[index - 1].keyword) {
      pushArray(normalized, violation);
    }
  }
  return normalized;
}

export function validateAgainstSchema(value, schema, options = {}) {
  const safeOptions = snapshotJson(options, {
    code: 'SCHEMA_INVALID',
    message: 'Schema validation options must be plain own-data JSON',
    maxNodes: 10,
    maxArrayLength: 10,
    maxDepth: 4,
    maxProperties: 10,
    maxStringLength: 1024,
    maxStringUnits: 1024,
    limitCode: 'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
    limitMessage: 'Schema validation exceeded its global work budget',
  });
  const optionKeys = isObject(safeOptions) ? Object.keys(safeOptions) : [];
  let optionsValid = isObject(safeOptions);
  for (let index = 0; index < optionKeys.length; index += 1) {
    if (optionKeys[index] !== 'name') optionsValid = false;
  }
  if (!optionsValid
      || (hasOwn(safeOptions, 'name') && typeof safeOptions.name !== 'string')) {
    throw new SentinelError(
      'SCHEMA_INVALID',
      'Schema validation options must contain only a string name',
    );
  }
  const name = hasOwn(safeOptions, 'name') ? safeOptions.name : 'value';
  const safeSchema = snapshotJson(schema, {
    code: 'SCHEMA_DEFINITION_INVALID',
    message: 'Bundled schema must be recursively plain own-data JSON',
    maxNodes: MAX_VALIDATION_NODES,
    maxArrayLength: MAX_VALIDATION_ARRAY_LENGTH,
    maxDepth: MAX_VALIDATION_DEPTH,
    maxProperties: MAX_VALIDATION_PROPERTIES,
    maxStringLength: MAX_VALIDATION_STRING_LENGTH,
    maxStringUnits: MAX_VALIDATION_STRING_UNITS,
    limitCode: 'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
    limitMessage: 'Schema validation exceeded its global work budget',
  });
  const safeValue = snapshotJson(value, {
    code: 'SCHEMA_INVALID',
    message: `${name} failed schema validation`,
    maxNodes: MAX_VALIDATION_NODES,
    maxArrayLength: MAX_VALIDATION_ARRAY_LENGTH,
    maxDepth: MAX_VALIDATION_DEPTH,
    maxProperties: MAX_VALIDATION_PROPERTIES,
    maxStringLength: MAX_VALIDATION_STRING_LENGTH,
    maxStringUnits: MAX_VALIDATION_STRING_UNITS,
    limitCode: 'SCHEMA_VALIDATION_LIMIT_EXCEEDED',
    limitMessage: 'Schema validation exceeded its global work budget',
  });
  const violations = [];
  validateNode(safeValue, safeSchema, {
    rootSchema: safeSchema,
    path: '',
    active: new WeakMap(),
    memo: new WeakMap(),
    budget: { work: 0 },
    comparisonCosts: new WeakMap(),
    depth: 0,
  }, violations);

  if (violations.length > 0) {
    throw new SentinelError(
      'SCHEMA_INVALID',
      `${name} failed schema validation`,
      { violations: normalizeViolations(violations) },
    );
  }
}

export async function loadBundledSchema(name) {
  const fileName = applyIntrinsic(MAP_GET, SCHEMA_FILES, [name]);
  if (!fileName) {
    throw new SentinelError(
      'SCHEMA_NOT_FOUND',
      'Requested bundled schema is not available',
      { name: 'unknown' },
    );
  }

  try {
    const contents = await readFile(
      new URL(`../../schemas/${fileName}`, import.meta.url),
      'utf8',
    );
    return JSON.parse(contents);
  } catch {
    throw new SentinelError(
      'SCHEMA_LOAD_FAILED',
      'Bundled schema could not be loaded',
      { name: fileName },
    );
  }
}
