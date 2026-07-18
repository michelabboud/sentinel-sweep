import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { SentinelError } from '../lib/errors.mjs';
import { operationId, routeId } from '../lib/identity.mjs';
import { loadBundledSchema, validateAgainstSchema } from '../lib/schema.mjs';
import { discoverOpenApi } from './openapi.mjs';

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

function discoveryPaths(config) {
  const configured = config?.discovery?.openapi ?? config?.openapi ?? config?.openapiPaths;
  const paths = typeof configured === 'string' ? [configured] : configured;
  if (!Array.isArray(paths) || paths.length === 0
      || paths.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw manifestError('OPENAPI_DISCOVERY_REQUIRED', 'At least one OpenAPI JSON path is required');
  }
  return [...paths].sort();
}

function stableUniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || value.length === 0)) {
    throw manifestError('OVERRIDE_INVALID', `${label} must be an array of non-empty strings`);
  }
  return [...new Set(values)].sort();
}

function mergeOverride(target, addition) {
  return { ...(target ?? {}), ...addition };
}

function collectOverrideMaps(config) {
  const operationOverrides = new Map();
  const routeOverrides = new Map();
  const unknownOverrides = new Map();
  const addEntries = (target, source) => {
    if (!isObject(source)) return;
    for (const id of Object.keys(source).sort()) {
      target.set(id, mergeOverride(target.get(id), source[id]));
    }
  };

  const trusted = config?.trustedOverrides;
  if (isObject(trusted)) {
    if (hasOwn(trusted, 'operations') || hasOwn(trusted, 'routes')) {
      addEntries(operationOverrides, trusted.operations);
      addEntries(routeOverrides, trusted.routes);
      for (const key of Object.keys(trusted)) {
        if (key !== 'operations' && key !== 'routes') {
          unknownOverrides.set(key, trusted[key]);
        }
      }
    } else {
      addEntries(unknownOverrides, trusted);
    }
  }
  addEntries(operationOverrides, config?.operationOverrides);
  addEntries(routeOverrides, config?.routeOverrides);

  for (const [id, roles] of Object.entries(config?.operationRoles ?? {}).sort()) {
    operationOverrides.set(id, mergeOverride(operationOverrides.get(id), { allowedRoles: roles }));
  }
  for (const [id, roles] of Object.entries(config?.routeRoles ?? {}).sort()) {
    routeOverrides.set(id, mergeOverride(routeOverrides.get(id), { allowedRoles: roles }));
  }
  return { operationOverrides, routeOverrides, unknownOverrides };
}

function resolveOverrideId(id, records, aliases) {
  if (records.has(id)) return id;
  return aliases.get(id);
}

function setParameterExamples(parameters, examples, id) {
  if (examples === undefined) return parameters;
  if (!isObject(examples)) {
    throw manifestError('OVERRIDE_INVALID', `Parameter examples for ${id} must be an object`);
  }
  return parameters.map((parameter) => {
    const locationValues = isObject(examples[parameter.location])
      ? examples[parameter.location]
      : {};
    const compoundKey = `${parameter.location}:${parameter.name}`;
    let value;
    let found = false;
    if (hasOwn(examples, compoundKey)) {
      value = examples[compoundKey];
      found = true;
    } else if (hasOwn(locationValues, parameter.name)) {
      value = locationValues[parameter.name];
      found = true;
    } else if (hasOwn(examples, parameter.name)) {
      value = examples[parameter.name];
      found = true;
    }
    return found ? { ...parameter, example: structuredClone(value) } : parameter;
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
    values[`${example.location}:${example.name}`] = example.value;
    grouped.set(example.operationId, values);
  }
  for (const [id, parameterExamples] of grouped) {
    operationOverrides.set(
      id,
      mergeOverride(operationOverrides.get(id), { parameterExamples }),
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

  const results = [];
  for (const relativePath of discoveryPaths(config)) {
    results.push(await discoverOpenApi({ boundary: targetBoundary, relativePath }));
  }

  const operations = new Map();
  const routes = new Map();
  const schemas = new Map();
  const operationAliases = new Map();
  const routeAliases = new Map();
  for (const result of results) {
    for (const source of result.operations) {
      const id = operationId(source.method, source.path);
      operationAliases.set(source.id, id);
      mergeRecord(operations, { ...source, id }, 'operation');
    }
    for (const source of result.routes) {
      const id = routeId(source.path);
      routeAliases.set(source.id, id);
      mergeRecord(routes, { ...source, id }, 'route');
    }
    for (const source of result.schemas) mergeRecord(schemas, source, 'schema');
  }

  const overrideMaps = collectOverrideMaps(config);
  addConfiguredParameterExamples(config, overrideMaps.operationOverrides);
  for (const [id, override] of overrideMaps.unknownOverrides) {
    const operationKey = resolveOverrideId(id, operations, operationAliases);
    const routeKey = resolveOverrideId(id, routes, routeAliases);
    if (operationKey !== undefined) {
      overrideMaps.operationOverrides.set(
        operationKey,
        mergeOverride(overrideMaps.operationOverrides.get(operationKey), override),
      );
    } else if (routeKey !== undefined) {
      overrideMaps.routeOverrides.set(
        routeKey,
        mergeOverride(overrideMaps.routeOverrides.get(routeKey), override),
      );
    } else {
      throw manifestError('OVERRIDE_ID_UNKNOWN', `Trusted override ID ${id} was not discovered`);
    }
  }

  for (const [requestedId, override] of [...overrideMaps.operationOverrides.entries()]) {
    const id = resolveOverrideId(requestedId, operations, operationAliases);
    if (id === undefined) {
      throw manifestError(
        'OVERRIDE_ID_UNKNOWN',
        `Trusted operation override ID ${requestedId} was not discovered`,
      );
    }
    operations.set(id, applyOperationOverride(operations.get(id), override));
  }
  for (const [requestedId, override] of [...overrideMaps.routeOverrides.entries()]) {
    const id = resolveOverrideId(requestedId, routes, routeAliases);
    if (id === undefined) {
      throw manifestError(
        'OVERRIDE_ID_UNKNOWN',
        `Trusted route override ID ${requestedId} was not discovered`,
      );
    }
    routes.set(id, applyRouteOverride(routes.get(id), override));
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
