import path from 'node:path';

import { SentinelError } from '../lib/errors.mjs';

const METHOD_ORDER = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE'];
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PARAMETER_LOCATIONS = new Set(['path', 'query', 'header', 'cookie']);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function discoveryError(code, message, details = {}) {
  return new SentinelError(code, message, details);
}

function assertRelativeJsonPath(relativePath) {
  if (typeof relativePath !== 'string'
      || relativePath.length === 0
      || path.posix.isAbsolute(relativePath)
      || path.win32.isAbsolute(relativePath)
      || relativePath.startsWith('//')
      || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(relativePath)) {
    throw discoveryError('OPENAPI_PATH_INVALID', 'OpenAPI input path must be relative');
  }
  if (path.extname(relativePath).toLowerCase() !== '.json') {
    throw discoveryError('OPENAPI_PATH_INVALID', 'OpenAPI discovery accepts JSON files only');
  }
}

function localSchemaReference(reference) {
  if (typeof reference !== 'string') return null;
  const match = /^#\/components\/schemas\/([^/]+)$/u.exec(reference);
  return match ? decodePointerSegment(match[1]) : null;
}

function qualifiedSchemaId(name) {
  return `schema:openapi:${name}`;
}

function isJsonContentType(contentType) {
  const normalized = contentType.split(';', 1)[0].trim().toLowerCase();
  return normalized === 'application/json' || normalized.endsWith('+json');
}

function inspectUnsupported(document, relativePath, state) {
  function visit(value, pointer) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, appendPointer(pointer, index)));
      return;
    }
    if (!isObject(value)) return;

    if (hasOwn(value, '$ref') && localSchemaReference(value.$ref) === null) {
      state.gaps.add(`external-ref:${appendPointer(pointer, '$ref')}`);
    }

    if (isObject(value.content)) {
      for (const contentType of Object.keys(value.content).sort()) {
        if (!isJsonContentType(contentType)) {
          state.gaps.add(`non-json-content:${appendPointer(appendPointer(pointer, 'content'), contentType)}`);
        }
      }
    }

    for (const key of Object.keys(value).sort()) {
      const childPointer = appendPointer(pointer, key);
      if (key.startsWith('x-sentinel-')) {
        state.diagnostics.push({
          code: 'OPENAPI_UNTRUSTED_EXTENSION_IGNORED',
          message: `Ignored untrusted source extension ${key}`,
          sourcePath: relativePath,
          pointer: childPointer,
        });
      }
      visit(value[key], childPointer);
    }
  }

  visit(document, '#');

  if (isObject(document.webhooks)) {
    for (const name of Object.keys(document.webhooks).sort()) {
      state.gaps.add(`webhook:${appendPointer('#/webhooks', name)}`);
    }
  }
}

function normalizeSchema(schema, document, pointer, state) {
  if (!isObject(schema)) return {};

  if (hasOwn(schema, '$ref')) {
    const name = localSchemaReference(schema.$ref);
    if (name === null) return {};
    if (!isObject(document.components?.schemas?.[name])) {
      state.gaps.add(`unresolved-ref:${appendPointer(pointer, '$ref')}`);
      return {};
    }
    return { $ref: qualifiedSchemaId(name) };
  }

  const normalized = {};
  if (typeof schema.type === 'string'
      || (Array.isArray(schema.type) && schema.type.every((entry) => typeof entry === 'string'))) {
    normalized.type = schema.type;
  }
  if (hasOwn(schema, 'const')) normalized.const = structuredClone(schema.const);
  if (Array.isArray(schema.enum)) normalized.enum = structuredClone(schema.enum);
  if (Array.isArray(schema.required)) {
    normalized.required = schema.required.filter((entry) => typeof entry === 'string');
  }
  if (isObject(schema.properties)) {
    normalized.properties = Object.fromEntries(
      Object.keys(schema.properties).sort().map((name) => [
        name,
        normalizeSchema(
          schema.properties[name],
          document,
          appendPointer(appendPointer(pointer, 'properties'), name),
          state,
        ),
      ]),
    );
  }
  if (isObject(schema.items)) {
    normalized.items = normalizeSchema(schema.items, document, appendPointer(pointer, 'items'), state);
  }
  if (typeof schema.additionalProperties === 'boolean') {
    normalized.additionalProperties = schema.additionalProperties;
  } else if (isObject(schema.additionalProperties)) {
    normalized.additionalProperties = normalizeSchema(
      schema.additionalProperties,
      document,
      appendPointer(pointer, 'additionalProperties'),
      state,
    );
  }
  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[keyword]) && schema[keyword].length > 0) {
      normalized[keyword] = schema[keyword].map((entry, index) => normalizeSchema(
        entry,
        document,
        appendPointer(appendPointer(pointer, keyword), index),
        state,
      ));
    }
  }
  for (const keyword of ['minItems', 'minLength', 'minimum', 'maximum']) {
    if (typeof schema[keyword] === 'number' && Number.isFinite(schema[keyword])) {
      normalized[keyword] = schema[keyword];
    }
  }
  if (typeof schema.pattern === 'string') normalized.pattern = schema.pattern;
  return normalized;
}

