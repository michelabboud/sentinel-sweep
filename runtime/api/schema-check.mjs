import { isDeepStrictEqual } from 'node:util';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function matchesType(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'boolean': return typeof value === 'boolean';
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return Number.isInteger(value);
    case 'string': return typeof value === 'string';
    default: return false;
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

function registryValue(registry, reference) {
  const record = registry instanceof Map ? registry.get(reference) : registry?.[reference];
  return isObject(record?.schema) ? record.schema : record;
}

function localReference(rootSchema, reference) {
  if (reference === '#') return rootSchema;
  if (typeof reference !== 'string' || !reference.startsWith('#/')) return null;

  let current = rootSchema;
  for (const encoded of reference.slice(2).split('/')) {
    const segment = decodePointerSegment(encoded);
    if (!isObject(current) || !hasOwn(current, segment)) return null;
    current = current[segment];
  }
  return current;
}

function resolvedReference(rootSchema, registry, reference) {
  const local = localReference(rootSchema, reference);
  if (isObject(local)) return { schema: local, rootSchema };
  const registered = registryValue(registry, reference);
  return isObject(registered) ? { schema: registered, rootSchema: registered } : null;
}

function branchIsValid(value, schema, context) {
  const violations = [];
  validateNode(value, schema, context, violations);
  return violations.length === 0;
}

function validateNode(value, schema, context, violations) {
  const { path, rootSchema, registry, depth } = context;
  const add = (keyword, violationPath = path) => violations.push({ path: violationPath, keyword });

  if (!isObject(schema) || depth > 128) {
    add('$ref');
    return;
  }

  const childContext = (childPath = path, childRoot = rootSchema) => ({
    path: childPath,
    rootSchema: childRoot,
    registry,
    depth: depth + 1,
  });

  if (hasOwn(schema, '$ref')) {
    const referenced = resolvedReference(rootSchema, registry, schema.$ref);
    if (referenced === null) {
      add('$ref');
    } else {
      validateNode(
        value,
        referenced.schema,
        childContext(path, referenced.rootSchema),
        violations,
      );
    }
  }

  if (hasOwn(schema, 'type')) {
    const accepted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!accepted.some((type) => matchesType(value, type))) add('type');
  }

  if (hasOwn(schema, 'const') && !isDeepStrictEqual(value, schema.const)) add('const');
  if (Array.isArray(schema.enum)
      && !schema.enum.some((candidate) => isDeepStrictEqual(value, candidate))) {
    add('enum');
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      validateNode(value, branch, childContext(), violations);
    }
  }
  if (Array.isArray(schema.anyOf)
      && !schema.anyOf.some((branch) => branchIsValid(value, branch, childContext()))) {
    add('anyOf');
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.reduce(
      (count, branch) => count + Number(branchIsValid(value, branch, childContext())),
      0,
    );
    if (matches !== 1) add('oneOf');
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && [...value].length < schema.minLength) {
      add('minLength');
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) add('pattern');
      } catch {
        add('pattern');
      }
    }
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) add('minimum');
    if (typeof schema.maximum === 'number' && value > schema.maximum) add('maximum');
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) add('minItems');
    if (isObject(schema.items)) {
      value.forEach((entry, index) => {
        validateNode(entry, schema.items, childContext(appendPointer(path, index)), violations);
      });
    }
  }

  if (isObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const property of schema.required) {
        if (!hasOwn(value, property)) add('required', appendPointer(path, property));
      }
    }

    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const [property, childSchema] of Object.entries(properties)) {
      if (hasOwn(value, property)) {
        validateNode(
          value[property],
          childSchema,
          childContext(appendPointer(path, property)),
          violations,
        );
      }
    }

    for (const property of Object.keys(value)) {
      if (hasOwn(properties, property)) continue;
      const propertyPath = appendPointer(path, property);
      if (schema.additionalProperties === false) {
        add('additionalProperties', propertyPath);
      } else if (isObject(schema.additionalProperties)) {
        validateNode(
          value[property],
          schema.additionalProperties,
          childContext(propertyPath),
          violations,
        );
      }
    }
  }
}

/** Returns stable JSON-pointer violations for Sentinel's discovered schema subset. */
export function checkJsonSchema(value, schema, registry = {}) {
  const violations = [];
  validateNode(value, schema, {
    path: '',
    rootSchema: schema,
    registry,
    depth: 0,
  }, violations);

  violations.sort((left, right) => (
    left.path.localeCompare(right.path) || left.keyword.localeCompare(right.keyword)
  ));
  return violations.filter((violation, index) => (
    index === 0
    || violation.path !== violations[index - 1].path
    || violation.keyword !== violations[index - 1].keyword
  ));
}
