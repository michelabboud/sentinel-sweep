import path from 'node:path';

import { SentinelError } from '../lib/errors.mjs';
import {
  MAX_DISCOVERY_INPUT_BYTES,
  MAX_VUE_LITERAL_DEPTH,
} from './limits.mjs';

const IDENTIFIER_START = /[A-Za-z_$]/u;
const IDENTIFIER_PART = /[A-Za-z0-9_$]/u;
const PARAMETER_START = /[A-Za-z_]/u;
const PARAMETER_PART = /[A-Za-z0-9_]/u;
const SOURCE_EXTENSIONS = new Set(['.js', '.ts']);

function discoveryError(code, message, details = {}) {
  return new SentinelError(code, message, details);
}

function pointerSegment(value) {
  return String(value).replaceAll('~', '~0').replaceAll('/', '~1');
}

function appendPointer(pointer, value) {
  return `${pointer}/${pointerSegment(value)}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertRelativeSourcePaths(relativePaths) {
  if (!Array.isArray(relativePaths)
      || relativePaths.length === 0
      || relativePaths.some((relativePath) => (
        typeof relativePath !== 'string'
        || relativePath.length === 0
        || relativePath.includes('\0')
        || path.posix.isAbsolute(relativePath)
        || path.win32.isAbsolute(relativePath)
        || relativePath.startsWith('//')
        || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(relativePath)
        || !SOURCE_EXTENSIONS.has(path.extname(relativePath).toLowerCase())
      ))) {
    throw discoveryError(
      'VUE_PATH_INVALID',
      'Vue Router inputs must be explicit relative JavaScript or TypeScript paths',
    );
  }
}

function decodeEscape(source, slashIndex) {
  const marker = source[slashIndex + 1];
  if (marker === undefined) return { value: '', next: source.length, valid: false };
  const simple = {
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    0: '\0',
  };
  if (Object.hasOwn(simple, marker)) {
    if (marker === '0' && /[0-9]/u.test(source[slashIndex + 2] ?? '')) {
      return { value: '', next: slashIndex + 2, valid: false };
    }
    return { value: simple[marker], next: slashIndex + 2, valid: true };
  }
  if (marker === '\n') return { value: '', next: slashIndex + 2, valid: true };
  if (marker === '\r') {
    return {
      value: '',
      next: source[slashIndex + 2] === '\n' ? slashIndex + 3 : slashIndex + 2,
      valid: true,
    };
  }
  if (marker === 'x') {
    const digits = source.slice(slashIndex + 2, slashIndex + 4);
    if (!/^[0-9A-Fa-f]{2}$/u.test(digits)) {
      return { value: '', next: slashIndex + 2, valid: false };
    }
    return { value: String.fromCodePoint(Number.parseInt(digits, 16)), next: slashIndex + 4, valid: true };
  }
  if (marker === 'u') {
    if (source[slashIndex + 2] === '{') {
      const close = source.indexOf('}', slashIndex + 3);
      const digits = close === -1 ? '' : source.slice(slashIndex + 3, close);
      const codePoint = /^[0-9A-Fa-f]{1,6}$/u.test(digits)
        ? Number.parseInt(digits, 16)
        : Number.NaN;
      if (!Number.isInteger(codePoint) || codePoint > 0x10FFFF) {
        return { value: '', next: slashIndex + 2, valid: false };
      }
      return { value: String.fromCodePoint(codePoint), next: close + 1, valid: true };
    }
    const digits = source.slice(slashIndex + 2, slashIndex + 6);
    if (!/^[0-9A-Fa-f]{4}$/u.test(digits)) {
      return { value: '', next: slashIndex + 2, valid: false };
    }
    return { value: String.fromCodePoint(Number.parseInt(digits, 16)), next: slashIndex + 6, valid: true };
  }
  return { value: marker, next: slashIndex + 2, valid: true };
}

function scanQuoted(source, start, quote) {
  let value = '';
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === quote) {
      return { end: index + 1, value, valid: true };
    }
    if (character === '\n' || character === '\r') {
      return { end: index + 1, value: null, valid: false };
    }
    if (character === '\\') {
      const decoded = decodeEscape(source, index);
      if (!decoded.valid) return { end: decoded.next, value: null, valid: false };
      value += decoded.value;
      index = decoded.next;
      continue;
    }
    value += character;
    index += 1;
  }
  return { end: source.length, value: null, valid: false };
}

function skipBlockComment(source, start) {
  const close = source.indexOf('*/', start + 2);
  return close === -1 ? source.length : close + 2;
}

function skipLineComment(source, start) {
  const close = source.indexOf('\n', start + 2);
  return close === -1 ? source.length : close + 1;
}

function scanTemplateExpression(source, start) {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    const character = source[index];
    if (character === "'" || character === '"') {
      index = scanQuoted(source, index, character).end;
      continue;
    }
    if (character === '`') {
      index = scanTemplate(source, index).end;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index = skipBlockComment(source, index);
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return { end: index + 1, valid: true };
    }
    index += 1;
  }
  return { end: source.length, valid: false };
}

