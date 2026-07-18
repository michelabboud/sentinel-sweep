import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { SentinelError } from '../lib/errors.mjs';
import { operationId, routeId } from '../lib/identity.mjs';
import { loadBundledSchema, validateAgainstSchema } from '../lib/schema.mjs';
import { discoverOpenApi } from './openapi.mjs';
import { discoverVueRouter } from './vue-router.mjs';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function manifestError(code, message, details = {}) {
  return new SentinelError(code, message, details);
}

function semanticRecord(record) {
  const { provenance: _provenance, ...semantic } = record;
  return semantic;
}

function provenanceOrder(left, right) {
  return JSON.stringify(left.provenance).localeCompare(JSON.stringify(right.provenance));
}

function mergeRecord(map, record, kind) {
  const existing = map.get(record.id);
  if (existing === undefined) {
    map.set(record.id, record);
    return;
  }
  if (!isDeepStrictEqual(semanticRecord(existing), semanticRecord(record))) {
    throw manifestError(
      'MANIFEST_CONFLICT',
      `Conflicting ${kind} records share stable ID ${record.id}`,
      { id: record.id, kind },
    );
  }
  if (provenanceOrder(record, existing) < 0) map.set(record.id, record);
}

function configuredPaths(configured, code, label) {
  if (configured === undefined) return [];
  const paths = typeof configured === 'string' ? [configured] : configured;
  if (!Array.isArray(paths) || paths.length === 0
      || paths.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw manifestError(code, `At least one ${label} path is required`);
  }
  return [...paths].sort();
}

function discoveryPaths(config) {
  const openapi = configuredPaths(
    config?.discovery?.openapi ?? config?.openapi ?? config?.openapiPaths,
    'OPENAPI_DISCOVERY_REQUIRED',
    'OpenAPI JSON',
  );
  const vueRouter = configuredPaths(
    config?.discovery?.vueRouter ?? config?.vueRouter ?? config?.vueRouterPaths,
    'VUE_DISCOVERY_REQUIRED',
    'Vue Router source',
  );
  if (openapi.length === 0 && vueRouter.length === 0) {
    throw manifestError(
      'DISCOVERY_REQUIRED',
      'At least one OpenAPI or Vue Router discovery path is required',
    );
  }
  return { openapi, vueRouter };
}

function stableUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw manifestError('OVERRIDE_INVALID', `${label} must be an array of non-empty strings`);
  }
  return [...new Set(values)].sort();
}

function overrideConflict(id, field) {
  throw manifestError(
    'MANIFEST_CONFLICT',
    `Conflicting trusted override definitions for ${id} field ${field}`,
    { id, kind: 'override', field },
  );
}

function normalizeStringSet(value) {
  if (!Array.isArray(value)
      || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    return structuredClone(value);
  }
  return [...new Set(value)].sort();
}

function normalizeParameterExamples(examples, id) {
  if (!isObject(examples)) return structuredClone(examples);
  const normalized = new Map();
  const add = (key, value) => {
    if (normalized.has(key) && !isDeepStrictEqual(normalized.get(key), value)) {
      overrideConflict(id, 'parameterExamples');
    }
    normalized.set(key, structuredClone(value));
  };

  for (const key of Object.keys(examples).sort()) {
    if (isObject(examples[key]) && ['path', 'query', 'header', 'cookie'].includes(key)) {
      for (const name of Object.keys(examples[key]).sort()) {
        add(`${key}:${name}`, examples[key][name]);
      }
    } else {
      add(key, examples[key]);
    }
  }
  return Object.fromEntries([...normalized.entries()].sort(([left], [right]) => (
    left.localeCompare(right)
  )));
}

function normalizeOverride(override, id) {
  if (!isObject(override)) return structuredClone(override);
  const normalized = {};
  for (const key of Object.keys(override).sort()) {
    if (key === 'sideEffects' || key === 'rollback') continue;
    if (key === 'allowedRoles') {
      normalized.allowedRoles = normalizeStringSet(override.allowedRoles);
    } else if (key === 'parameterExamples') {
      normalized.parameterExamples = normalizeParameterExamples(override.parameterExamples, id);
    } else {
      normalized[key] = structuredClone(override[key]);
    }
  }

  let nestedRollback;
  let hasNestedRollback = false;
  if (hasOwn(override, 'sideEffects')) {
    const source = override.sideEffects;
    if (Array.isArray(source)) {
      normalized.sideEffects = { classes: normalizeStringSet(source) };
    } else if (isObject(source)) {
      if (hasOwn(source, 'classes')) {
        normalized.sideEffects = { classes: normalizeStringSet(source.classes) };
      }
      if (hasOwn(source, 'rollback')) {
        nestedRollback = structuredClone(source.rollback);
        hasNestedRollback = true;
      }
    } else {
      normalized.sideEffects = structuredClone(source);
    }
  }

  if (hasOwn(override, 'rollback')
      && hasNestedRollback
      && !isDeepStrictEqual(override.rollback, nestedRollback)) {
    overrideConflict(id, 'rollback');
  }
  if (hasOwn(override, 'rollback')) {
    normalized.rollback = structuredClone(override.rollback);
  } else if (hasNestedRollback) {
    normalized.rollback = nestedRollback;
  }
  return normalized;
}