function schemaIdFor(schema, document, pointer, state) {
  if (!isObject(schema) || !hasOwn(schema, '$ref')) return null;
  const name = localSchemaReference(schema.$ref);
  if (name === null) return null;
  if (!isObject(document.components?.schemas?.[name])) {
    state.gaps.add(`unresolved-ref:${appendPointer(pointer, '$ref')}`);
    return null;
  }
  return qualifiedSchemaId(name);
}

function normalizeParameter(parameter, document, pointer, state) {
  if (!isObject(parameter) || hasOwn(parameter, '$ref')) return null;
  if (typeof parameter.name !== 'string' || !PARAMETER_LOCATIONS.has(parameter.in)) return null;

  const normalized = {
    name: parameter.name,
    location: parameter.in,
    required: parameter.in === 'path' || parameter.required === true,
    schema: normalizeSchema(parameter.schema, document, appendPointer(pointer, 'schema'), state),
  };
  const example = hasOwn(parameter, 'example') ? parameter.example : parameter.schema?.example;
  if (example !== undefined) normalized.example = structuredClone(example);
  return normalized;
}

function normalizeParameters(pathParameters, operationParameters, document, pathPointer, operationPointer, state) {
  const ordered = [];
  const positions = new Map();
  const groups = [
    [pathParameters, appendPointer(pathPointer, 'parameters')],
    [operationParameters, appendPointer(operationPointer, 'parameters')],
  ];

  for (const [parameters, pointer] of groups) {
    if (!Array.isArray(parameters)) continue;
    parameters.forEach((parameter, index) => {
      const normalized = normalizeParameter(parameter, document, appendPointer(pointer, index), state);
      if (normalized === null) return;
      const key = `${normalized.location}\0${normalized.name}`;
      if (positions.has(key)) {
        ordered[positions.get(key)] = normalized;
      } else {
        positions.set(key, ordered.length);
        ordered.push(normalized);
      }
    });
  }
  return ordered;
}

function authFromSecurity(security) {
  if (!Array.isArray(security)) return { state: 'unknown', allowedRoles: [] };
  if (security.length === 0 || security.some((requirement) => isObject(requirement)
      && Object.keys(requirement).length === 0)) {
    return { state: 'public', allowedRoles: [] };
  }
  return { state: 'required', allowedRoles: [] };
}

function normalizeRequestBody(requestBody, document, pointer, state) {
  if (!isObject(requestBody) || hasOwn(requestBody, '$ref') || !isObject(requestBody.content)) {
    return null;
  }
  const contentType = Object.keys(requestBody.content).sort().find(isJsonContentType);
  if (contentType === undefined) return null;
  const schema = requestBody.content[contentType]?.schema;
  const schemaPointer = appendPointer(
    appendPointer(appendPointer(pointer, 'content'), contentType),
    'schema',
  );
  return {
    required: requestBody.required === true,
    contentType,
    schemaId: schemaIdFor(schema, document, schemaPointer, state),
  };
}

function normalizeResponses(responses, document, pointer, state) {
  if (!isObject(responses)) return {};
  return Object.fromEntries(Object.keys(responses).sort().map((status) => {
    const response = responses[status];
    if (!isObject(response) || !isObject(response.content)) {
      return [status, { contentType: null, schemaId: null }];
    }
    const contentType = Object.keys(response.content).sort().find(isJsonContentType);
    if (contentType === undefined) {
      return [status, { contentType: null, schemaId: null }];
    }
    const schema = response.content[contentType]?.schema;
    const schemaPointer = appendPointer(
      appendPointer(appendPointer(appendPointer(pointer, status), 'content'), contentType),
      'schema',
    );
    return [status, {
      contentType,
      schemaId: schemaIdFor(schema, document, schemaPointer, state),
    }];
  }));
}

function riskFor(method) {
  if (READ_ONLY_METHODS.has(method)) {
    return { score: 0, level: 'safe', reasons: [] };
  }
  return {
    score: 100,
    level: 'critical',
    reasons: ['mutation-side-effects-unknown'],
  };
}

function aggregateRouteAuth(operations) {
  const states = new Set(operations.map((operation) => operation.auth.state));
  if (states.size === 1) return { state: operations[0].auth.state, allowedRoles: [] };
  if (states.has('required')) return { state: 'required', allowedRoles: [] };
  return { state: 'unknown', allowedRoles: [] };
}