function scanTemplate(source, start) {
  let value = '';
  let interpolated = false;
  let valid = true;
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '`') {
      return {
        end: index + 1,
        value: interpolated ? null : value,
        interpolated,
        valid,
      };
    }
    if (character === '\\') {
      const decoded = decodeEscape(source, index);
      valid &&= decoded.valid;
      if (!interpolated && decoded.valid) value += decoded.value;
      index = decoded.next;
      continue;
    }
    if (character === '$' && source[index + 1] === '{') {
      interpolated = true;
      const expression = scanTemplateExpression(source, index + 2);
      valid &&= expression.valid;
      index = expression.end;
      continue;
    }
    if (!interpolated) value += character;
    index += 1;
  }
  return { end: source.length, value: null, interpolated, valid: false };
}

function readNumber(source, start) {
  const rest = source.slice(start);
  const match = /^(?:0[xX][0-9A-Fa-f](?:_?[0-9A-Fa-f])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|(?:[0-9](?:_?[0-9])*(?:\.(?:[0-9](?:_?[0-9])*)?)?|\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?)/u.exec(rest);
  if (match === null) return null;
  const raw = match[0];
  return { end: start + raw.length, value: Number(raw.replaceAll('_', '')) };
}

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      index = skipLineComment(source, index);
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      const end = skipBlockComment(source, index);
      if (end === source.length && !source.endsWith('*/')) {
        tokens.push({ type: 'invalid', value: 'unterminated-comment', start: index, end });
      }
      index = end;
      continue;
    }
    if (character === "'" || character === '"') {
      const quoted = scanQuoted(source, index, character);
      tokens.push({
        type: quoted.valid ? 'string' : 'invalid',
        value: quoted.value,
        start: index,
        end: quoted.end,
      });
      index = quoted.end;
      continue;
    }
    if (character === '`') {
      const template = scanTemplate(source, index);
      tokens.push({
        type: !template.valid
          ? 'invalid'
          : template.interpolated ? 'interpolated-template' : 'string',
        value: template.value,
        start: index,
        end: template.end,
      });
      index = template.end;
      continue;
    }
    if (IDENTIFIER_START.test(character)) {
      let end = index + 1;
      while (end < source.length && IDENTIFIER_PART.test(source[end])) end += 1;
      tokens.push({ type: 'identifier', value: source.slice(index, end), start: index, end });
      index = end;
      continue;
    }
    if (/[0-9]/u.test(character) || (character === '.' && /[0-9]/u.test(source[index + 1] ?? ''))) {
      const number = readNumber(source, index);
      if (number !== null) {
        tokens.push({ type: 'number', value: number.value, start: index, end: number.end });
        index = number.end;
        continue;
      }
    }
    if (source.startsWith('...', index)) {
      tokens.push({ type: 'punctuation', value: '...', start: index, end: index + 3 });
      index += 3;
      continue;
    }
    tokens.push({ type: 'punctuation', value: character, start: index, end: index + 1 });
    index += 1;
  }
  return tokens;
}

