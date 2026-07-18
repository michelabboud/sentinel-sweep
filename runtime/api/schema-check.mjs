import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

const MAX_PATTERN_CODE_UNITS = 512;
const MAX_PATTERN_VALUE_CODE_UNITS = 1024 * 1024;
const MAX_PATTERN_EVALUATIONS = 256;
const MAX_PATTERN_EXECUTION_MS = 20;
const MAX_PATTERN_BATCH_CODE_UNITS = 4 * 1024 * 1024;
const MAX_PATTERN_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_PATTERN_BATCH_OUTPUT_BYTES = 64 * 1024;
const MAX_PATTERN_BATCH_PROCESS_MS = 1000;
const MAX_SCHEMA_NODES = 4096;
const MAX_SCHEMA_WORK = 16_384;
const PATTERN_MATCH = 1;
const PATTERN_NO_MATCH = 2;
const PATTERN_FATAL = 3;
// One child per check gives target regexes pristine intrinsics and an interruptible CPU boundary.
const PATTERN_CHILD_SOURCE = `
  'use strict';
  const { readFileSync } = require('node:fs');
  const { runInNewContext } = require('node:vm');
  const reply = (payload) => process.stdout.write(JSON.stringify(payload));
  try {
    const tasks = JSON.parse(readFileSync(0, 'utf8'));
    if (!Array.isArray(tasks) || tasks.length > ${MAX_PATTERN_EVALUATIONS}) {
      reply({ fatalIndex: -1 });
    } else {
      const outcomes = [];
      let fatalIndex = -1;
      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index];
        if (task === null || typeof task !== 'object' || Array.isArray(task)
            || typeof task.pattern !== 'string' || typeof task.value !== 'string') {
          fatalIndex = index;
          break;
        }
        try {
          outcomes[index] = runInNewContext(
            'new RegExp(pattern, "u").test(value)',
            { pattern: task.pattern, value: task.value },
            {
              codeGeneration: { strings: false, wasm: false },
              timeout: ${MAX_PATTERN_EXECUTION_MS},
            },
          ) === true;
        } catch {
          fatalIndex = index;
          break;
        }
      }
      reply(fatalIndex === -1 ? { outcomes } : { fatalIndex });
    }
  } catch {
    reply({ fatalIndex: -1 });
  }
`;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function createRunState(patternMode, patternOutcomes = []) {
  return {
    active: [],
    fatal: null,
    nodes: 0,
    patternCodeUnits: 0,
    patternIndex: 0,
    patternMode,
    patternOutcomes,
    patternTasks: [],
    work: 0,
  };
}

function collectOrReadPattern(runState, pattern, value, path) {
  if (runState.patternMode === 'collect') {
    const nextCodeUnits = runState.patternCodeUnits + pattern.length + value.length;
    if (runState.patternTasks.length >= MAX_PATTERN_EVALUATIONS
        || pattern.length > MAX_PATTERN_CODE_UNITS
        || value.length > MAX_PATTERN_VALUE_CODE_UNITS
        || nextCodeUnits > MAX_PATTERN_BATCH_CODE_UNITS) {
      markFatal(runState, path, 'pattern');
      return PATTERN_FATAL;
    }
    runState.patternCodeUnits = nextCodeUnits;
    runState.patternTasks[runState.patternTasks.length] = { path, pattern, value };
    return PATTERN_MATCH;
  }

  const outcome = runState.patternOutcomes[runState.patternIndex];
  runState.patternIndex += 1;
  if (typeof outcome !== 'boolean') {
    markFatal(runState, path, 'pattern');
    return PATTERN_FATAL;
  }
  return outcome ? PATTERN_MATCH : PATTERN_NO_MATCH;
}