function mergeParameterExamples(left, right, id) {
  const merged = { ...left };
  for (const key of Object.keys(right).sort()) {
    if (hasOwn(merged, key) && !isDeepStrictEqual(merged[key], right[key])) {
      overrideConflict(id, 'parameterExamples');
    }
    merged[key] = structuredClone(right[key]);
  }
  return Object.fromEntries(Object.keys(merged).sort().map((key) => [key, merged[key]]));
}

function mergeSideEffects(left, right, id) {
  if (!isObject(left) || !isObject(right)) {
    if (!isDeepStrictEqual(left, right)) overrideConflict(id, 'sideEffects');
    return structuredClone(left);
  }
  const merged = { ...left };
  for (const key of Object.keys(right).sort()) {
    if (hasOwn(merged, key) && !isDeepStrictEqual(merged[key], right[key])) {
      overrideConflict(id, 'sideEffects');
    }
    merged[key] = structuredClone(right[key]);
  }
  return merged;
}

function mergeOverride(target, addition, id) {
  const left = target === undefined ? {} : normalizeOverride(target, id);
  const right = normalizeOverride(addition, id);
  if (!isObject(left) || !isObject(right)) {
    if (!isDeepStrictEqual(left, right)) overrideConflict(id, 'definition');
    return left;
  }

  const merged = {};
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  for (const field of fields) {
    if (!hasOwn(left, field)) {
      merged[field] = structuredClone(right[field]);
    } else if (!hasOwn(right, field)) {
      merged[field] = structuredClone(left[field]);
    } else if (field === 'parameterExamples'
        && isObject(left[field])
        && isObject(right[field])) {
      merged[field] = mergeParameterExamples(left[field], right[field], id);
    } else if (field === 'sideEffects') {
      merged[field] = mergeSideEffects(left[field], right[field], id);
    } else if (isDeepStrictEqual(left[field], right[field])) {
      merged[field] = structuredClone(left[field]);
    } else {
      overrideConflict(id, field);
    }
  }
  return merged;
}

function collectOverrideMaps(config) {
  const operationOverrides = new Map();
  const routeOverrides = new Map();
  const unknownOverrides = new Map();
  const addEntries = (target, source) => {
    if (!isObject(source)) return;
    for (const id of Object.keys(source).sort()) {
      target.set(id, mergeOverride(target.get(id), source[id], id));
    }
  };

  const trusted = config?.trustedOverrides;
  if (isObject(trusted)) {
    if (hasOwn(trusted, 'operations') || hasOwn(trusted, 'routes')) {
      addEntries(operationOverrides, trusted.operations);
      addEntries(routeOverrides, trusted.routes);
      for (const key of Object.keys(trusted)) {
        if (key !== 'operations' && key !== 'routes') {
          unknownOverrides.set(
            key,
            mergeOverride(unknownOverrides.get(key), trusted[key], key),
          );
        }
      }
    } else {
      addEntries(unknownOverrides, trusted);
    }
  }
  addEntries(operationOverrides, config?.operationOverrides);
  addEntries(routeOverrides, config?.routeOverrides);

  for (const [id, roles] of Object.entries(config?.operationRoles ?? {}).sort()) {
    operationOverrides.set(
      id,
      mergeOverride(operationOverrides.get(id), { allowedRoles: roles }, id),
    );
  }
  for (const [id, roles] of Object.entries(config?.routeRoles ?? {}).sort()) {
    routeOverrides.set(
      id,
      mergeOverride(routeOverrides.get(id), { allowedRoles: roles }, id),
    );
  }
  return { operationOverrides, routeOverrides, unknownOverrides };
}