function addGap(state, kind, file, pointer, details = {}) {
  const gap = `${kind}:${file}#${pointer}`;
  if (!state.gaps.has(gap)) state.gaps.set(gap, { kind, file, pointer, ...details });
}

function gapKind(pointer) {
  return pointer.endsWith('/path') ? 'computed-path' : 'unsupported-expression';
}

function skipExpression(tokens, start, terminators) {
  const closes = { '(': ')', '[': ']', '{': '}' };
  const stack = [];
  let index = start;
  while (index < tokens.length) {
    const value = tokens[index].value;
    if (stack.length === 0 && terminators.has(value)) break;
    if (Object.hasOwn(closes, value)) {
      stack.push(closes[value]);
    } else if (stack.at(-1) === value) {
      stack.pop();
    }
    index += 1;
  }
  return index;
}

class LiteralParser {
  constructor(tokens, state, file) {
    this.tokens = tokens;
    this.state = state;
    this.file = file;
  }

  finishScalar(node, next, pointer, terminators) {
    if (this.tokens[next] !== undefined && terminators.has(this.tokens[next].value)) {
      return { node, next };
    }
    addGap(this.state, gapKind(pointer), this.file, pointer);
    return {
      node: { kind: 'unsupported', pointer },
      next: skipExpression(this.tokens, next, terminators),
    };
  }

  parseValue(index, pointer, terminators = new Set([',', '}', ']']), depth = 0) {
    const token = this.tokens[index];
    if (token === undefined) {
      addGap(this.state, 'unterminated-expression', this.file, pointer);
      return { node: { kind: 'unsupported', pointer }, next: index };
    }
    if (token.type === 'string') {
      return this.finishScalar(
        { kind: 'string', value: token.value, pointer },
        index + 1,
        pointer,
        terminators,
      );
    }
    if (token.type === 'interpolated-template') {
      addGap(this.state, 'interpolated-template', this.file, pointer);
      return { node: { kind: 'unsupported', pointer }, next: index + 1 };
    }
    if (token.type === 'number') {
      return this.finishScalar(
        { kind: 'number', value: token.value, pointer },
        index + 1,
        pointer,
        terminators,
      );
    }
    if (token.type === 'identifier' && (token.value === 'true' || token.value === 'false')) {
      return this.finishScalar(
        { kind: 'boolean', value: token.value === 'true', pointer },
        index + 1,
        pointer,
        terminators,
      );
    }
    if (token.type === 'identifier' && token.value === 'null') {
      return this.finishScalar(
        { kind: 'null', value: null, pointer },
        index + 1,
        pointer,
        terminators,
      );
    }
    if (token.value === '-' && this.tokens[index + 1]?.type === 'number') {
      return this.finishScalar(
        { kind: 'number', value: -this.tokens[index + 1].value, pointer },
        index + 2,
        pointer,
        terminators,
      );
    }
    if (token.value === '{' || token.value === '[') {
      if (depth >= MAX_VUE_LITERAL_DEPTH) {
        addGap(this.state, 'depth-limit', this.file, pointer, {
          limit: MAX_VUE_LITERAL_DEPTH,
        });
        return {
          node: { kind: 'unsupported', pointer },
          next: skipExpression(this.tokens, index, terminators),
        };
      }
      return token.value === '{'
        ? this.parseObject(index, pointer, depth + 1)
        : this.parseArray(index, pointer, depth + 1);
    }

    const kind = token.type === 'invalid' ? 'invalid-literal' : gapKind(pointer);
    addGap(this.state, kind, this.file, pointer);
    return {
      node: { kind: 'unsupported', pointer },
      next: skipExpression(this.tokens, index, terminators),
    };
  }

