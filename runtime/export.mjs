import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { SentinelError } from './lib/errors.mjs';
import { snapshotJson } from './lib/json-snapshot.mjs';
import { parseApprovedOrigin } from './lib/origin.mjs';
import { validateAgainstSchema } from './lib/schema.mjs';
import { parseSecretRef } from './lib/secrets.mjs';

const MANIFEST_SCHEMA = JSON.parse(
  readFileSync(new URL('../schemas/sentinel-manifest.schema.json', import.meta.url), 'utf8'),
);

const FORMATS = ['postman', 'insomnia', 'bruno'];
const METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE', 'TRACE'];
const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];
const RESERVED_HEADERS = [
  'authorization',
  'content-length',
  'content-type',
  'cookie',
  'host',
  'proxy-authorization',
  'set-cookie',
  'transfer-encoding',
  'x-access-token',
  'x-api-key',
  'x-auth-token',
];
const MAX_OPERATIONS = 1000;
const MAX_ARTIFACTS = 1100;
const MAX_SCHEMA_DEPTH = 20;
const MAX_SCHEMA_PROPERTIES = 200;
const MAX_ARRAY_ITEMS = 10;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_SCHEMA_WORK = 20_000;
const MAX_TOTAL_PARAMETERS = 10_000;
const MAX_TOTAL_VARIABLES = 10_000;
const MAX_TOTAL_BODY_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_MEDIA_TYPE_LENGTH = 1024;

function append(array, value) {
  Object.defineProperty(array, String(array.length), {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function arrayContains(array, value) {
  for (let index = 0; index < array.length; index += 1) {
    if (array[index] === value) return true;
  }
  return false;
}

function copyArray(array) {
  const copy = [];
  for (let index = 0; index < array.length; index += 1) append(copy, array[index]);
  return copy;
}

function sortedCopy(array, comparator) {
  let source = copyArray(array);
  for (let width = 1; width < source.length; width *= 2) {
    const target = [];
    for (let start = 0; start < source.length; start += width * 2) {
      const middle = Math.min(start + width, source.length);
      const end = Math.min(start + (width * 2), source.length);
      let left = start;
      let right = middle;
      while (left < middle || right < end) {
        if (right >= end
            || (left < middle && comparator(source[left], source[right]) <= 0)) {
          append(target, source[left]);
          left += 1;
        } else {
          append(target, source[right]);
          right += 1;
        }
      }
    }
    source = target;
  }
  return source;
}

function stringStartsWith(value, prefix) {
  if (prefix.length > value.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (value[index] !== prefix[index]) return false;
  }
  return true;
}

function stringEndsWith(value, suffix) {
  if (suffix.length > value.length) return false;
  const offset = value.length - suffix.length;
  for (let index = 0; index < suffix.length; index += 1) {
    if (value[offset + index] !== suffix[index]) return false;
  }
  return true;
}

function stringRange(value, start, end = value.length) {
  let result = '';
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.min(value.length, end);
  for (let index = boundedStart; index < boundedEnd; index += 1) result += value[index];
  return result;
}

function stringIndexOf(value, search, start = 0) {
  if (search.length === 0) return Math.min(Math.max(0, start), value.length);
  for (let index = Math.max(0, start); index + search.length <= value.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < search.length; offset += 1) {
      if (value[index + offset] !== search[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

function joinStrings(values, separator) {
  let result = '';
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) result += separator;
    result += String(values[index]);
  }
  return result;
}

function asciiLower(value) {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    let replacement = character;
    for (let letter = 0; letter < upper.length; letter += 1) {
      if (character === upper[letter]) {
        replacement = lower[letter];
        break;
      }
    }
    result += replacement;
  }
  return result;
}

function isControl(character) {
  return character <= '\u001f'
    || (character >= '\u007f' && character <= '\u009f')
    || character === '\u2028'
    || character === '\u2029';
}

function isVariableStart(character) {
  return character === '_'
    || (character >= 'A' && character <= 'Z')
    || (character >= 'a' && character <= 'z');
}

function isVariablePart(character) {
  return isVariableStart(character)
    || (character >= '0' && character <= '9')
    || character === '.'
    || character === '-';
}

function isVariableName(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > 128
      || !isVariableStart(value[0])) return false;
  for (let index = 1; index < value.length; index += 1) {
    if (!isVariablePart(value[index])) return false;
  }
  return true;
}

function uniqueStrings(values) {
  const seen = Object.create(null);
  const unique = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Object.hasOwn(seen, value)) {
      Object.defineProperty(seen, value, { value: true, enumerable: true });
      append(unique, value);
    }
  }
  return unique;
}

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
  if (Array.isArray(value)) {
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      append(result, sortJson(value[index]));
    }
    return result;
  }
  if (isPlainObject(value)) {
    const result = {};
    const keys = sortedCopy(Object.keys(value), compareCodeUnits);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: sortJson(value[key]),
        writable: true,
      });
    }
    return result;
  }
  return value;
}