function setParameterExamples(parameters, examples, id) {
  if (examples === undefined) return parameters;
  if (!isObject(examples)) {
    throw manifestError('OVERRIDE_INVALID', `Parameter examples for ${id} must be an object`);
  }
  const qualifiedKeys = new Set(parameters.map(
    (parameter) => `${parameter.location}:${parameter.name}`,
  ));
  const keysByName = new Map();
  for (const parameter of parameters) {
    const keys = keysByName.get(parameter.name) ?? [];
    keys.push(`${parameter.location}:${parameter.name}`);
    keysByName.set(parameter.name, keys);
  }
  const resolved = new Map();
  for (const key of Object.keys(examples).sort()) {
    const targets = qualifiedKeys.has(key)
      ? [key]
      : keysByName.get(key) ?? [key];
    for (const target of targets) {
      if (resolved.has(target)
          && !isDeepStrictEqual(resolved.get(target), examples[key])) {
        overrideConflict(id, 'parameterExamples');
      }
      resolved.set(target, structuredClone(examples[key]));
    }
  }
  return parameters.map((parameter) => {
    const compoundKey = `${parameter.location}:${parameter.name}`;
    return resolved.has(compoundKey)
      ? { ...parameter, example: structuredClone(resolved.get(compoundKey)) }
      : parameter;
  });
}

function applyOperationOverride(operation, override) {
  if (!isObject(override)) {
    throw manifestError('OVERRIDE_INVALID', `Override for ${operation.id} must be an object`);
  }
  const allowedKeys = new Set([
    'allowedRoles',
    'parameterExamples',
    'targetModel',
    'deleteMode',
    'sideEffects',
    'rollback',
  ]);
  const unknownKey = Object.keys(override).find((key) => !allowedKeys.has(key));
  if (unknownKey !== undefined) {
    throw manifestError('OVERRIDE_INVALID', `Unsupported override field ${unknownKey}`);
  }

  const updated = structuredClone(operation);
  if (hasOwn(override, 'allowedRoles')) {
    updated.auth.allowedRoles = stableUniqueStrings(override.allowedRoles, 'allowedRoles');
    if (updated.auth.allowedRoles.length > 0) updated.auth.state = 'required';
  }
  updated.parameters = setParameterExamples(updated.parameters, override.parameterExamples, operation.id);
  if (hasOwn(override, 'targetModel')) updated.targetModel = override.targetModel;
  if (hasOwn(override, 'deleteMode')) updated.deleteMode = override.deleteMode;
  if (hasOwn(override, 'rollback')) updated.rollback = override.rollback;
  if (hasOwn(override, 'sideEffects')) {
    const sideEffects = override.sideEffects;
    const classes = Array.isArray(sideEffects) ? sideEffects : sideEffects?.classes;
    updated.sideEffects = {
      state: 'known',
      classes: stableUniqueStrings(classes, 'side-effect classes'),
    };
    if (isObject(sideEffects) && hasOwn(sideEffects, 'rollback')) {
      updated.rollback = sideEffects.rollback;
    }
  }
  return updated;
}

function applyRouteOverride(route, override) {
  if (!isObject(override)) {
    throw manifestError('OVERRIDE_INVALID', `Override for ${route.id} must be an object`);
  }
  const unknownKey = Object.keys(override).find(
    (key) => key !== 'allowedRoles' && key !== 'parameterExamples',
  );
  if (unknownKey !== undefined) {
    throw manifestError('OVERRIDE_INVALID', `Unsupported route override field ${unknownKey}`);
  }
  const updated = structuredClone(route);
  if (hasOwn(override, 'allowedRoles')) {
    updated.auth.allowedRoles = stableUniqueStrings(override.allowedRoles, 'allowedRoles');
    if (updated.auth.allowedRoles.length > 0) updated.auth.state = 'required';
  }
  updated.parameters = setParameterExamples(updated.parameters, override.parameterExamples, route.id);
  return updated;
}

function addConfiguredParameterExamples(config, operationOverrides) {
  const grouped = new Map();
  for (const example of config?.parameterExamples ?? []) {
    if (!isObject(example)
        || typeof example.operationId !== 'string'
        || typeof example.location !== 'string'
        || typeof example.name !== 'string') {
      throw manifestError('OVERRIDE_INVALID', 'Configured parameter example is invalid');
    }
    const values = grouped.get(example.operationId) ?? {};
    const key = `${example.location}:${example.name}`;
    if (hasOwn(values, key) && !isDeepStrictEqual(values[key], example.value)) {
      overrideConflict(example.operationId, 'parameterExamples');
    }
    values[key] = structuredClone(example.value);
    grouped.set(example.operationId, values);
  }
  for (const [id, parameterExamples] of grouped) {
    operationOverrides.set(
      id,
      mergeOverride(operationOverrides.get(id), { parameterExamples }, id),
    );
  }
}