  parseArray(index, pointer, depth = 1) {
    const items = [];
    let itemIndex = 0;
    let cursor = index + 1;
    while (cursor < this.tokens.length && this.tokens[cursor].value !== ']') {
      if (this.tokens[cursor].value === ',') {
        cursor += 1;
        continue;
      }
      const itemPointer = appendPointer(pointer, itemIndex);
      if (this.tokens[cursor].value === '...') {
        addGap(this.state, 'spread', this.file, itemPointer);
        cursor = skipExpression(this.tokens, cursor + 1, new Set([',', ']']));
        items.push({ kind: 'unsupported', pointer: itemPointer });
      } else {
        const parsed = this.parseValue(cursor, itemPointer, new Set([',', ']']), depth);
        items.push(parsed.node);
        cursor = parsed.next;
      }
      itemIndex += 1;
      if (this.tokens[cursor]?.value === ',') cursor += 1;
    }
    if (this.tokens[cursor]?.value !== ']') {
      addGap(this.state, 'unterminated-array', this.file, pointer);
      return { node: { kind: 'array', items, pointer }, next: cursor };
    }
    return { node: { kind: 'array', items, pointer }, next: cursor + 1 };
  }

  parseObject(index, pointer, depth = 1) {
    const entries = new Map();
    let cursor = index + 1;
    while (cursor < this.tokens.length && this.tokens[cursor].value !== '}') {
      if (this.tokens[cursor].value === ',') {
        cursor += 1;
        continue;
      }
      if (this.tokens[cursor].value === '...') {
        const spreadPointer = appendPointer(pointer, '<spread>');
        addGap(this.state, 'spread', this.file, spreadPointer);
        cursor = skipExpression(this.tokens, cursor + 1, new Set([',', '}']));
        if (this.tokens[cursor]?.value === ',') cursor += 1;
        continue;
      }

      const keyToken = this.tokens[cursor];
      if (keyToken.value === '[') {
        addGap(this.state, 'computed-property', this.file, pointer);
        cursor = skipExpression(this.tokens, cursor, new Set([',', '}']));
        if (this.tokens[cursor]?.value === ',') cursor += 1;
        continue;
      }
      if (keyToken.type !== 'identifier' && keyToken.type !== 'string') {
        addGap(this.state, 'invalid-property', this.file, pointer);
        cursor = skipExpression(this.tokens, cursor, new Set([',', '}']));
        if (this.tokens[cursor]?.value === ',') cursor += 1;
        continue;
      }

      const key = keyToken.value;
      const propertyPointer = appendPointer(pointer, key);
      cursor += 1;
      if (this.tokens[cursor]?.value !== ':') {
        addGap(this.state, 'unsupported-expression', this.file, propertyPointer);
        entries.set(key, { kind: 'unsupported', pointer: propertyPointer });
        cursor = skipExpression(this.tokens, cursor, new Set([',', '}']));
      } else {
        const parsed = this.parseValue(
          cursor + 1,
          propertyPointer,
          new Set([',', '}']),
          depth,
        );
        entries.set(key, parsed.node);
        cursor = parsed.next;
      }
      if (this.tokens[cursor]?.value === ',') cursor += 1;
    }
    if (this.tokens[cursor]?.value !== '}') {
      addGap(this.state, 'unterminated-object', this.file, pointer);
      return { node: { kind: 'object', entries, pointer }, next: cursor };
    }
    return { node: { kind: 'object', entries, pointer }, next: cursor + 1 };
  }
}

function collectImportedNames(tokens) {
  const names = new Set();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'identifier' || tokens[index].value !== 'import') continue;
    let cursor = index + 1;
    while (cursor < tokens.length && tokens[cursor].value !== ';') {
      if (tokens[cursor].type === 'string') break;
      if (tokens[cursor].type === 'identifier'
          && !['from', 'as', 'type'].includes(tokens[cursor].value)) {
        names.add(tokens[cursor].value);
      }
      cursor += 1;
    }
    index = cursor;
  }
  return names;
}

