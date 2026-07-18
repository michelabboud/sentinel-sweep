import { createHash } from 'node:crypto';

import { SentinelError } from './lib/errors.mjs';
import { parseSecretRef } from './lib/secrets.mjs';

const FORMATS = new Set(['postman', 'insomnia', 'bruno']);
const METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE']);
const MUTATIONS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE']);
const RESERVED_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'set-cookie',
  'x-access-token',
  'x-api-key',
  'x-auth-token',
]);
const MAX_OPERATIONS = 1000;
const MAX_ARTIFACTS = 1100;
const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_PROPERTIES = 200;
const MAX_ARRAY_ITEMS = 10;
const MAX_BODY_BYTES = 1024 * 1024;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;

function exportError(code, message) {
  return new SentinelError(code, message);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function compareCodeUnits(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort(compareCodeUnits).map(
      (key) => [key, sortJson(value[key])],
    ));
  }
  return value;
}

function jsonText(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateOrigin(config) {
  if (!Array.isArray(config?.approvedOrigins) || config.approvedOrigins.length !== 1) {
    throw exportError(
      'EXPORT_ORIGIN_AMBIGUOUS',
      'Collection export requires exactly one approved origin',
    );
  }
  const value = config.approvedOrigins[0];
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw exportError('EXPORT_ORIGIN_AMBIGUOUS', 'Approved export origin is invalid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
      || parsed.username.length > 0
      || parsed.password.length > 0
      || parsed.pathname !== '/'
      || parsed.search.length > 0
      || parsed.hash.length > 0
      || parsed.origin !== value) {
    throw exportError('EXPORT_ORIGIN_AMBIGUOUS', 'Approved export origin is invalid');
  }
  return value;
}

function validateEndpointPath(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > 4096
      || !value.startsWith('/')
      || value.startsWith('//')
      || /[\\?#\0-\x1f\x7f]/u.test(value)
      || /[{}]/u.test(value.replaceAll(/\{[A-Za-z_][A-Za-z0-9_.-]{0,127}\}/gu, ''))) {
    throw exportError('EXPORT_PATH_INVALID', 'Operation path is not safe to export');
  }
  for (const encodedSegment of value.split('/').slice(1)) {
    let segment = encodedSegment;
    for (let pass = 0; pass < 4; pass += 1) {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw exportError('EXPORT_PATH_INVALID', 'Operation path is not safe to export');
      }
      if (decoded === '.'
          || decoded === '..'
          || /[\\/?#\0-\x1f\x7f]/u.test(decoded)) {
        throw exportError('EXPORT_PATH_INVALID', 'Operation path is not safe to export');
      }
      if (decoded === segment) break;
      segment = decoded;
    }
  }
  return value;
}

function validateVariableName(value) {
  if (typeof value !== 'string' || !VARIABLE_NAME.test(value)) {
    throw exportError('EXPORT_OPERATION_INVALID', 'Operation parameter is not safe to export');
  }
  return value;
}

function roleVariables(config) {
  if (!isPlainObject(config?.roles)) {
    throw exportError('EXPORT_SECRET_REF_INVALID', 'Role configuration is invalid');
  }
  const byRole = new Map();
  for (const role of Object.keys(config.roles).sort(compareCodeUnits)) {
    if (role.length === 0 || !isPlainObject(config.roles[role])) {
      throw exportError('EXPORT_SECRET_REF_INVALID', 'Role configuration is invalid');
    }
    let parsed;
    try {
      parsed = parseSecretRef(config.roles[role].tokenRef);
    } catch {
      throw exportError('EXPORT_SECRET_REF_INVALID', 'Role secret reference is invalid');
    }
    byRole.set(role, parsed.name);
  }
  const names = [...new Set(byRole.values())].sort(compareCodeUnits);
  return { byRole, names };
}

function operationSort(left, right) {
  return compareCodeUnits(left.method, right.method)
    || compareCodeUnits(left.path, right.path)
    || compareCodeUnits(left.id, right.id);
}

function validateOperations(manifest) {
  if (!Array.isArray(manifest?.operations)) {
    throw exportError('EXPORT_OPERATION_INVALID', 'Manifest operations are invalid');
  }
  if (manifest.operations.length > MAX_OPERATIONS) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Collection operation limit exceeded');
  }
  const ids = new Set();
  const operations = manifest.operations.map((operation) => {
    if (!isPlainObject(operation)
        || typeof operation.id !== 'string'
        || operation.id.length === 0
        || ids.has(operation.id)
        || !METHODS.has(operation.method)) {
      throw exportError('EXPORT_OPERATION_INVALID', 'Manifest operation is invalid');
    }
    ids.add(operation.id);
    validateEndpointPath(operation.path);
    if (!Array.isArray(operation.parameters)
        || !isPlainObject(operation.auth)
        || !Array.isArray(operation.auth.allowedRoles)) {
      throw exportError('EXPORT_OPERATION_INVALID', 'Manifest operation is invalid');
    }
    return operation;
  });
  return operations.sort(operationSort);
}