function normalizeTarget(config, targetBoundary) {
  const configured = config?.target;
  if (configured !== undefined) return structuredClone(configured);
  return {
    name: path.basename(targetBoundary.root),
    root: targetBoundary.root,
  };
}

function normalizeDiagnostics(results) {
  const diagnostics = results.flatMap((result) => result.diagnostics ?? []);
  const byValue = new Map(diagnostics.map((diagnostic) => [JSON.stringify(diagnostic), diagnostic]));
  return [...byValue.values()].sort(
    (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

export async function buildManifest({ targetBoundary, config, generatedAt } = {}) {
  if (targetBoundary === null
      || typeof targetBoundary !== 'object'
      || typeof targetBoundary.readText !== 'function') {
    throw manifestError('TARGET_BOUNDARY_INVALID', 'A TargetBoundary is required');
  }
  if (!isObject(config)) {
    throw manifestError('CONFIG_INVALID', 'Trusted discovery config must be an object');
  }

  const paths = discoveryPaths(config);
  const results = [];
  for (const relativePath of paths.openapi) {
    results.push(await discoverOpenApi({ boundary: targetBoundary, relativePath }));
  }
  if (paths.vueRouter.length > 0) {
    results.push(await discoverVueRouter({
      boundary: targetBoundary,
      relativePaths: paths.vueRouter,
    }));
  }

  const operations = new Map();
  const routes = new Map();
  const schemas = new Map();
  for (const result of results) {
    for (const source of result.operations) {
      const id = operationId(source.method, source.path);
      mergeRecord(operations, { ...source, id }, 'operation');
    }
    for (const source of result.routes) {
      const id = routeId(source.path);
      mergeRecord(routes, { ...source, id }, 'route');
    }
    for (const source of result.schemas) mergeRecord(schemas, source, 'schema');
  }

  const overrideMaps = collectOverrideMaps(config);
  addConfiguredParameterExamples(config, overrideMaps.operationOverrides);
  for (const [id, override] of overrideMaps.unknownOverrides) {
    if (operations.has(id)) {
      overrideMaps.operationOverrides.set(
        id,
        mergeOverride(overrideMaps.operationOverrides.get(id), override, id),
      );
    } else if (routes.has(id)) {
      overrideMaps.routeOverrides.set(
        id,
        mergeOverride(overrideMaps.routeOverrides.get(id), override, id),
      );
    } else {
      throw manifestError('OVERRIDE_ID_UNKNOWN', `Trusted override ID ${id} was not discovered`);
    }
  }

  for (const [requestedId, override] of [...overrideMaps.operationOverrides.entries()]) {
    if (!operations.has(requestedId)) {
      throw manifestError(
        'OVERRIDE_ID_UNKNOWN',
        `Trusted operation override ID ${requestedId} was not discovered`,
      );
    }
    operations.set(
      requestedId,
      applyOperationOverride(operations.get(requestedId), override),
    );
  }
  for (const [requestedId, override] of [...overrideMaps.routeOverrides.entries()]) {
    if (!routes.has(requestedId)) {
      throw manifestError(
        'OVERRIDE_ID_UNKNOWN',
        `Trusted route override ID ${requestedId} was not discovered`,
      );
    }
    routes.set(requestedId, applyRouteOverride(routes.get(requestedId), override));
  }

  const statuses = results.map((result) => result.coverage.status);
  const manifest = {
    schemaVersion: '2.0',
    generatedAt: generatedAt ?? new Date().toISOString(),
    target: normalizeTarget(config, targetBoundary),
    coverage: {
      status: statuses.includes('unsupported')
        ? 'unsupported'
        : statuses.includes('partial') ? 'partial' : 'complete',
      diagnostics: normalizeDiagnostics(results),
    },
    routes: [...routes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    operations: [...operations.values()].sort((left, right) => left.id.localeCompare(right.id)),
    schemas: Object.fromEntries([...schemas.entries()].sort(([left], [right]) => (
      left.localeCompare(right)
    )).map(([id, record]) => [id, {
      schema: record.schema,
      provenance: record.provenance,
    }])),
  };
  const schema = await loadBundledSchema('sentinel-manifest');
  validateAgainstSchema(manifest, schema, { name: 'discovered manifest' });
  return manifest;
}