function jsonText(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  const children = Object.values(value);
  for (let index = 0; index < children.length; index += 1) deepFreeze(children[index]);
  return Object.freeze(value);
}

function snapshotExportOptions(options) {
  try {
    return snapshotJson(options, {
      code: 'EXPORT_INPUT_INVALID',
      message: 'Collection export input must be recursively plain own-data JSON',
      maxNodes: 50_000,
      maxArrayLength: 20_000,
      limitCode: 'EXPORT_LIMIT_EXCEEDED',
      limitMessage: 'Collection export input exceeds its global work budget',
    });
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    throw exportError('EXPORT_INPUT_INVALID', 'Collection export input is invalid');
  }
}

function validateManifest(manifest) {
  try {
    validateAgainstSchema(manifest, MANIFEST_SCHEMA, { name: 'manifest' });
  } catch (error) {
    if (error?.code === 'SCHEMA_VALIDATION_LIMIT_EXCEEDED') {
      throw exportError('EXPORT_LIMIT_EXCEEDED', 'Collection export validation limit exceeded');
    }
    throw exportError('EXPORT_MANIFEST_INVALID', 'Collection export manifest is invalid');
  }
}

function validateConfig(config) {
  if (!isPlainObject(config)
      || !Array.isArray(config.approvedOrigins)
      || !isPlainObject(config.roles)
      || (Object.hasOwn(config, 'allowNonLoopback')
        && typeof config.allowNonLoopback !== 'boolean')) {
    throw exportError('EXPORT_CONFIG_INVALID', 'Collection export config is invalid');
  }
  const roles = Object.keys(config.roles);
  for (let index = 0; index < roles.length; index += 1) {
    const role = roles[index];
    const record = config.roles[role];
    if (role.length === 0
        || !isPlainObject(record)
        || Object.keys(record).length !== 1
        || !Object.hasOwn(record, 'tokenRef')) {
      throw exportError('EXPORT_CONFIG_INVALID', 'Collection export role config is invalid');
    }
  }
}

function validateOrigin(config) {
  if (!Array.isArray(config?.approvedOrigins) || config.approvedOrigins.length !== 1) {
    throw exportError(
      'EXPORT_ORIGIN_AMBIGUOUS',
      'Collection export requires exactly one approved origin',
    );
  }
  let normalized;
  try {
    normalized = parseApprovedOrigin(config.approvedOrigins[0], {
      allowNonLoopback: config.allowNonLoopback === true,
    });
  } catch {
    throw exportError('EXPORT_ORIGIN_AMBIGUOUS', 'Approved export origin is invalid');
  }
  return normalized;
}

function validateEndpointPath(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > 4096
      || value[0] !== '/'
      || value[1] === '/') {
    throw exportError('EXPORT_PATH_INVALID', 'Operation path is not safe to export');
  }
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '\\'
        || character === '?'
        || character === '#'
        || isControl(character)) {
      throw exportError('EXPORT_PATH_INVALID', 'Operation path is not safe to export');
    }
    if (character === '{') {
      const close = stringIndexOf(value, '}', index + 1);
      if (close < 0 || !isVariableName(stringRange(value, index + 1, close))) {
        throw exportError('EXPORT_PATH_INVALID', 'Operation path is not safe to export');
      }
      index = close;
    } else if (character === '}') {
      throw exportError('EXPORT_PATH_INVALID', 'Operation path is not safe to export');
    }
  }
  let segmentStart = 1;
  for (let index = 1; index <= value.length; index += 1) {
    if (index < value.length && value[index] !== '/') continue;
    const encodedSegment = stringRange(value, segmentStart, index);
    let segment = encodedSegment;
    let settled = false;
    for (let pass = 0; pass <= encodedSegment.length; pass += 1) {
      let decoded;
      try {
        decoded = decodeURIComponent(segment);
      } catch {
        throw exportError('EXPORT_PATH_INVALID', 'Operation path is not safe to export');
      }
      if (decoded === '.' || decoded === '..') {
        throw exportError('EXPORT_PATH_INVALID', 'Operation path is not safe to export');
      }
      for (let decodedIndex = 0; decodedIndex < decoded.length; decodedIndex += 1) {
        const character = decoded[decodedIndex];
        if (character === '\\'
            || character === '/'
            || character === '?'
            || character === '#'
            || isControl(character)) {
          throw exportError('EXPORT_PATH_INVALID', 'Operation path is not safe to export');
        }
      }
      if (decoded === segment) {
        settled = true;
        break;
      }
      segment = decoded;
    }
    if (!settled) throw exportError('EXPORT_PATH_INVALID', 'Operation path is not safe to export');
    segmentStart = index + 1;
  }
  return value;
}