function decodePointerSegment(value) {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolveLocalReference(root, reference) {
  if (reference === '#') return root;
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema reference is unsupported');
  }
  let current = root;
  for (const encoded of reference.slice(2).split('/')) {
    const segment = decodePointerSegment(encoded);
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema reference is unresolved');
    }
    current = current[segment];
  }
  if (!isPlainObject(current)) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema reference is invalid');
  }
  return current;
}

function schemaType(schema) {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    return schema.type.find((entry) => entry !== 'null') ?? 'null';
  }
  if (isPlainObject(schema.properties)) return 'object';
  if (isPlainObject(schema.items)) return 'array';
  return 'string';
}

function sampleFromSchema(schema, context, depth = 0) {
  if (!isPlainObject(schema)) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema is invalid');
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Request schema recursion limit exceeded');
  }
  if (context.active.has(schema)) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Recursive request schemas are not exportable');
  }
  context.active.add(schema);
  try {
    if (typeof schema.$ref === 'string') {
      return sampleFromSchema(resolveLocalReference(context.root, schema.$ref), context, depth + 1);
    }
    if (Array.isArray(schema.allOf)) {
      if (schema.allOf.length > MAX_SCHEMA_PROPERTIES) {
        throw exportError('EXPORT_LIMIT_EXCEEDED', 'Request schema branch limit exceeded');
      }
      const values = schema.allOf.map((entry) => sampleFromSchema(entry, context, depth + 1));
      if (values.every(isPlainObject)) {
        const merged = Object.create(null);
        for (const value of values) {
          for (const [name, entry] of Object.entries(value)) merged[name] = entry;
        }
        return merged;
      }
      return values[0] ?? null;
    }
    const branches = Array.isArray(schema.oneOf)
      ? schema.oneOf
      : Array.isArray(schema.anyOf)
        ? schema.anyOf
        : null;
    if (branches !== null) {
      if (branches.length === 0 || branches.length > MAX_SCHEMA_PROPERTIES) {
        throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema branches are invalid');
      }
      return sampleFromSchema(branches[0], context, depth + 1);
    }

    switch (schemaType(schema)) {
      case 'object': {
        const properties = isPlainObject(schema.properties) ? schema.properties : {};
        const names = Object.keys(properties).sort(compareCodeUnits);
        if (names.length > MAX_SCHEMA_PROPERTIES) {
          throw exportError('EXPORT_LIMIT_EXCEEDED', 'Request schema property limit exceeded');
        }
        const result = Object.create(null);
        for (const name of names) {
          if (name.length === 0 || name.length > 256 || /[\0\r\n]/u.test(name)) {
            throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema property is invalid');
          }
          result[name] = sampleFromSchema(properties[name], context, depth + 1);
        }
        return result;
      }
      case 'array': {
        const count = Number.isInteger(schema.minItems)
          ? Math.min(schema.minItems, MAX_ARRAY_ITEMS)
          : 0;
        if (Number.isInteger(schema.minItems) && schema.minItems > MAX_ARRAY_ITEMS) {
          throw exportError('EXPORT_LIMIT_EXCEEDED', 'Request schema array limit exceeded');
        }
        if (count === 0) return [];
        if (!isPlainObject(schema.items)) {
          throw exportError('EXPORT_SCHEMA_INVALID', 'Request array item schema is invalid');
        }
        return Array.from(
          { length: count },
          () => sampleFromSchema(schema.items, context, depth + 1),
        );
      }
      case 'integer':
        return Number.isFinite(schema.minimum) ? Math.ceil(schema.minimum) : 0;
      case 'number':
        return Number.isFinite(schema.minimum) ? schema.minimum : 0;
      case 'boolean':
        return false;
      case 'null':
        return null;
      case 'string':
      default:
        return '';
    }
  } finally {
    context.active.delete(schema);
  }
}