function evaluatePatternBatch(tasks) {
  if (tasks.length === 0) return { fatalPath: null, outcomes: [] };

  const childTasks = [];
  for (let index = 0; index < tasks.length; index += 1) {
    childTasks[index] = { pattern: tasks[index].pattern, value: tasks[index].value };
  }
  let input;
  try {
    input = JSON.stringify(childTasks);
  } catch {
    return { fatalPath: '', outcomes: [] };
  }
  if (Buffer.byteLength(input, 'utf8') > MAX_PATTERN_BATCH_BYTES) {
    return { fatalPath: '', outcomes: [] };
  }

  const child = spawnSync(
    process.execPath,
    ['--input-type=commonjs', '--eval', PATTERN_CHILD_SOURCE],
    {
      encoding: 'utf8',
      input,
      maxBuffer: MAX_PATTERN_BATCH_OUTPUT_BYTES,
      timeout: MAX_PATTERN_BATCH_PROCESS_MS,
      windowsHide: true,
    },
  );
  if (child.error !== undefined || child.status !== 0 || child.signal !== null) {
    return { fatalPath: '', outcomes: [] };
  }

  let result;
  try {
    result = JSON.parse(child.stdout);
  } catch {
    return { fatalPath: '', outcomes: [] };
  }
  if (Number.isInteger(result?.fatalIndex)) {
    const { fatalIndex } = result;
    return {
      fatalPath: fatalIndex >= 0 && fatalIndex < tasks.length ? tasks[fatalIndex].path : '',
      outcomes: [],
    };
  }
  if (!Array.isArray(result?.outcomes) || result.outcomes.length !== tasks.length) {
    return { fatalPath: '', outcomes: [] };
  }
  for (let index = 0; index < result.outcomes.length; index += 1) {
    if (typeof result.outcomes[index] !== 'boolean') {
      return { fatalPath: '', outcomes: [] };
    }
  }
  return { fatalPath: null, outcomes: result.outcomes };
}

function markFatal(runState, path, keyword) {
  if (runState.fatal === null) runState.fatal = { path, keyword };
}

function consumeWork(runState, amount = 1) {
  if (runState.fatal !== null) return false;
  runState.work += amount;
  if (runState.work > MAX_SCHEMA_WORK) {
    markFatal(runState, '', '$ref');
    return false;
  }
  return true;
}

function consumeNode(runState) {
  if (!consumeWork(runState)) return false;
  runState.nodes += 1;
  if (runState.nodes > MAX_SCHEMA_NODES) {
    markFatal(runState, '', '$ref');
    return false;
  }
  return true;
}

function sameValue(left, right) {
  return left === right || (left !== left && right !== right);
}

function activePairExists(active, schema, value) {
  for (let index = 0; index < active.length; index += 1) {
    const entry = active[index];
    if (entry.schema === schema && sameValue(entry.value, value)) return true;
  }
  return false;
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
  return context.runState.fatal === null && violations.length === 0;
}