function validateVariableName(value) {
  if (!isVariableName(value)) {
    throw exportError('EXPORT_OPERATION_INVALID', 'Operation parameter is not safe to export');
  }
  return value;
}

function roleVariables(config) {
  if (!isPlainObject(config?.roles)) {
    throw exportError('EXPORT_SECRET_REF_INVALID', 'Role configuration is invalid');
  }
  const byRole = Object.create(null);
  const names = [];
  const roles = sortedCopy(Object.keys(config.roles), compareCodeUnits);
  for (let index = 0; index < roles.length; index += 1) {
    const role = roles[index];
    const record = Object.hasOwn(config.roles, role) ? config.roles[role] : undefined;
    if (role.length === 0 || !isPlainObject(record)) {
      throw exportError('EXPORT_SECRET_REF_INVALID', 'Role configuration is invalid');
    }
    let parsed;
    try {
      parsed = parseSecretRef(record.tokenRef);
    } catch {
      throw exportError('EXPORT_SECRET_REF_INVALID', 'Role secret reference is invalid');
    }
    Object.defineProperty(byRole, role, {
      configurable: true,
      enumerable: true,
      value: parsed.name,
      writable: true,
    });
    append(names, parsed.name);
  }
  return { byRole, names: sortedCopy(uniqueStrings(names), compareCodeUnits) };
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
  const ids = Object.create(null);
  const operations = [];
  for (let index = 0; index < manifest.operations.length; index += 1) {
    const operation = manifest.operations[index];
    if (!isPlainObject(operation)
        || typeof operation.id !== 'string'
        || operation.id.length === 0
        || Object.hasOwn(ids, operation.id)
        || !arrayContains(METHODS, operation.method)) {
      throw exportError('EXPORT_OPERATION_INVALID', 'Manifest operation is invalid');
    }
    Object.defineProperty(ids, operation.id, { value: true, enumerable: true });
    if (operation.protocol !== 'http') {
      throw exportError(
        'EXPORT_PROTOCOL_UNSUPPORTED',
        'Collection export supports only HTTP operations',
      );
    }
    validateEndpointPath(operation.path);
    if (!Array.isArray(operation.parameters)
        || !isPlainObject(operation.auth)
        || !Array.isArray(operation.auth.allowedRoles)) {
      throw exportError('EXPORT_OPERATION_INVALID', 'Manifest operation is invalid');
    }
    append(operations, operation);
  }
  return sortedCopy(operations, operationSort);
}

function decodePointerSegment(value) {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '~') {
      decoded += value[index];
      continue;
    }
    if (index + 1 >= value.length || !arrayContains(['0', '1'], value[index + 1])) {
      throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema pointer is invalid');
    }
    decoded += value[index + 1] === '1' ? '/' : '~';
    index += 1;
  }
  return decoded;
}

function resolveReference(context, root, reference) {
  if (reference === '#') return { schema: root, root };
  if (typeof reference === 'string' && stringStartsWith(reference, 'schema:')) {
    const record = Object.hasOwn(context.registry, reference)
      ? context.registry[reference]
      : undefined;
    if (!isPlainObject(record) || !isPlainObject(record.schema)) {
      throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema reference is unresolved');
    }
    return { schema: record.schema, root: record.schema };
  }
  if (typeof reference !== 'string' || !stringStartsWith(reference, '#/')) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema reference is unsupported');
  }
  let current = root;
  const encodedSegments = [];
  let segmentStart = 2;
  for (let index = 2; index <= reference.length; index += 1) {
    if (index < reference.length && reference[index] !== '/') continue;
    append(encodedSegments, stringRange(reference, segmentStart, index));
    segmentStart = index + 1;
  }
  for (let index = 0; index < encodedSegments.length; index += 1) {
    const encoded = encodedSegments[index];
    const segment = decodePointerSegment(encoded);
    if (!isPlainObject(current) || !Object.hasOwn(current, segment)) {
      throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema reference is unresolved');
    }
    current = current[segment];
  }
  if (!isPlainObject(current)) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema reference is invalid');
  }
  return { schema: current, root };
}

function schemaType(schema) {
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) {
    for (let index = 0; index < schema.type.length; index += 1) {
      if (schema.type[index] !== 'null') return schema.type[index];
    }
    return 'null';
  }
  if (isPlainObject(schema.properties)) return 'object';
  if (isPlainObject(schema.items)) return 'array';
  return 'string';
}

function bumpWork(context, amount = 1) {
  context.work += amount;
  if (context.work > MAX_SCHEMA_WORK) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Global request schema work limit exceeded');
  }
}

function rootMemo(context, root) {
  let memo = context.memo.get(root);
  if (memo === undefined) {
    memo = new WeakMap();
    context.memo.set(root, memo);
  }
  return memo;
}

function rootActive(context, root) {
  let active = context.active.get(root);
  if (active === undefined) {
    active = new WeakSet();
    context.active.set(root, active);
  }
  return active;
}

