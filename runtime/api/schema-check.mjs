import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { createContext, Script } from 'node:vm';

const MAX_PATTERN_CODE_UNITS = 512;
const MAX_PATTERN_VALUE_CODE_UNITS = 1024 * 1024;
const MAX_PATTERN_EVALUATIONS = 256;
const MAX_PATTERN_TOTAL_MS = 250;
const MAX_PATTERN_EXECUTION_MS = 20;
const MAX_PATTERN_GROUP_DEPTH = 32;
const MAX_PATTERN_QUANTIFIERS = 128;
const MAX_PATTERN_REPEAT = 10_000;
const PATTERN_TEST_SCRIPT = new Script(
  'new RegExp(pattern, "u").test(value)',
  { filename: 'sentinel-schema-pattern.vm' },
);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAsciiDigit(character) {
  return character >= '0' && character <= '9';
}

function braceQuantifier(pattern, start) {
  let index = start + 1;
  if (!isAsciiDigit(pattern[index])) return null;

  let minimum = 0;
  while (isAsciiDigit(pattern[index])) {
    minimum = (minimum * 10) + (pattern.charCodeAt(index) - 48);
    if (minimum > MAX_PATTERN_REPEAT) return { safe: false, end: index };
    index += 1;
  }

  let maximum = minimum;
  if (pattern[index] === ',') {
    index += 1;
    if (pattern[index] === '}') {
      maximum = null;
    } else {
      if (!isAsciiDigit(pattern[index])) return null;
      maximum = 0;
      while (isAsciiDigit(pattern[index])) {
        maximum = (maximum * 10) + (pattern.charCodeAt(index) - 48);
        if (maximum > MAX_PATTERN_REPEAT) return { safe: false, end: index };
        index += 1;
      }
    }
  }

  if (pattern[index] !== '}') return null;
  if (maximum !== null && maximum < minimum) return { safe: false, end: index };
  return { safe: true, end: index };
}

/*
 * Reject constructs whose worst-case behavior is difficult to prove locally.
 * The isolated VM timeout below remains the authoritative execution bound: this
 * structural pass deliberately catches common ReDoS shapes before execution.
 */
function patternIsConservativelySafe(pattern) {
  if (pattern.length > MAX_PATTERN_CODE_UNITS) return false;

  const groups = [{
    hasAlternation: false,
    hasComplexAtom: false,
    hasQuantifier: false,
  }];
  let inCharacterClass = false;
  let lastAtom = null;
  let quantifiers = 0;

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === '\\') {
      const escaped = pattern[index + 1];
      if (escaped === undefined) break;
      if (!inCharacterClass
          && ((escaped >= '1' && escaped <= '9')
            || (escaped === 'k' && pattern[index + 2] === '<'))) {
        return false;
      }
      index += 1;
      if (!inCharacterClass) lastAtom = { complex: false, quantified: false };
      continue;
    }

    if (inCharacterClass) {
      if (character === ']') {
        inCharacterClass = false;
        lastAtom = { complex: false, quantified: false };
      }
      continue;
    }

    if (character === '[') {
      inCharacterClass = true;
      lastAtom = null;
      continue;
    }

    if (character === '(') {
      if (pattern[index + 1] === '?' && pattern[index + 2] === '<') {
        if (pattern[index + 3] === '=' || pattern[index + 3] === '!') return false;
        const nameEnd = pattern.indexOf('>', index + 3);
        if (nameEnd === -1) break;
        index = nameEnd;
      } else if (pattern[index + 1] === '?'
          && (pattern[index + 2] === ':'
            || pattern[index + 2] === '='
            || pattern[index + 2] === '!')) {
        index += 2;
      }
      if (groups.length >= MAX_PATTERN_GROUP_DEPTH) return false;
      groups.push({
        hasAlternation: false,
        hasComplexAtom: false,
        hasQuantifier: false,
      });
      lastAtom = null;
      continue;
    }

    if (character === ')') {
      if (groups.length === 1) break;
      const group = groups.pop();
      const complex = group.hasAlternation || group.hasComplexAtom || group.hasQuantifier;
      groups[groups.length - 1].hasComplexAtom ||= complex;
      lastAtom = { complex, quantified: false };
      continue;
    }

    if (character === '|') {
      groups[groups.length - 1].hasAlternation = true;
      lastAtom = null;
      continue;
    }

    let quantifierEnd = index;
    let isQuantifier = character === '*' || character === '+' || character === '?';
    if (character === '{' && lastAtom !== null) {
      const quantifier = braceQuantifier(pattern, index);
      if (quantifier !== null) {
        if (!quantifier.safe) return false;
        isQuantifier = true;
        quantifierEnd = quantifier.end;
      }
    }

    if (isQuantifier) {
      if (lastAtom === null) break;
      if (lastAtom.quantified) {
        if (character === '?') continue;
        return false;
      }
      if (lastAtom.complex) return false;
      quantifiers += 1;
      if (quantifiers > MAX_PATTERN_QUANTIFIERS) return false;
      groups[groups.length - 1].hasQuantifier = true;
      lastAtom.quantified = true;
      index = quantifierEnd;
      continue;
    }

    if (character === '^' || character === '$') {
      lastAtom = null;
      continue;
    }
    lastAtom = { complex: false, quantified: false };
  }

  return true;
}

function createPatternBudget() {
  return {
    context: null,
    evaluations: 0,
    startedAt: performance.now(),
  };
}

function isolatedPatternMatches(pattern, value, budget) {
  budget.evaluations += 1;
  if (budget.evaluations > MAX_PATTERN_EVALUATIONS
      || value.length > MAX_PATTERN_VALUE_CODE_UNITS
      || !patternIsConservativelySafe(pattern)
      || performance.now() - budget.startedAt >= MAX_PATTERN_TOTAL_MS) {
    return false;
  }

  try {
    if (budget.context === null) {
      const sandbox = Object.create(null);
      sandbox.pattern = '';
      sandbox.value = '';
      budget.context = createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
        name: 'sentinel-schema-pattern',
      });
    }
    budget.context.pattern = pattern;
    budget.context.value = value;

    const remainingMs = MAX_PATTERN_TOTAL_MS - (performance.now() - budget.startedAt);
    if (remainingMs <= 0) return false;
    const timeout = Math.max(1, Math.min(MAX_PATTERN_EXECUTION_MS, Math.ceil(remainingMs)));
    return PATTERN_TEST_SCRIPT.runInContext(budget.context, { timeout }) === true;
  } catch {
    budget.context = null;
    return false;
  }
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
  const {
    path,
    rootSchema,
    registry,
    depth,
    patternBudget,
  } = context;
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
    patternBudget,
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
      if (!isolatedPatternMatches(schema.pattern, value, patternBudget)) add('pattern');
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
    patternBudget: createPatternBudget(),
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
