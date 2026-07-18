import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { SentinelError } from '../lib/errors.mjs';
import { validateTrustedConfig } from '../lib/config.mjs';
import { operationId, routeId } from '../lib/identity.mjs';
import { loadBundledSchema, validateAgainstSchema } from '../lib/schema.mjs';
import { discoverOpenApi } from './openapi.mjs';
import { discoverVueRouter } from './vue-router.mjs';

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function ownValue(value, key) {
  return isObject(value) && hasOwn(value, key) ? value[key] : undefined;
}

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
  const discovery = ownValue(config, 'discovery');
  const openapi = [...(ownValue(discovery, 'openapi') ?? [])].sort();
  const vueRouter = [...(ownValue(discovery, 'vueRouter') ?? [])].sort();
  if (openapi.length === 0 && vueRouter.length === 0) {
    throw manifestError(
      'DISCOVERY_REQUIRED',
      'At least one OpenAPI or Vue Router discovery path is required',
    );
  }
  return { openapi, vueRouter };
}

function stableUniqueStrings(values, label) {
  if (!Array.isArray(values)
      || values.some((value) => typeof value !== 'string' || value.length === 0)) {
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

function invalidExamples(id, message) {
  throw manifestError(
    'OVERRIDE_INVALID',
    message,
    { id, kind: 'override', field: 'parameterExamples' },
  );
}

function exampleValues(examples, id) {
  if (examples === undefined) return new Map();
  if (!Array.isArray(examples)) {
    invalidExamples(id, `Parameter examples for ${id} must be qualified records`);
  }
  const values = new Map();
  for (const example of examples) {
    if (!isObject(example)
        || typeof ownValue(example, 'location') !== 'string'
        || typeof ownValue(example, 'name') !== 'string'
        || !hasOwn(example, 'value')) {
      invalidExamples(id, `Parameter examples for ${id} must be qualified records`);
    }
    const key = `${ownValue(example, 'location')}:${ownValue(example, 'name')}`;
    const exampleValue = ownValue(example, 'value');
    if (values.has(key)) {
      if (!isDeepStrictEqual(values.get(key), exampleValue)) {
        overrideConflict(id, 'parameterExamples');
      }
      invalidExamples(id, `Parameter examples for ${id} contain duplicate ${key}`);
    }
    values.set(key, structuredClone(exampleValue));
  }
  return values;
}

function setParameterExamples(parameters, examples, id) {
  if (examples === undefined) return parameters;
  const values = exampleValues(examples, id);
  const available = new Set(parameters.map(
    (parameter) => `${parameter.location}:${parameter.name}`,
  ));
  for (const key of values.keys()) {
    if (!available.has(key)) {
      invalidExamples(id, `Parameter example ${key} does not match a discovered parameter`);
    }
  }
  return parameters.map((parameter) => {
    const key = `${parameter.location}:${parameter.name}`;
    return values.has(key)
      ? { ...parameter, example: structuredClone(values.get(key)) }
      : parameter;
  });
}

function collectOverrideMaps(config) {
  const trusted = ownValue(config, 'trustedOverrides') ?? {};
  return {
    operationOverrides: new Map(
      Object.entries(ownValue(trusted, 'operations') ?? {}).sort(([left], [right]) => (
        left.localeCompare(right)
      )).map(([id, override]) => [id, structuredClone(override)]),
    ),
    routeOverrides: new Map(
      Object.entries(ownValue(trusted, 'routes') ?? {}).sort(([left], [right]) => (
        left.localeCompare(right)
      )).map(([id, override]) => [id, structuredClone(override)]),
    ),
  };
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
    updated.auth.allowedRoles = stableUniqueStrings(
      ownValue(override, 'allowedRoles'),
      'allowedRoles',
    );
    if (updated.auth.allowedRoles.length > 0) updated.auth.state = 'required';
  }
  updated.parameters = setParameterExamples(
    updated.parameters,
    ownValue(override, 'parameterExamples'),
    operation.id,
  );
  if (hasOwn(override, 'targetModel')) updated.targetModel = ownValue(override, 'targetModel');
  if (hasOwn(override, 'deleteMode')) updated.deleteMode = ownValue(override, 'deleteMode');
  if (hasOwn(override, 'rollback')) updated.rollback = ownValue(override, 'rollback');
  if (hasOwn(override, 'sideEffects')) {
    const sideEffects = ownValue(override, 'sideEffects');
    if (!isObject(sideEffects)) {
      throw manifestError('OVERRIDE_INVALID', `Side effects for ${operation.id} must be an object`);
    }
    updated.sideEffects = {
      state: 'known',
      classes: stableUniqueStrings(ownValue(sideEffects, 'classes'), 'side-effect classes'),
    };
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
    updated.auth.allowedRoles = stableUniqueStrings(
      ownValue(override, 'allowedRoles'),
      'allowedRoles',
    );
    if (updated.auth.allowedRoles.length > 0) updated.auth.state = 'required';
  }
  updated.parameters = setParameterExamples(
    updated.parameters,
    ownValue(override, 'parameterExamples'),
    route.id,
  );
  return updated;
}

function normalizeTarget(targetBoundary) {
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
  const trustedConfig = await validateTrustedConfig(config);
  const paths = discoveryPaths(trustedConfig);
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

  const { operationOverrides, routeOverrides } = collectOverrideMaps(trustedConfig);
  for (const [requestedId, override] of operationOverrides) {
    if (!operations.has(requestedId)) {
      throw manifestError(
        'OVERRIDE_ID_UNKNOWN',
        `Trusted operation override ID ${requestedId} was not discovered`,
      );
    }
    operations.set(requestedId, applyOperationOverride(operations.get(requestedId), override));
  }
  for (const [requestedId, override] of routeOverrides) {
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
    target: normalizeTarget(targetBoundary),
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
  const manifestSchema = await loadBundledSchema('sentinel-manifest');
  validateAgainstSchema(manifest, manifestSchema, { name: 'discovered manifest' });
  return manifest;
}