function sampleFromSchema(schema, context, root, depth = 0) {
  if (!isPlainObject(schema)) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema is invalid');
  }
  bumpWork(context);
  if (depth > MAX_SCHEMA_DEPTH) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Request schema recursion limit exceeded');
  }
  const active = rootActive(context, root);
  if (active.has(schema)) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Recursive request schemas are not exportable');
  }
  const memo = rootMemo(context, root);
  if (memo.has(schema)) return memo.get(schema);
  active.add(schema);
  try {
    if (typeof schema.$ref === 'string') {
      const resolved = resolveReference(context, root, schema.$ref);
      const value = sampleFromSchema(resolved.schema, context, resolved.root, depth + 1);
      memo.set(schema, value);
      return value;
    }
    if (Array.isArray(schema.allOf)) {
      if (schema.allOf.length > MAX_SCHEMA_PROPERTIES) {
        throw exportError('EXPORT_LIMIT_EXCEEDED', 'Request schema branch limit exceeded');
      }
      bumpWork(context, schema.allOf.length);
      const values = [];
      let allObjects = true;
      for (let index = 0; index < schema.allOf.length; index += 1) {
        const value = sampleFromSchema(schema.allOf[index], context, root, depth + 1);
        if (!isPlainObject(value)) allObjects = false;
        append(values, value);
      }
      let result;
      if (allObjects) {
        result = Object.create(null);
        for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
          const value = values[valueIndex];
          const names = Object.keys(value);
          for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
            const name = names[nameIndex];
            Object.defineProperty(result, name, {
              configurable: true,
              enumerable: true,
              value: value[name],
              writable: true,
            });
          }
        }
      } else {
        result = values[0];
        result ??= null;
      }
      memo.set(schema, result);
      return result;
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
      bumpWork(context, branches.length);
      const result = sampleFromSchema(branches[0], context, root, depth + 1);
      memo.set(schema, result);
      return result;
    }

    let result;
    switch (schemaType(schema)) {
      case 'object': {
        const properties = isPlainObject(schema.properties) ? schema.properties : {};
        const names = sortedCopy(Object.keys(properties), compareCodeUnits);
        if (names.length > MAX_SCHEMA_PROPERTIES) {
          throw exportError('EXPORT_LIMIT_EXCEEDED', 'Request schema property limit exceeded');
        }
        bumpWork(context, names.length);
        result = Object.create(null);
        for (let index = 0; index < names.length; index += 1) {
          const name = names[index];
          let safeName = name.length > 0 && name.length <= 256;
          for (let nameIndex = 0; nameIndex < name.length; nameIndex += 1) {
            if (isControl(name[nameIndex])) safeName = false;
          }
          if (!safeName) {
            throw exportError('EXPORT_SCHEMA_INVALID', 'Request schema property is invalid');
          }
          Object.defineProperty(result, name, {
            value: sampleFromSchema(properties[name], context, root, depth + 1),
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        break;
      }
      case 'array': {
        const count = Number.isInteger(schema.minItems)
          ? Math.min(schema.minItems, MAX_ARRAY_ITEMS)
          : 0;
        if (Number.isInteger(schema.minItems) && schema.minItems > MAX_ARRAY_ITEMS) {
          throw exportError('EXPORT_LIMIT_EXCEEDED', 'Request schema array limit exceeded');
        }
        if (count === 0) {
          result = [];
          break;
        }
        if (!isPlainObject(schema.items)) {
          throw exportError('EXPORT_SCHEMA_INVALID', 'Request array item schema is invalid');
        }
        bumpWork(context, count);
        result = [];
        for (let index = 0; index < count; index += 1) {
          append(result, sampleFromSchema(schema.items, context, root, depth + 1));
        }
        break;
      }
      case 'integer':
        result = Number.isFinite(schema.minimum) ? Math.ceil(schema.minimum) : 0;
        break;
      case 'number':
        result = Number.isFinite(schema.minimum) ? schema.minimum : 0;
        break;
      case 'boolean':
        result = false;
        break;
      case 'null':
        result = null;
        break;
      case 'string':
      default:
        result = '';
        break;
    }
    memo.set(schema, result);
    return result;
  } finally {
    active.delete(schema);
  }
}

function isTokenCharacter(character) {
  if ((character >= '0' && character <= '9')
      || (character >= 'A' && character <= 'Z')
      || (character >= 'a' && character <= 'z')) return true;
  const punctuation = "!#$%&'*+-.^_`|~";
  for (let index = 0; index < punctuation.length; index += 1) {
    if (character === punctuation[index]) return true;
  }
  return false;
}

function trimOptionalWhitespace(value) {
  let start = 0;
  let end = value.length;
  while (start < end && (value[start] === ' ' || value[start] === '\t')) start += 1;
  while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) end -= 1;
  return stringRange(value, start, end);
}