function requestBody(operation, manifest) {
  if (!MUTATIONS.has(operation.method)
      || !isPlainObject(operation.requestBody)
      || typeof operation.requestBody.schemaId !== 'string') {
    return null;
  }
  const record = isPlainObject(manifest?.schemas)
    ? manifest.schemas[operation.requestBody.schemaId]
    : undefined;
  if (!isPlainObject(record) || !isPlainObject(record.schema)) return null;
  const value = sampleFromSchema(record.schema, {
    root: record.schema,
    active: new Set(),
  });
  const content = JSON.stringify(sortJson(value));
  if (Buffer.byteLength(content) > MAX_BODY_BYTES) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Generated request body limit exceeded');
  }
  if (typeof operation.requestBody.contentType !== 'string'
      || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(
        operation.requestBody.contentType,
      )) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
  }
  return {
    value: sortJson(value),
    contentType: operation.requestBody.contentType,
  };
}

function requestShape(operation, manifest, secrets) {
  const variables = new Set();
  let requestPath = operation.path.replace(/\{([A-Za-z_][A-Za-z0-9_.-]{0,127})\}/gu, (_all, name) => {
    variables.add(name);
    return `{{${name}}}`;
  });
  const query = [];
  const headers = [];
  for (const parameter of operation.parameters) {
    if (!isPlainObject(parameter)
        || !['path', 'query', 'header', 'cookie'].includes(parameter.location)) {
      throw exportError('EXPORT_OPERATION_INVALID', 'Operation parameter is invalid');
    }
    const name = validateVariableName(parameter.name);
    variables.add(name);
    if (parameter.location === 'query') {
      query.push(`${encodeURIComponent(name)}={{${name}}}`);
    } else if (parameter.location === 'header'
        && !RESERVED_HEADERS.has(name.toLowerCase())) {
      headers.push({ name, value: `{{${name}}}` });
    }
  }
  for (const name of variables) {
    if (name === 'baseUrl' || secrets.names.includes(name)) {
      throw exportError(
        'EXPORT_VARIABLE_COLLISION',
        'Operation parameter collides with a trusted collection variable',
      );
    }
  }
  query.sort(compareCodeUnits);
  if (query.length > 0) requestPath += `?${query.join('&')}`;

  const configuredRole = [...operation.auth.allowedRoles]
    .sort(compareCodeUnits)
    .find((role) => secrets.byRole.has(role));
  if (configuredRole !== undefined) {
    headers.push({
      name: 'Authorization',
      value: `Bearer {{${secrets.byRole.get(configuredRole)}}}`,
    });
  }
  const body = requestBody(operation, manifest);
  if (body !== null) headers.push({ name: 'Content-Type', value: body.contentType });
  headers.sort((left, right) => compareCodeUnits(left.name, right.name)
    || compareCodeUnits(left.value, right.value));
  return {
    id: operation.id,
    name: `${operation.method} ${operation.path}`,
    method: operation.method,
    url: `{{baseUrl}}${requestPath}`,
    headers,
    body,
    variables: [...variables].sort(compareCodeUnits),
  };
}

function variablesFor(requests, origin, secrets) {
  const parameterNames = [...new Set(requests.flatMap((request) => request.variables))]
    .sort(compareCodeUnits);
  return [
    { key: 'baseUrl', value: origin },
    ...secrets.names.map((name) => ({ key: name, value: '' })),
    ...parameterNames
      .filter((name) => name !== 'baseUrl' && !secrets.names.includes(name))
      .map((name) => ({ key: name, value: '' })),
  ];
}

function artifact(path, mediaType, content) {
  return { path, mediaType, content };
}