function findClosing(tokens, start, opening, closing) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index].value === opening) depth += 1;
    if (tokens[index].value === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function declarationAssignment(tokens, index) {
  let cursor = index + 1;
  if (tokens[cursor]?.value === ':') {
    cursor += 1;
    const stack = [];
    const closes = { '(': ')', '[': ']', '{': '}', '<': '>' };
    while (cursor < tokens.length) {
      const value = tokens[cursor].value;
      if (stack.length === 0 && (value === '=' || value === ';')) break;
      if (Object.hasOwn(closes, value)) stack.push(closes[value]);
      else if (stack.at(-1) === value) stack.pop();
      cursor += 1;
    }
  }
  return tokens[cursor]?.value === '=' ? cursor : -1;
}

function routeAssignments(tokens, parser, state, file, importedNames) {
  const arrays = [];
  const localLiteralRoutes = new Set();
  let assignmentIndex = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== 'identifier' || tokens[index].value !== 'routes') continue;
    const equals = declarationAssignment(tokens, index);
    if (equals === -1) continue;
    const pointer = assignmentIndex === 0 ? '/routes' : `/routes/${assignmentIndex}`;
    assignmentIndex += 1;
    const value = tokens[equals + 1];
    if (value?.value === '[') {
      const parsed = parser.parseArray(equals + 1, pointer);
      arrays.push(parsed.node);
      localLiteralRoutes.add('routes');
      index = parsed.next - 1;
    } else {
      const kind = value?.type === 'identifier' && importedNames.has(value.value)
        ? 'imported-routes'
        : 'dynamic-routes';
      addGap(state, kind, file, pointer);
    }
  }
  return { arrays, localLiteralRoutes };
}

function directObjectDepth(tokens, objectStart, index) {
  let depth = 0;
  const opens = new Set(['{', '[', '(']);
  const closes = new Set(['}', ']', ')']);
  for (let cursor = objectStart + 1; cursor < index; cursor += 1) {
    if (opens.has(tokens[cursor].value)) depth += 1;
    else if (closes.has(tokens[cursor].value)) depth -= 1;
  }
  return depth;
}

function createRouterArrays(tokens, parser, state, file, importedNames, localLiteralRoutes) {
  const arrays = [];
  let callIndex = 0;
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (tokens[index].type !== 'identifier'
        || tokens[index].value !== 'createRouter'
        || tokens[index + 1].value !== '(') continue;
    const currentCall = callIndex;
    callIndex += 1;
    const callEnd = findClosing(tokens, index + 1, '(', ')');
    const objectStart = index + 2;
    if (callEnd === -1 || tokens[objectStart]?.value !== '{') {
      addGap(state, 'dynamic-router-config', file, `/createRouter/${currentCall}`);
      continue;
    }
    const objectEnd = findClosing(tokens, objectStart, '{', '}');
    if (objectEnd === -1 || objectEnd > callEnd) {
      addGap(state, 'dynamic-router-config', file, `/createRouter/${currentCall}`);
      continue;
    }
    for (let cursor = objectStart + 1; cursor < objectEnd; cursor += 1) {
      if (directObjectDepth(tokens, objectStart, cursor) !== 0) continue;
      const token = tokens[cursor];
      if ((token.type !== 'identifier' && token.type !== 'string') || token.value !== 'routes') {
        continue;
      }
      const pointer = `/createRouter/${currentCall}/routes`;
      if (tokens[cursor + 1]?.value === ':') {
        const value = tokens[cursor + 2];
        if (value?.value === '[') {
          arrays.push(parser.parseArray(cursor + 2, pointer).node);
        } else if (value?.type === 'identifier' && localLiteralRoutes.has(value.value)) {
          // The named literal was collected from its assignment.
        } else if (value?.type === 'identifier' && importedNames.has(value.value)) {
          addGap(state, 'imported-routes', file, pointer);
        } else {
          addGap(state, 'dynamic-routes', file, pointer);
        }
      } else if (localLiteralRoutes.has('routes')) {
        // Object shorthand references the already collected local literal.
      } else if (importedNames.has('routes')) {
        addGap(state, 'imported-routes', file, pointer);
      } else {
        addGap(state, 'dynamic-routes', file, pointer);
      }
    }
    index = callEnd;
  }
  return arrays;
}