function readToken(value, start) {
  let end = start;
  while (end < value.length && isTokenCharacter(value[end])) end += 1;
  return { end, value: stringRange(value, start, end) };
}

function validateJsonMediaType(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MEDIA_TYPE_LENGTH) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
  }
  const mediaType = trimOptionalWhitespace(value);
  for (let index = 0; index < mediaType.length; index += 1) {
    if (isControl(mediaType[index]) && mediaType[index] !== '\t') {
      throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
    }
  }
  let index = 0;
  const type = readToken(mediaType, index);
  if (type.value.length === 0 || mediaType[type.end] !== '/') {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
  }
  index = type.end + 1;
  const subtype = readToken(mediaType, index);
  if (subtype.value.length === 0) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
  }
  index = subtype.end;
  while (index < mediaType.length) {
    while (mediaType[index] === ' ' || mediaType[index] === '\t') index += 1;
    if (index >= mediaType.length) break;
    if (mediaType[index] !== ';') {
      throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
    }
    index += 1;
    while (mediaType[index] === ' ' || mediaType[index] === '\t') index += 1;
    const name = readToken(mediaType, index);
    if (name.value.length === 0) {
      throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
    }
    index = name.end;
    while (mediaType[index] === ' ' || mediaType[index] === '\t') index += 1;
    if (mediaType[index] !== '=') {
      throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
    }
    index += 1;
    while (mediaType[index] === ' ' || mediaType[index] === '\t') index += 1;
    if (mediaType[index] === '"') {
      index += 1;
      let closed = false;
      while (index < mediaType.length) {
        const character = mediaType[index];
        if (character === '"') {
          closed = true;
          index += 1;
          break;
        }
        if (character === '\\') {
          index += 1;
          if (index >= mediaType.length || isControl(mediaType[index])) {
            throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
          }
        } else if (isControl(character)) {
          throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
        }
        index += 1;
      }
      if (!closed) throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
    } else {
      const parameterValue = readToken(mediaType, index);
      if (parameterValue.value.length === 0) {
        throw exportError('EXPORT_SCHEMA_INVALID', 'Request media type is invalid');
      }
      index = parameterValue.end;
    }
  }
  const normalizedType = asciiLower(type.value);
  const normalizedSubtype = asciiLower(subtype.value);
  if (normalizedType !== 'application'
      || (normalizedSubtype !== 'json'
        && !(normalizedSubtype.length > 5 && stringEndsWith(normalizedSubtype, '+json')))) {
    throw exportError(
      'EXPORT_MEDIA_TYPE_UNSUPPORTED',
      'Collection export supports only JSON request bodies',
    );
  }
  return mediaType;
}

function requestBody(operation, manifest, budget) {
  if (operation.requestBody === null) return null;
  if (!arrayContains(BODY_METHODS, operation.method)) {
    throw exportError(
      'EXPORT_BODY_UNSUPPORTED',
      'Collection export does not support a request body for this method',
    );
  }
  if (!isPlainObject(operation.requestBody)) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request body definition is invalid');
  }
  const contentType = validateJsonMediaType(operation.requestBody.contentType);
  if (typeof operation.requestBody.schemaId !== 'string') {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request body schema is unresolved');
  }
  const record = isPlainObject(manifest?.schemas)
      && Object.hasOwn(manifest.schemas, operation.requestBody.schemaId)
    ? manifest.schemas[operation.requestBody.schemaId]
    : undefined;
  if (!isPlainObject(record) || !isPlainObject(record.schema)) {
    throw exportError('EXPORT_SCHEMA_INVALID', 'Request body schema is unresolved');
  }
  const value = sampleFromSchema(record.schema, budget.schema, record.schema);
  const content = JSON.stringify(sortJson(value));
  const bytes = Buffer.byteLength(content);
  if (bytes > MAX_BODY_BYTES) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Generated request body limit exceeded');
  }
  budget.bodyBytes += bytes;
  if (budget.bodyBytes > MAX_TOTAL_BODY_BYTES) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Global generated body limit exceeded');
  }
  return {
    value: sortJson(value),
    contentType,
  };
}

function addUniqueString(indexed, values, value) {
  if (Object.hasOwn(indexed, value)) return false;
  Object.defineProperty(indexed, value, { value: true, enumerable: true });
  append(values, value);
  return true;
}

function requestPathTemplate(path, variables, variableNames, pathVariables) {
  let result = '';
  for (let index = 0; index < path.length; index += 1) {
    if (path[index] !== '{') {
      result += path[index];
      continue;
    }
    const close = stringIndexOf(path, '}', index + 1);
    const name = stringRange(path, index + 1, close);
    addUniqueString(variables, variableNames, name);
    Object.defineProperty(pathVariables, name, { value: true, enumerable: true });
    result += `{{${name}}}`;
    index = close;
  }
  return result;
}

