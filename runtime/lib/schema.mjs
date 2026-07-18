import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

import { SentinelError } from './errors.mjs';

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

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
      return Array.isArray(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'string':
      return typeof value === 'string';
    default:
      return false;
  }
}

function escapePointerSegment(segment) {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}

function appendPointer(pointer, segment) {
  return `${pointer}/${escapePointerSegment(segment)}`;
}

function decodePointerSegment(segment) {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolveLocalReference(rootSchema, reference) {
  if (reference === '#') {
    return rootSchema;
  }
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    throw new SentinelError(
      'SCHEMA_DEFINITION_INVALID',
      'Bundled schema contains an unsupported reference',
      { keyword: '$ref' },
    );
  }

  let current = rootSchema;
  for (const encodedSegment of reference.slice(2).split('/')) {
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
  validateNode(value, schema, context, branchViolations);
  return branchViolations.length === 0;
}

function validateNode(value, schema, context, violations) {
  if (!isObject(schema)) {
    throw new SentinelError(
      'SCHEMA_DEFINITION_INVALID',
      'Bundled schema contains an invalid schema node',
      { keyword: 'schema' },
    );
  }

  const { rootSchema, path } = context;
  const addViolation = (keyword, violationPath = path) => {
    violations.push({ path: violationPath, keyword });
  };

  if (hasOwn(schema, '$ref')) {
    const referencedSchema = resolveLocalReference(rootSchema, schema.$ref);
    validateNode(value, referencedSchema, context, violations);
  }

  if (hasOwn(schema, 'type')) {
    const acceptedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!acceptedTypes.some((type) => matchesType(value, type))) {
      addViolation('type');
    }
  }

  if (hasOwn(schema, 'const') && !isDeepStrictEqual(value, schema.const)) {
    addViolation('const');
  }

  if (Array.isArray(schema.enum)
      && !schema.enum.some((candidate) => isDeepStrictEqual(value, candidate))) {
    addViolation('enum');
  }

  if (Array.isArray(schema.allOf)) {
    for (const childSchema of schema.allOf) {
      validateNode(value, childSchema, context, violations);
    }
  }

  if (Array.isArray(schema.anyOf)
      && !schema.anyOf.some((childSchema) => branchIsValid(value, childSchema, context))) {
    addViolation('anyOf');
  }

  if (Array.isArray(schema.oneOf)) {
    const validBranches = schema.oneOf.reduce(
      (count, childSchema) => count + Number(branchIsValid(value, childSchema, context)),
      0,
    );
    if (validBranches !== 1) {
      addViolation('oneOf');
    }
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength)
        && [...value].length < schema.minLength) {
      addViolation('minLength');
    }
    if (typeof schema.pattern === 'string') {
      let expression;
      try {
        expression = new RegExp(schema.pattern, 'u');
      } catch {
        throw new SentinelError(
          'SCHEMA_DEFINITION_INVALID',
          'Bundled schema contains an invalid pattern',
          { keyword: 'pattern' },
        );
      }
      if (!expression.test(value)) {
        addViolation('pattern');
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      addViolation('minimum');
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      addViolation('maximum');
    }
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      addViolation('minItems');
    }
    if (isObject(schema.items)) {
      value.forEach((item, index) => {
        validateNode(
          item,
          schema.items,
          { rootSchema, path: appendPointer(path, index) },
          violations,
        );
      });
    }
  }

  if (isObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const requiredProperty of schema.required) {
        if (!hasOwn(value, requiredProperty)) {
          addViolation('required', appendPointer(path, requiredProperty));
        }
      }
    }

    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [property, childSchema] of Object.entries(properties)) {
      if (hasOwn(value, property)) {
        validateNode(
          value[property],
          childSchema,
          { rootSchema, path: appendPointer(path, property) },
          violations,
        );
      }
    }

    for (const property of Object.keys(value)) {
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
          { rootSchema, path: propertyPath },
          violations,
        );
      }
    }
  }
}

function normalizeViolations(violations) {
  violations.sort((left, right) => (
    left.path.localeCompare(right.path) || left.keyword.localeCompare(right.keyword)
  ));

  return violations.filter((violation, index) => (
    index === 0
    || violation.path !== violations[index - 1].path
    || violation.keyword !== violations[index - 1].keyword
  ));
}

export function validateAgainstSchema(value, schema, { name = 'value' } = {}) {
  const violations = [];
  validateNode(value, schema, { rootSchema: schema, path: '' }, violations);

  if (violations.length > 0) {
    throw new SentinelError(
      'SCHEMA_INVALID',
      `${name} failed schema validation`,
      { violations: normalizeViolations(violations) },
    );
  }
}

export async function loadBundledSchema(name) {
  const fileName = SCHEMA_FILES.get(name);
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