function postmanArtifact(requests, variables) {
  const item = requests.map((request) => {
    const value = {
      name: request.name,
      request: {
        method: request.method,
        header: request.headers.map((header) => ({
          key: header.name,
          value: header.value,
          type: 'text',
        })),
        url: { raw: request.url },
      },
    };
    if (request.body !== null) {
      value.request.body = {
        mode: 'raw',
        raw: JSON.stringify(request.body.value, null, 2),
        options: { raw: { language: 'json' } },
      };
    }
    return value;
  });
  return artifact(
    'sentinel.postman_collection.json',
    'application/json',
    jsonText({
      info: {
        name: 'Sentinel export',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item,
      variable: variables.map((entry) => ({ ...entry, type: 'string' })),
    }),
  );
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function insomniaArtifact(requests, variables) {
  const workspaceId = `wrk_${shortHash('sentinel-export')}`;
  const environmentId = `env_${shortHash('sentinel-export-environment')}`;
  const resources = [
    {
      _id: workspaceId,
      _type: 'workspace',
      name: 'Sentinel export',
      description: 'Inert requests generated from the Sentinel request contract',
      scope: 'collection',
    },
    {
      _id: environmentId,
      _type: 'environment',
      parentId: workspaceId,
      name: 'Base environment',
      data: Object.fromEntries(variables.map((entry) => [entry.key, entry.value])),
    },
    ...requests.map((request) => {
      const value = {
        _id: `req_${shortHash(request.id)}`,
        _type: 'request',
        parentId: workspaceId,
        name: request.name,
        method: request.method,
        url: request.url,
        headers: request.headers.map((header) => ({
          name: header.name,
          value: header.value,
        })),
      };
      if (request.body !== null) {
        value.body = {
          mimeType: request.body.contentType,
          text: JSON.stringify(request.body.value, null, 2),
        };
      }
      return value;
    }),
  ];
  return artifact(
    'sentinel.insomnia.json',
    'application/json',
    jsonText({
      _type: 'export',
      __export_format: 4,
      __export_source: 'sentinel-sweep',
      resources,
    }),
  );
}

function brunoSlug(request, index) {
  const slug = `${request.method}-${request.url.replace(/^\{\{baseUrl\}\}/u, '')}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 72) || 'request';
  return `${String(index + 1).padStart(3, '0')}-${slug}-${shortHash(request.id)}`;
}

function brunoEnvironment(variables) {
  return [
    'vars {',
    ...variables.map((entry) => `  ${entry.key}: ${entry.value}`),
    '}',
    '',
  ].join('\n');
}

function brunoRequest(request, index) {
  const method = request.method.toLowerCase();
  const lines = [
    'meta {',
    `  name: ${request.name}`,
    '  type: http',
    `  seq: ${index + 1}`,
    '}',
    '',
    `${method} {`,
    `  url: ${request.url}`,
    ...(request.body === null ? [] : ['  body: json']),
    '  auth: none',
    '}',
  ];
  if (request.headers.length > 0) {
    lines.push('', 'headers {', ...request.headers.map(
      (header) => `  ${header.name}: ${header.value}`,
    ), '}');
  }
  if (request.body !== null) {
    lines.push('', 'body:json {', JSON.stringify(request.body.value, null, 2), '}');
  }
  lines.push('');
  return lines.join('\n');
}

function brunoArtifacts(requests, variables) {
  return [
    artifact('bruno.json', 'application/json', jsonText({
      version: '1',
      name: 'Sentinel export',
      type: 'collection',
      ignore: ['node_modules', '.git'],
    })),
    artifact('environments/sentinel.bru', 'text/plain', brunoEnvironment(variables)),
    ...requests.map((request, index) => artifact(
      `requests/${brunoSlug(request, index)}.bru`,
      'text/plain',
      brunoRequest(request, index),
    )),
  ];
}

/** Returns inert collection files; this function never writes or resolves a secret. */
export function exportCollection({ format, manifest, config } = {}) {
  if (!FORMATS.has(format)) {
    throw exportError('EXPORT_FORMAT_UNSUPPORTED', 'Collection export format is unsupported');
  }
  const origin = validateOrigin(config);
  const secrets = roleVariables(config);
  const operations = validateOperations(manifest);
  const requests = operations.map((operation) => requestShape(operation, manifest, secrets));
  const variables = variablesFor(requests, origin, secrets);
  let artifacts;
  if (format === 'postman') artifacts = [postmanArtifact(requests, variables)];
  else if (format === 'insomnia') artifacts = [insomniaArtifact(requests, variables)];
  else artifacts = brunoArtifacts(requests, variables);
  if (artifacts.length > MAX_ARTIFACTS) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Collection artifact limit exceeded');
  }
  return deepFreeze(artifacts);
}