function requestShape(operation, manifest, secrets, budget) {
  const variableIndex = Object.create(null);
  const variables = [];
  const pathVariables = Object.create(null);
  let requestPath = requestPathTemplate(
    operation.path,
    variableIndex,
    variables,
    pathVariables,
  );
  const query = [];
  const headers = [];
  const parameters = Object.create(null);
  budget.parameters += operation.parameters.length;
  if (budget.parameters > MAX_TOTAL_PARAMETERS) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Global operation parameter limit exceeded');
  }
  for (let index = 0; index < operation.parameters.length; index += 1) {
    const parameter = operation.parameters[index];
    if (!isPlainObject(parameter)
        || !arrayContains(['path', 'query', 'header', 'cookie'], parameter.location)) {
      throw exportError('EXPORT_OPERATION_INVALID', 'Operation parameter is invalid');
    }
    const name = validateVariableName(parameter.name);
    const parameterKey = `${parameter.location}\0${name}`;
    if (!addUniqueString(parameters, [], parameterKey)) {
      throw exportError('EXPORT_OPERATION_INVALID', 'Operation parameters are ambiguous');
    }
    if (parameter.location === 'cookie') {
      throw exportError(
        'EXPORT_PARAMETER_UNSUPPORTED',
        'Collection export does not support cookie parameters',
      );
    }
    if (parameter.location === 'header'
        && arrayContains(RESERVED_HEADERS, asciiLower(name))) {
      throw exportError(
        'EXPORT_PARAMETER_UNSUPPORTED',
        'Collection export cannot safely represent a reserved header parameter',
      );
    }
    if (parameter.location === 'path' && !Object.hasOwn(pathVariables, name)) {
      throw exportError(
        'EXPORT_PARAMETER_UNSUPPORTED',
        'Collection export path parameter is absent from the path template',
      );
    }
    addUniqueString(variableIndex, variables, name);
    if (parameter.location === 'query') {
      append(query, `${encodeURIComponent(name)}={{${name}}}`);
    } else if (parameter.location === 'header') {
      append(headers, { name, value: `{{${name}}}` });
    }
  }
  for (let index = 0; index < variables.length; index += 1) {
    const name = variables[index];
    if (name === 'baseUrl' || arrayContains(secrets.names, name)) {
      throw exportError(
        'EXPORT_VARIABLE_COLLISION',
        'Operation parameter collides with a trusted collection variable',
      );
    }
  }
  const sortedQuery = sortedCopy(query, compareCodeUnits);
  if (sortedQuery.length > 0) requestPath += `?${joinStrings(sortedQuery, '&')}`;

  const roles = sortedCopy(operation.auth.allowedRoles, compareCodeUnits);
  let configuredRole;
  for (let index = 0; index < roles.length; index += 1) {
    if (Object.hasOwn(secrets.byRole, roles[index])) {
      configuredRole = roles[index];
      break;
    }
  }
  let authVariable = null;
  if (configuredRole !== undefined) {
    authVariable = secrets.byRole[configuredRole];
    append(headers, {
      name: 'Authorization',
      value: `Bearer {{${authVariable}}}`,
    });
  }
  const body = requestBody(operation, manifest, budget);
  if (body !== null) append(headers, { name: 'Content-Type', value: body.contentType });
  const sortedHeaders = sortedCopy(headers, (left, right) => (
    compareCodeUnits(left.name, right.name) || compareCodeUnits(left.value, right.value)
  ));
  return {
    id: operation.id,
    name: `${operation.method} ${operation.path}`,
    method: operation.method,
    url: `{{baseUrl}}${requestPath}`,
    headers: sortedHeaders,
    body,
    variables: sortedCopy(variables, compareCodeUnits),
    authVariable,
  };
}

function variablesFor(requests, origin, secrets, budget) {
  const parameterIndex = Object.create(null);
  const parameterNames = [];
  for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
    const names = requests[requestIndex].variables;
    for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
      addUniqueString(parameterIndex, parameterNames, names[nameIndex]);
    }
  }
  const sortedParameterNames = sortedCopy(parameterNames, compareCodeUnits);
  const variables = [{ key: 'baseUrl', value: origin }];
  for (let index = 0; index < secrets.names.length; index += 1) {
    append(variables, { key: secrets.names[index], value: '' });
  }
  for (let index = 0; index < sortedParameterNames.length; index += 1) {
    const name = sortedParameterNames[index];
    if (name !== 'baseUrl' && !arrayContains(secrets.names, name)) {
      append(variables, { key: name, value: '' });
    }
  }
  budget.variables = variables.length;
  if (budget.variables > MAX_TOTAL_VARIABLES) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Global collection variable limit exceeded');
  }
  return variables;
}