function normalizeSlashes(value) {
  let normalized = value.replace(/\/{2,}/gu, '/');
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/u, '');
  return normalized;
}

function joinPath(parentPath, childPath) {
  if (childPath.includes('\0')
      || childPath.startsWith('//')
      || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(childPath)
      || childPath.includes('#')) return null;
  if (childPath === '') return parentPath || '/';
  if (childPath.startsWith('/')) return normalizeSlashes(childPath);
  return normalizeSlashes(`${parentPath || ''}/${childPath}`);
}

function parameterizedPath(value) {
  let normalized = '';
  const parameters = new Map();
  let index = 0;
  while (index < value.length) {
    if (value[index] !== ':' || !PARAMETER_START.test(value[index + 1] ?? '')) {
      normalized += value[index];
      index += 1;
      continue;
    }
    let cursor = index + 2;
    while (cursor < value.length && PARAMETER_PART.test(value[cursor])) cursor += 1;
    const name = value.slice(index + 1, cursor);
    if (value[cursor] === '(') {
      let depth = 1;
      cursor += 1;
      while (cursor < value.length && depth > 0) {
        if (value[cursor] === '\\') {
          cursor += 2;
          continue;
        }
        if (value[cursor] === '(') depth += 1;
        if (value[cursor] === ')') depth -= 1;
        cursor += 1;
      }
      if (depth !== 0) return null;
    }
    const modifier = ['?', '+', '*'].includes(value[cursor]) ? value[cursor] : '';
    if (modifier !== '') cursor += 1;
    const required = modifier !== '?' && modifier !== '*';
    const existing = parameters.get(name);
    parameters.set(name, existing === undefined ? required : existing || required);
    normalized += `{${name}}`;
    index = cursor;
  }
  if (normalized.includes('?')) return null;
  return {
    path: normalized,
    parameters: [...parameters.entries()].map(([name, required]) => ({
      name,
      location: 'path',
      required,
      schema: { type: 'string' },
    })),
  };
}

function metaRoleEvidence(meta) {
  for (const key of ['role', 'roles', 'allowedRoles']) {
    const node = meta.get(key);
    if (node?.kind === 'string' && node.value.length > 0) return true;
    if (node?.kind === 'array'
        && node.items.some((item) => item.kind === 'string' && item.value.length > 0)) {
      return true;
    }
  }
  return false;
}

function routeAuth(route, inherited) {
  const meta = route.get('meta');
  if (meta?.kind !== 'object') return { state: inherited, allowedRoles: [] };
  const requiresAuth = meta.entries.get('requiresAuth');
  const explicitlyPublic = meta.entries.get('public');
  if (requiresAuth?.kind === 'boolean' && requiresAuth.value === true) {
    return { state: 'required', allowedRoles: [] };
  }
  if (metaRoleEvidence(meta.entries)) return { state: 'required', allowedRoles: [] };
  if ((requiresAuth?.kind === 'boolean' && requiresAuth.value === false)
      || (explicitlyPublic?.kind === 'boolean' && explicitlyPublic.value === true)) {
    return { state: 'public', allowedRoles: [] };
  }
  return { state: inherited, allowedRoles: [] };
}

function collectAliasNodes(route) {
  const nodes = [];
  for (const key of ['alias', 'aliases']) {
    const node = route.get(key);
    if (node === undefined) continue;
    if (node.kind === 'array') nodes.push(...node.items);
    else nodes.push(node);
  }
  return nodes;
}