function validateNode(value, schema, context, violations) {
  const {
    path,
    rootSchema,
    registry,
    depth,
    runState,
  } = context;

  if (runState.fatal !== null || !consumeNode(runState)) return;
  if (!isObject(schema) || depth > 128) {
    markFatal(runState, path, '$ref');
    return;
  }
  if (activePairExists(runState.active, schema, value)) {
    markFatal(runState, path, '$ref');
    return;
  }

  const activeLength = runState.active.length;
  runState.active[activeLength] = { schema, value };
  const add = (keyword, violationPath = path) => {
    if (!consumeWork(runState)) return;
    violations[violations.length] = { path: violationPath, keyword };
  };

  const childContext = (childPath = path, childRoot = rootSchema) => ({
    path: childPath,
    rootSchema: childRoot,
    registry,
    depth: depth + 1,
    runState,
  });

  try {
    if (hasOwn(schema, '$ref')) {
      const referenced = resolvedReference(rootSchema, registry, schema.$ref);
      if (referenced === null) {
        markFatal(runState, path, '$ref');
        return;
      }
      validateNode(
        value,
        referenced.schema,
        childContext(path, referenced.rootSchema),
        violations,
      );
      if (runState.fatal !== null) return;
    }

    if (hasOwn(schema, 'type')) {
      let accepted = false;
      if (Array.isArray(schema.type)) {
        for (let index = 0; index < schema.type.length; index += 1) {
          if (!consumeWork(runState)) return;
          accepted ||= matchesType(value, schema.type[index]);
        }
      } else {
        accepted = matchesType(value, schema.type);
      }
      if (!accepted) add('type');
      if (runState.fatal !== null) return;
    }

    if (hasOwn(schema, 'const') && !isDeepStrictEqual(value, schema.const)) add('const');
    if (runState.fatal !== null) return;
    if (Array.isArray(schema.enum)) {
      let matched = false;
      for (let index = 0; index < schema.enum.length && !matched; index += 1) {
        if (!consumeWork(runState)) return;
        matched = isDeepStrictEqual(value, schema.enum[index]);
      }
      if (!matched) add('enum');
      if (runState.fatal !== null) return;
    }

    if (Array.isArray(schema.allOf)) {
      for (let index = 0; index < schema.allOf.length; index += 1) {
        if (!consumeWork(runState)) return;
        validateNode(value, schema.allOf[index], childContext(), violations);
        if (runState.fatal !== null) return;
      }
    }
    if (Array.isArray(schema.anyOf)) {
      let matches = 0;
      for (let index = 0; index < schema.anyOf.length; index += 1) {
        if (!consumeWork(runState)) return;
        if (branchIsValid(value, schema.anyOf[index], childContext())) matches += 1;
        if (runState.fatal !== null) return;
      }
      if (matches === 0) add('anyOf');
      if (runState.fatal !== null) return;
    }
    if (Array.isArray(schema.oneOf)) {
      let matches = 0;
      for (let index = 0; index < schema.oneOf.length; index += 1) {
        if (!consumeWork(runState)) return;
        if (branchIsValid(value, schema.oneOf[index], childContext())) matches += 1;
        if (runState.fatal !== null) return;
      }
      if (matches !== 1) add('oneOf');
      if (runState.fatal !== null) return;
    }

    if (typeof value === 'string') {
      if (Number.isInteger(schema.minLength) && [...value].length < schema.minLength) {
        add('minLength');
      }
      if (runState.fatal !== null) return;
      if (typeof schema.pattern === 'string') {
        const outcome = collectOrReadPattern(
          runState,
          schema.pattern,
          value,
          path,
        );
        if (outcome === PATTERN_FATAL) {
          markFatal(runState, path, 'pattern');
          return;
        }
        if (outcome === PATTERN_NO_MATCH) add('pattern');
        if (runState.fatal !== null) return;
      }
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      if (typeof schema.minimum === 'number' && value < schema.minimum) add('minimum');
      if (runState.fatal !== null) return;
      if (typeof schema.maximum === 'number' && value > schema.maximum) add('maximum');
      if (runState.fatal !== null) return;
    }

    if (Array.isArray(value)) {
      if (Number.isInteger(schema.minItems) && value.length < schema.minItems) add('minItems');
      if (runState.fatal !== null) return;
      if (isObject(schema.items)) {
        for (let index = 0; index < value.length; index += 1) {
          if (!consumeWork(runState)) return;
          validateNode(
            value[index],
            schema.items,
            childContext(appendPointer(path, index)),
            violations,
          );
          if (runState.fatal !== null) return;
        }
      }
    }

    if (isObject(value)) {
      if (Array.isArray(schema.required)) {
        for (let index = 0; index < schema.required.length; index += 1) {
          if (!consumeWork(runState)) return;
          const property = schema.required[index];
          if (!hasOwn(value, property)) add('required', appendPointer(path, property));
          if (runState.fatal !== null) return;
        }
      }

      const properties = isObject(schema.properties) ? schema.properties : {};
      const propertyNames = Object.keys(properties);
      for (let index = 0; index < propertyNames.length; index += 1) {
        if (!consumeWork(runState)) return;
        const property = propertyNames[index];
        if (hasOwn(value, property)) {
          validateNode(
            value[property],
            properties[property],
            childContext(appendPointer(path, property)),
            violations,
          );
          if (runState.fatal !== null) return;
        }
      }

      const valueProperties = Object.keys(value);
      for (let index = 0; index < valueProperties.length; index += 1) {
        if (!consumeWork(runState)) return;
        const property = valueProperties[index];
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
        if (runState.fatal !== null) return;
      }
    }
  } finally {
    runState.active.length = activeLength;
  }
}

/** Returns stable JSON-pointer violations for Sentinel's discovered schema subset. */
export function checkJsonSchema(value, schema, registry = {}) {
  const preflightState = createRunState('collect');
  validateNode(value, schema, {
    path: '',
    rootSchema: schema,
    registry,
    depth: 0,
    runState: preflightState,
  }, []);
  if (preflightState.fatal !== null) return [preflightState.fatal];

  const patternBatch = evaluatePatternBatch(preflightState.patternTasks);
  if (patternBatch.fatalPath !== null) {
    return [{ path: patternBatch.fatalPath, keyword: 'pattern' }];
  }

  const violations = [];
  const runState = createRunState('read', patternBatch.outcomes);
  validateNode(value, schema, {
    path: '',
    rootSchema: schema,
    registry,
    depth: 0,
    runState,
  }, violations);
  if (runState.fatal === null && runState.patternIndex !== patternBatch.outcomes.length) {
    markFatal(runState, '', 'pattern');
  }
  if (runState.fatal !== null) violations[violations.length] = runState.fatal;

  violations.sort((left, right) => (
    left.path.localeCompare(right.path) || left.keyword.localeCompare(right.keyword)
  ));
  return violations.filter((violation, index) => (
    index === 0
    || violation.path !== violations[index - 1].path
    || violation.keyword !== violations[index - 1].keyword
  ));
}