function validateArtifactPath(value) {
  if (typeof value !== 'string'
      || value.length === 0
      || value.length > 4096
      || value[0] === '/'
      || value[value.length - 1] === '/') {
    throw exportError('EXPORT_ARTIFACT_INVALID', 'Collection artifact path is unsafe');
  }
  let segmentStart = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index === value.length || value[index] === '/') {
      const segment = stringRange(value, segmentStart, index);
      if (segment.length === 0 || segment === '.' || segment === '..') {
        throw exportError('EXPORT_ARTIFACT_INVALID', 'Collection artifact path is unsafe');
      }
      segmentStart = index + 1;
      continue;
    }
    const character = value[index];
    const safe = (character >= 'A' && character <= 'Z')
      || (character >= 'a' && character <= 'z')
      || (character >= '0' && character <= '9')
      || character === '.'
      || character === '_'
      || character === '-';
    if (!safe) {
      throw exportError('EXPORT_ARTIFACT_INVALID', 'Collection artifact path is unsafe');
    }
  }
  return value;
}

function artifact(path, mediaType, content) {
  if (typeof mediaType !== 'string' || typeof content !== 'string') {
    throw exportError('EXPORT_ARTIFACT_INVALID', 'Collection artifact is invalid');
  }
  return { path: validateArtifactPath(path), mediaType, content };
}