function normalizeAliases(route, parentPath, routePath, state, file) {
  const aliases = new Set();
  for (const node of collectAliasNodes(route)) {
    if (node.kind === 'unsupported') continue;
    if (node.kind !== 'string') {
      addGap(state, 'invalid-alias', file, node.pointer);
      continue;
    }
    const joined = joinPath(parentPath, node.value);
    const normalized = joined === null ? null : parameterizedPath(joined);
    if (normalized === null) {
      addGap(state, 'invalid-alias', file, node.pointer);
      continue;
    }
    if (normalized.path !== routePath) aliases.add(normalized.path);
  }
  return [...aliases].sort(compareText);
}

function optionalRecordString(node, state, file) {
  if (node === undefined || node.kind === 'null' || node.kind === 'unsupported') return null;
  if (node.kind === 'string') return node.value;
  addGap(state, 'invalid-route-field', file, node.pointer);
  return null;
}

function mergeEmptyChildRoute(parent, child) {
  return {
    ...child,
    aliases: [...new Set([...parent.aliases, ...child.aliases])].sort(compareText),
  };
}

function collectRouteRecords(
  array,
  parentPath,
  inheritedAuth,
  state,
  file,
  records,
  parentRecord = null,
) {
  for (const routeNode of array.items) {
    if (routeNode.kind === 'unsupported') continue;
    if (routeNode.kind !== 'object') {
      addGap(state, 'invalid-route', file, routeNode.pointer);
      continue;
    }
    const route = routeNode.entries;
    const pathNode = route.get('path');
    if (pathNode === undefined) {
      addGap(state, 'missing-path', file, appendPointer(routeNode.pointer, 'path'));
      continue;
    }
    if (pathNode.kind === 'unsupported') continue;
    if (pathNode.kind !== 'string') {
      addGap(state, 'invalid-path', file, pathNode.pointer);
      continue;
    }
    const joined = joinPath(parentPath, pathNode.value);
    const normalized = joined === null ? null : parameterizedPath(joined);
    if (normalized === null) {
      addGap(state, 'invalid-path', file, pathNode.pointer);
      continue;
    }
    const auth = routeAuth(route, inheritedAuth);
    const record = {
      id: `route:${normalized.path}`,
      path: normalized.path,
      name: optionalRecordString(route.get('name'), state, file),
      component: optionalRecordString(route.get('component'), state, file),
      aliases: normalizeAliases(route, parentPath, normalized.path, state, file),
      auth,
      parameters: normalized.parameters,
      provenance: {
        adapter: 'vue-router-static',
        file,
        pointer: routeNode.pointer,
      },
    };
    let emittedRecord = record;
    if (pathNode.value === ''
        && parentRecord !== null
        && parentRecord.path === record.path) {
      const parentIndex = records.indexOf(parentRecord);
      if (parentIndex === -1) {
        records.push(record);
      } else {
        emittedRecord = mergeEmptyChildRoute(parentRecord, record);
        records[parentIndex] = emittedRecord;
      }
    } else {
      records.push(record);
    }

    const children = route.get('children');
    if (children?.kind === 'array') {
      collectRouteRecords(
        children,
        normalized.path,
        auth.state,
        state,
        file,
        records,
        emittedRecord,
      );
    } else if (children !== undefined && children.kind !== 'unsupported' && children.kind !== 'null') {
      addGap(state, 'invalid-children', file, children.pointer);
    }
  }
}

function semanticRoute(route) {
  const { provenance: _provenance, ...semantic } = route;
  return JSON.stringify(semantic);
}