function diagnosticsForGaps(gaps, relativePath) {
  return gaps.map((gap) => {
    const separator = gap.indexOf(':');
    const kind = gap.slice(0, separator);
    const pointer = gap.slice(separator + 1);
    return {
      code: `OPENAPI_${kind.replaceAll('-', '_').toUpperCase()}`,
      message: `OpenAPI discovery encountered unsupported ${kind.replaceAll('-', ' ')}`,
      sourcePath: relativePath,
      pointer,
    };
  });
}

export async function discoverOpenApi({ boundary, relativePath }) {
  assertRelativeJsonPath(relativePath);
  if (boundary === null || typeof boundary !== 'object' || typeof boundary.readText !== 'function') {
    throw discoveryError('OPENAPI_BOUNDARY_INVALID', 'A TargetBoundary is required');
  }

  let document;
  try {
    document = JSON.parse(await boundary.readText(relativePath));
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    throw discoveryError('OPENAPI_PARSE_FAILED', 'OpenAPI input must contain valid JSON');
  }
  if (!isObject(document)
      || typeof document.openapi !== 'string'
      || !/^3\.(?:0|1)\./u.test(document.openapi)) {
    throw discoveryError(
      'OPENAPI_VERSION_UNSUPPORTED',
      'OpenAPI 3.0 or 3.1 is required',
    );
  }

  const state = { gaps: new Set(), diagnostics: [] };
  inspectUnsupported(document, relativePath, state);
  const operations = [];
  const routes = [];
  const paths = isObject(document.paths) ? document.paths : {};

  for (const apiPath of Object.keys(paths).sort()) {
    const pathItem = paths[apiPath];
    const pathPointer = appendPointer('#/paths', apiPath);
    if (!apiPath.startsWith('/') || apiPath.startsWith('//') || !isObject(pathItem)) {
      state.gaps.add(`invalid-path:${pathPointer}`);
      continue;
    }
    const pathOperations = [];
    for (const method of METHOD_ORDER) {
      const source = pathItem[method.toLowerCase()];
      if (!isObject(source)) continue;
      const operationPointer = appendPointer(pathPointer, method.toLowerCase());
      if (isObject(source.callbacks)) {
        state.gaps.add(`callback:${appendPointer(operationPointer, 'callbacks')}`);
      }
      const mutation = !READ_ONLY_METHODS.has(method);
      const operation = {
        id: `op:${method.toLowerCase()}:${apiPath}`,
        method,
        path: apiPath,
        summary: typeof source.summary === 'string' ? source.summary : null,
        parameters: normalizeParameters(
          pathItem.parameters,
          source.parameters,
          document,
          pathPointer,
          operationPointer,
          state,
        ),
        requestBody: normalizeRequestBody(
          source.requestBody,
          document,
          appendPointer(operationPointer, 'requestBody'),
          state,
        ),
        responses: normalizeResponses(
          source.responses,
          document,
          appendPointer(operationPointer, 'responses'),
          state,
        ),
        auth: authFromSecurity(hasOwn(source, 'security') ? source.security : document.security),
        targetModel: null,
        deleteMode: method === 'DELETE' ? 'unknown' : null,
        sideEffects: mutation
          ? { state: 'unknown', classes: [] }
          : { state: 'known', classes: [] },
        rollback: null,
        mutation,
        protocol: 'http',
        sweepable: !mutation,
        risk: riskFor(method),
        provenance: { adapter: 'openapi-json', file: relativePath, pointer: operationPointer },
      };
      operations.push(operation);
      pathOperations.push(operation);
    }
    if (pathOperations.length > 0) {
      routes.push({
        id: `route:${apiPath}`,
        path: apiPath,
        name: null,
        component: null,
        aliases: [],
        auth: aggregateRouteAuth(pathOperations),
        parameters: normalizeParameters(
          pathItem.parameters,
          [],
          document,
          pathPointer,
          pathPointer,
          state,
        ),
        provenance: { adapter: 'openapi-json', file: relativePath, pointer: pathPointer },
      });
    }
  }

  const schemas = [];
  const componentSchemas = isObject(document.components?.schemas)
    ? document.components.schemas
    : {};
  for (const name of Object.keys(componentSchemas).sort()) {
    const pointer = appendPointer('#/components/schemas', name);
    schemas.push({
      id: qualifiedSchemaId(name),
      schema: normalizeSchema(componentSchemas[name], document, pointer, state),
      provenance: { adapter: 'openapi-json', file: relativePath, pointer },
    });
  }

  const gaps = [...state.gaps].sort();
  const diagnostics = [...state.diagnostics, ...diagnosticsForGaps(gaps, relativePath)]
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return {
    coverage: {
      adapter: 'openapi-json',
      status: gaps.length === 0 ? 'complete' : 'partial',
      gaps,
    },
    diagnostics,
    routes,
    operations,
    schemas,
  };
}