function postmanArtifact(requests, variables) {
  const item = [];
  for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
    const request = requests[requestIndex];
    const header = [];
    for (let headerIndex = 0; headerIndex < request.headers.length; headerIndex += 1) {
      const source = request.headers[headerIndex];
      append(header, { key: source.name, value: source.value, type: 'text' });
    }
    const value = {
      name: request.name,
      request: {
        method: request.method,
        header,
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
    append(item, value);
  }
  const postmanVariables = [];
  for (let index = 0; index < variables.length; index += 1) {
    append(postmanVariables, {
      key: variables[index].key,
      value: variables[index].value,
      type: 'string',
    });
  }
  return artifact(
    'sentinel.postman_collection.json',
    'application/json',
    jsonText({
      info: {
        name: 'Sentinel export',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item,
      variable: postmanVariables,
    }),
  );
}

function shortHash(value) {
  const digest = createHash('sha256').update(value).digest('hex');
  return stringRange(digest, 0, 12);
}

function insomniaArtifact(requests, variables) {
  const workspaceId = `wrk_${shortHash('sentinel-export')}`;
  const environmentId = `env_${shortHash('sentinel-export-environment')}`;
  const data = {};
  for (let index = 0; index < variables.length; index += 1) {
    Object.defineProperty(data, variables[index].key, {
      configurable: true,
      enumerable: true,
      value: variables[index].value,
      writable: true,
    });
  }
  const resources = [{
    _id: workspaceId,
    _type: 'workspace',
    name: 'Sentinel export',
    description: 'Inert requests generated from the Sentinel request contract',
    scope: 'collection',
  }, {
    _id: environmentId,
    _type: 'environment',
    parentId: workspaceId,
    name: 'Base environment',
    data,
  }];
  for (let requestIndex = 0; requestIndex < requests.length; requestIndex += 1) {
    const request = requests[requestIndex];
    const headers = [];
    for (let headerIndex = 0; headerIndex < request.headers.length; headerIndex += 1) {
      const header = request.headers[headerIndex];
      append(headers, { name: header.name, value: header.value });
    }
      const value = {
        _id: `req_${shortHash(request.id)}`,
        _type: 'request',
        parentId: workspaceId,
        name: request.name,
        method: request.method,
        url: request.url,
        headers,
      };
      if (request.body !== null) {
        value.body = {
          mimeType: request.body.contentType,
          text: JSON.stringify(request.body.value, null, 2),
        };
      }
    append(resources, value);
  }
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
  const prefix = '{{baseUrl}}';
  const requestTarget = stringStartsWith(request.url, prefix)
    ? stringRange(request.url, prefix.length)
    : request.url;
  const raw = `${request.method}-${requestTarget}`;
  let slug = '';
  let pendingSeparator = false;
  for (let rawIndex = 0; rawIndex < raw.length && slug.length < 72; rawIndex += 1) {
    const character = asciiLower(raw[rawIndex]);
    const alphanumeric = (character >= 'a' && character <= 'z')
      || (character >= '0' && character <= '9');
    if (!alphanumeric) {
      if (slug.length > 0) pendingSeparator = true;
      continue;
    }
    if (pendingSeparator && slug.length < 72) slug += '-';
    pendingSeparator = false;
    if (slug.length < 72) slug += character;
  }
  if (slug.length === 0) slug = 'request';
  let sequence = String(index + 1);
  while (sequence.length < 3) sequence = `0${sequence}`;
  return `${sequence}-${slug}-${shortHash(request.id)}`;
}

function requireBrunoScalar(value) {
  if (typeof value !== 'string') {
    throw exportError('EXPORT_SCALAR_INVALID', 'Bruno scalar contains a line delimiter');
  }
  for (let index = 0; index < value.length; index += 1) {
    if (isControl(value[index])) {
      throw exportError('EXPORT_SCALAR_INVALID', 'Bruno scalar contains a line delimiter');
    }
  }
  return value;
}

function brunoEnvironment(variables) {
  let result = 'vars {';
  for (let index = 0; index < variables.length; index += 1) {
    const entry = variables[index];
    result += `\n  ${requireBrunoScalar(entry.key)}: ${requireBrunoScalar(entry.value)}`;
  }
  return `${result}\n}\n`;
}

function brunoRequest(request, index) {
  const method = asciiLower(request.method);
  const authMode = request.authVariable === null ? 'none' : 'bearer';
  let output = 'meta {'
    + `\n  name: ${requireBrunoScalar(request.name)}`
    + '\n  type: http'
    + `\n  seq: ${index + 1}`
    + `\n}\n\n${method} {`
    + `\n  url: ${requireBrunoScalar(request.url)}`;
  if (request.body !== null) output += '\n  body: json';
  output += `\n  auth: ${authMode}\n}`;
  let emittedHeaders = 0;
  for (let index = 0; index < request.headers.length; index += 1) {
    if (request.headers[index].name !== 'Authorization') emittedHeaders += 1;
  }
  if (emittedHeaders > 0) {
    output += '\n\nheaders {';
    for (let index = 0; index < request.headers.length; index += 1) {
      const header = request.headers[index];
      if (header.name === 'Authorization') continue;
      output += `\n  ${requireBrunoScalar(header.name)}: ${requireBrunoScalar(header.value)}`;
    }
    output += '\n}';
  }
  if (request.authVariable !== null) {
    output += `\n\nauth:bearer {\n  token: {{${requireBrunoScalar(request.authVariable)}}}\n}`;
  }
  if (request.body !== null) {
    output += `\n\nbody:json {\n${JSON.stringify(request.body.value, null, 2)}\n}`;
  }
  return `${output}\n`;
}

function brunoArtifacts(requests, variables) {
  const artifacts = [
    artifact('bruno.json', 'application/json', jsonText({
      version: '1',
      name: 'Sentinel export',
      type: 'collection',
      ignore: ['node_modules', '.git'],
    })),
    artifact('environments/sentinel.bru', 'text/plain', brunoEnvironment(variables)),
  ];
  for (let index = 0; index < requests.length; index += 1) {
    append(artifacts, artifact(
      `requests/${brunoSlug(requests[index], index)}.bru`,
      'text/plain',
      brunoRequest(requests[index], index),
    ));
  }
  return artifacts;
}

/** Returns inert collection files; this function never writes or resolves a secret. */
export function exportCollection(options = {}) {
  const { format, manifest, config } = snapshotExportOptions(options);
  if (!arrayContains(FORMATS, format)) {
    throw exportError('EXPORT_FORMAT_UNSUPPORTED', 'Collection export format is unsupported');
  }
  const operations = validateOperations(manifest);
  validateManifest(manifest);
  validateConfig(config);
  const origin = validateOrigin(config);
  const secrets = roleVariables(config);
  const budget = {
    bodyBytes: 0,
    parameters: 0,
    variables: 0,
    schema: {
      registry: manifest.schemas,
      active: new WeakMap(),
      memo: new WeakMap(),
      work: 0,
    },
  };
  const requests = [];
  for (let index = 0; index < operations.length; index += 1) {
    append(requests, requestShape(operations[index], manifest, secrets, budget));
  }
  const variables = variablesFor(requests, origin, secrets, budget);
  let artifacts;
  if (format === 'postman') artifacts = [postmanArtifact(requests, variables)];
  else if (format === 'insomnia') artifacts = [insomniaArtifact(requests, variables)];
  else artifacts = brunoArtifacts(requests, variables);
  if (artifacts.length > MAX_ARTIFACTS) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Collection artifact limit exceeded');
  }
  const artifactPaths = Object.create(null);
  let artifactBytes = 0;
  for (let index = 0; index < artifacts.length; index += 1) {
    const entry = artifacts[index];
    validateArtifactPath(entry.path);
    if (Object.hasOwn(artifactPaths, entry.path)) {
      throw exportError('EXPORT_ARTIFACT_INVALID', 'Collection artifact paths are not unique');
    }
    Object.defineProperty(artifactPaths, entry.path, { value: true, enumerable: true });
    artifactBytes += Buffer.byteLength(entry.path)
      + Buffer.byteLength(entry.mediaType)
      + Buffer.byteLength(entry.content);
  }
  if (artifactBytes > MAX_TOTAL_ARTIFACT_BYTES) {
    throw exportError('EXPORT_LIMIT_EXCEEDED', 'Global collection artifact limit exceeded');
  }
  return deepFreeze(artifacts);
}