function stableRoutes(records, state) {
  const unique = new Map();
  for (const route of records) {
    const key = semanticRoute(route);
    const existing = unique.get(key);
    if (existing === undefined
        || compareText(JSON.stringify(route.provenance), JSON.stringify(existing.provenance)) < 0) {
      unique.set(key, route);
    }
  }
  const byPath = new Map();
  for (const route of unique.values()) {
    const candidates = byPath.get(route.path) ?? [];
    candidates.push(route);
    byPath.set(route.path, candidates);
  }

  const resolved = [];
  for (const candidates of byPath.values()) {
    candidates.sort((left, right) => (
      compareText(JSON.stringify(left.provenance), JSON.stringify(right.provenance))
      || compareText(semanticRoute(left), semanticRoute(right))
    ));
    resolved.push(candidates[0]);
    for (const conflict of candidates.slice(1)) {
      addGap(
        state,
        'route-conflict',
        conflict.provenance.file,
        conflict.provenance.pointer,
      );
    }
  }
  return resolved.sort((left, right) => (
    compareText(left.path, right.path)
    || compareText(semanticRoute(left), semanticRoute(right))
    || compareText(JSON.stringify(left.provenance), JSON.stringify(right.provenance))
  ));
}

function parseRouterSource(source, file, state) {
  const tokens = tokenize(source);
  const parser = new LiteralParser(tokens, state, file);
  const importedNames = collectImportedNames(tokens);
  const assignments = routeAssignments(tokens, parser, state, file, importedNames);
  const arrays = [
    ...assignments.arrays,
    ...createRouterArrays(
      tokens,
      parser,
      state,
      file,
      importedNames,
      assignments.localLiteralRoutes,
    ),
  ];
  if (arrays.length === 0) addGap(state, 'routes-not-found', file, '/');
  return arrays;
}

function diagnosticForGap(gap) {
  if (gap.kind === 'size-limit') {
    return {
      code: 'VUE_SIZE_LIMIT',
      message: `Vue Router discovery input ${gap.file} exceeds the ${gap.limit}-byte limit`,
      sourcePath: gap.file,
      pointer: gap.pointer,
    };
  }
  if (gap.kind === 'depth-limit') {
    return {
      code: 'VUE_DEPTH_LIMIT',
      message: `Vue Router discovery input ${gap.file} exceeds the literal nesting limit of ${gap.limit}`,
      sourcePath: gap.file,
      pointer: gap.pointer,
    };
  }
  return {
    code: `VUE_${gap.kind.replaceAll('-', '_').toUpperCase()}`,
    message: `Vue Router discovery encountered unsupported ${gap.kind.replaceAll('-', ' ')}`,
    sourcePath: gap.file,
    pointer: gap.pointer,
  };
}

export async function discoverVueRouter({ boundary, relativePaths } = {}) {
  assertRelativeSourcePaths(relativePaths);
  if (boundary === null || typeof boundary !== 'object' || typeof boundary.readText !== 'function') {
    throw discoveryError('VUE_BOUNDARY_INVALID', 'A TargetBoundary is required');
  }

  const state = { gaps: new Map() };
  const records = [];
  for (const relativePath of [...new Set(relativePaths)].sort(compareText)) {
    let source;
    try {
      source = await boundary.readText(relativePath, { maxBytes: MAX_DISCOVERY_INPUT_BYTES });
    } catch (error) {
      if (!(error instanceof SentinelError) || error.code !== 'INPUT_SIZE_LIMIT') throw error;
      addGap(state, 'size-limit', relativePath, '/', {
        limit: MAX_DISCOVERY_INPUT_BYTES,
      });
      continue;
    }
    const arrays = parseRouterSource(source, relativePath, state);
    for (const array of arrays) {
      collectRouteRecords(array, '', 'unknown', state, relativePath, records);
    }
  }

  const routes = stableRoutes(records, state);
  const gaps = [...state.gaps.entries()].sort(([left], [right]) => compareText(left, right));
  return {
    coverage: {
      adapter: 'vue-router-static',
      status: gaps.length === 0 ? 'complete' : 'partial',
      gaps: gaps.map(([gap]) => gap),
    },
    diagnostics: gaps.map(([, gap]) => diagnosticForGap(gap)),
    routes,
    operations: [],
    schemas: [],
  };
}
