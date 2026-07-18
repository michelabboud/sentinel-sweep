#!/usr/bin/env node

import { randomBytes as systemRandomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sweepApi } from './api/sweep.mjs';
import { resolveChromeExecutable } from './browser/chrome.mjs';
import { sweepBrowser } from './browser/sweep.mjs';
import { buildManifest } from './discovery/index.mjs';
import { exportCollection } from './export.mjs';
import { buildFindings } from './findings.mjs';
import {
  cleanRuns,
  computeTrends,
  diffFindings,
  publishRun,
  readPublishedRun,
  readSweepHistory,
} from './history.mjs';
import { loadTrustedConfig } from './lib/config.mjs';
import { SentinelError } from './lib/errors.mjs';
import {
  RunBoundary,
  TargetBoundary,
} from './lib/fs-boundary.mjs';
import { OutputBoundary } from './lib/output-boundary.mjs';
import { parseApprovedOrigin } from './lib/origin.mjs';
import {
  createAvailableRedactor,
  resolveSecret,
} from './lib/secrets.mjs';
import { buildExecutionPlan } from './policy/execution.mjs';
import { summaryExitCode } from './report.mjs';

const HAS_OWN = Function.call.bind(Object.prototype.hasOwnProperty);
const MAX_ARGUMENTS = 64;
const MAX_FLAG_VALUE_UNITS = 32767;
const MAX_KEEP = 128;

export const SHORT_USAGE = "Usage: sentinel <command> --target <path> --config <path> [options]\nTry 'sentinel --help' for command details.\n";

export const USAGE = `Usage:
  sentinel --help
  sentinel --version
  sentinel setup --target <path> --config <path> [--json]
  sentinel manifest --target <path> --config <path> --output <path> [--json]
  sentinel api --target <path> --config <path> [--run-id <id>] [--sandbox-acknowledged] [--json]
  sentinel browser --target <path> --config <path> [--run-id <id>] [--sandbox-acknowledged] [--json]
  sentinel sweep --target <path> --config <path> [--run-id <id>] [--sandbox-acknowledged] [--json]
  sentinel report --target <path> --config <path> --run <id> --output <path> [--json]
  sentinel dashboard --target <path> --config <path> --run <id> --output <path> [--json]
  sentinel export --target <path> --config <path> --run <id> --format <postman|insomnia|bruno> --output <path> [--json]
  sentinel trends --target <path> --config <path> [--json]
  sentinel diff --target <path> --config <path> --run <id> --against <id> [--json]
  sentinel clean --target <path> --config <path> --keep <1-128> [--json]
`;

const ERROR_MESSAGES = Object.freeze({
  CLI_ARGUMENTS_INVALID: 'Arguments must be a plain array of strings',
  CLI_ARGUMENTS_LIMIT: 'Too many arguments were provided',
  CLI_COMMAND_REQUIRED: 'A command is required',
  CLI_COMMAND_UNKNOWN: 'Command is not supported',
  CLI_META_EXCLUSIVE: 'Help and version must be used as sole invocations',
  CLI_FLAG_EQUALS: 'Use space-separated flag values',
  CLI_FLAG_UNKNOWN: 'Flag is not supported',
  CLI_FLAG_INAPPLICABLE: 'Flag is not valid for this command',
  CLI_FLAG_DUPLICATE: 'Flag may be specified only once',
  CLI_FLAG_VALUE_REQUIRED: 'Flag requires a value',
  CLI_FLAG_VALUE_EMPTY: 'Flag value must not be empty',
  CLI_FLAG_VALUE_LIMIT: 'Flag value is too long',
  CLI_FLAG_VALUE_CONTROL: 'Flag value contains unsupported control characters',
  CLI_FLAG_REQUIRED: 'A required flag is missing',
  CLI_POSITIONAL: 'Positional arguments are not supported',
  CLI_RUN_ID_INVALID: 'Run identifier is invalid',
  CLI_FORMAT_INVALID: 'Export format is invalid',
  CLI_KEEP_INVALID: 'Retention count must be an integer from 1 through 128',
  CLI_VERSION_UNAVAILABLE: 'Version information is unavailable',
  CLI_DISPATCH_UNAVAILABLE: 'Command execution is unavailable',
  CLI_DISPATCH_INVALID: 'Command implementation returned an invalid exit code',
  CLI_COMMAND_FAILED: 'Command failed',
});

export class CliArgumentError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.CLI_ARGUMENTS_INVALID);
    this.name = 'CliArgumentError';
    this.code = HAS_OWN(ERROR_MESSAGES, code) ? code : 'CLI_ARGUMENTS_INVALID';
  }
}

function cliError(code) {
  return new CliArgumentError(code);
}

function commandKnown(command) {
  switch (command) {
    case 'setup':
    case 'manifest':
    case 'api':
    case 'browser':
    case 'sweep':
    case 'report':
    case 'dashboard':
    case 'export':
    case 'trends':
    case 'diff':
    case 'clean':
      return true;
    default:
      return false;
  }
}

function startsWithDoubleDash(value) {
  return value.length >= 2 && value[0] === '-' && value[1] === '-';
}

function containsEquals(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '=') return true;
  }
  return false;
}

function containsUnsupportedControl(value) {
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character <= '\u001f'
        || (character >= '\u007f' && character <= '\u009f')
        || character === '\u061c'
        || (character >= '\u200b' && character <= '\u200f')
        || (character >= '\u2028' && character <= '\u202e')
        || (character >= '\u2060' && character <= '\u206f')
        || character === '\ufeff') {
      return true;
    }
  }
  return false;
}

function containsNonSpace(value) {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== ' ') return true;
  }
  return false;
}

function snapshotArgv(argv) {
  if (!Array.isArray(argv) || !Number.isSafeInteger(argv.length)) {
    throw cliError('CLI_ARGUMENTS_INVALID');
  }
  if (argv.length > MAX_ARGUMENTS) throw cliError('CLI_ARGUMENTS_LIMIT');

  const copy = [];
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(argv, String(index));
      if (descriptor === undefined
          || !HAS_OWN(descriptor, 'value')
          || typeof descriptor.value !== 'string') {
        throw cliError('CLI_ARGUMENTS_INVALID');
      }
      copy[index] = descriptor.value;
    }
  } catch (error) {
    if (error instanceof CliArgumentError) throw error;
    throw cliError('CLI_ARGUMENTS_INVALID');
  }
  return copy;
}

function flagDefinition(flag) {
  switch (flag) {
    case '--target': return { key: 'target', takesValue: true };
    case '--config': return { key: 'config', takesValue: true };
    case '--output': return { key: 'output', takesValue: true };
    case '--run-id': return { key: 'runId', takesValue: true };
    case '--run': return { key: 'run', takesValue: true };
    case '--format': return { key: 'format', takesValue: true };
    case '--against': return { key: 'against', takesValue: true };
    case '--keep': return { key: 'keep', takesValue: true };
    case '--json': return { key: 'json', takesValue: false };
    case '--sandbox-acknowledged': return { key: 'sandboxAcknowledged', takesValue: false };
    default: return null;
  }
}

function flagAllowed(command, key) {
  if (key === 'target' || key === 'config' || key === 'json') return true;
  switch (command) {
    case 'manifest':
      return key === 'output';
    case 'api':
    case 'browser':
    case 'sweep':
      return key === 'runId' || key === 'sandboxAcknowledged';
    case 'report':
    case 'dashboard':
      return key === 'run' || key === 'output';
    case 'export':
      return key === 'run' || key === 'format' || key === 'output';
    case 'diff':
      return key === 'run' || key === 'against';
    case 'clean':
      return key === 'keep';
    default:
      return false;
  }
}

function requireOption(options, key) {
  if (!HAS_OWN(options, key)) throw cliError('CLI_FLAG_REQUIRED');
}

function validateRequired(command, options) {
  requireOption(options, 'target');
  requireOption(options, 'config');
  switch (command) {
    case 'manifest':
      requireOption(options, 'output');
      break;
    case 'report':
    case 'dashboard':
      requireOption(options, 'run');
      requireOption(options, 'output');
      break;
    case 'export':
      requireOption(options, 'run');
      requireOption(options, 'format');
      requireOption(options, 'output');
      break;
    case 'diff':
      requireOption(options, 'run');
      requireOption(options, 'against');
      break;
    case 'clean':
      requireOption(options, 'keep');
      break;
    default:
      break;
  }
}

function isDecimal(character) {
  return character >= '0' && character <= '9';
}

function isLowerHex(character) {
  return isDecimal(character) || (character >= 'a' && character <= 'f');
}

function decimalDigit(character) {
  switch (character) {
    case '0': return 0;
    case '1': return 1;
    case '2': return 2;
    case '3': return 3;
    case '4': return 4;
    case '5': return 5;
    case '6': return 6;
    case '7': return 7;
    case '8': return 8;
    case '9': return 9;
    default: return -1;
  }
}

function decimalPair(value, index) {
  return (decimalDigit(value[index]) * 10) + decimalDigit(value[index + 1]);
}

function validCalendarTimestamp(value) {
  const year = (decimalDigit(value[0]) * 1000)
    + (decimalDigit(value[1]) * 100)
    + (decimalDigit(value[2]) * 10)
    + decimalDigit(value[3]);
  const month = decimalPair(value, 5);
  const day = decimalPair(value, 8);
  const hour = decimalPair(value, 11);
  const minute = decimalPair(value, 14);
  const second = decimalPair(value, 17);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2
    ? (leap ? 29 : 28)
    : (month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31);
  return day >= 1 && day <= days;
}

function validRunId(value) {
  if (value.length !== 20
      && value.length !== 24
      && value.length !== 29
      && value.length !== 33) {
    return false;
  }
  const separatorsValid = value[4] === '-'
    && value[7] === '-'
    && value[10] === 'T'
    && value[13] === '-'
    && value[16] === '-';
  if (!separatorsValid) return false;

  const digitPositions = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];
  for (let index = 0; index < digitPositions.length; index += 1) {
    if (!isDecimal(value[digitPositions[index]])) return false;
  }
  if (!validCalendarTimestamp(value)) return false;

  let coreLength;
  if (value[19] === 'Z') {
    coreLength = 20;
  } else if (value[19] === '-'
      && isDecimal(value[20])
      && isDecimal(value[21])
      && isDecimal(value[22])
      && value[23] === 'Z') {
    coreLength = 24;
  } else {
    return false;
  }

  if (value.length === coreLength) return true;
  if (value.length !== coreLength + 9 || value[coreLength] !== '-') return false;
  for (let index = coreLength + 1; index < value.length; index += 1) {
    if (!isLowerHex(value[index])) return false;
  }
  return true;
}

function parseKeep(value) {
  if (value.length === 0 || value.length > 3 || value[0] === '0') {
    throw cliError('CLI_KEEP_INVALID');
  }
  let parsed = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!isDecimal(character)) throw cliError('CLI_KEEP_INVALID');
    let digit;
    switch (character) {
      case '0': digit = 0; break;
      case '1': digit = 1; break;
      case '2': digit = 2; break;
      case '3': digit = 3; break;
      case '4': digit = 4; break;
      case '5': digit = 5; break;
      case '6': digit = 6; break;
      case '7': digit = 7; break;
      case '8': digit = 8; break;
      case '9': digit = 9; break;
      default: throw cliError('CLI_KEEP_INVALID');
    }
    parsed = (parsed * 10) + digit;
  }
  if (parsed < 1 || parsed > MAX_KEEP) throw cliError('CLI_KEEP_INVALID');
  return parsed;
}

function normalizeOptions(options) {
  if (HAS_OWN(options, 'runId')
      && (!validRunId(options.runId) || options.runId[19] !== '-')) {
    throw cliError('CLI_RUN_ID_INVALID');
  }
  if (HAS_OWN(options, 'run') && !validRunId(options.run)) {
    throw cliError('CLI_RUN_ID_INVALID');
  }
  if (HAS_OWN(options, 'against') && !validRunId(options.against)) {
    throw cliError('CLI_RUN_ID_INVALID');
  }
  if (HAS_OWN(options, 'format')
      && options.format !== 'postman'
      && options.format !== 'insomnia'
      && options.format !== 'bruno') {
    throw cliError('CLI_FORMAT_INVALID');
  }
  if (HAS_OWN(options, 'keep')) options.keep = parseKeep(options.keep);
}

function freezeInvocation(command, options) {
  Object.freeze(options);
  return Object.freeze({ type: 'command', command, options });
}

export function parseCliArgs(argv) {
  const args = snapshotArgv(argv);
  if (args.length === 0) throw cliError('CLI_COMMAND_REQUIRED');

  const first = args[0];
  if (first === '--help' || first === '--version') {
    if (args.length !== 1) throw cliError('CLI_META_EXCLUSIVE');
    return Object.freeze({
      type: 'meta',
      action: first === '--help' ? 'help' : 'version',
    });
  }
  if (containsEquals(first)) throw cliError('CLI_FLAG_EQUALS');
  if (first.length === 0 || first[0] === '-') throw cliError('CLI_COMMAND_REQUIRED');
  if (!commandKnown(first)) throw cliError('CLI_COMMAND_UNKNOWN');

  const options = Object.create(null);
  options.json = false;
  if (first === 'api' || first === 'browser' || first === 'sweep') {
    options.sandboxAcknowledged = false;
  }
  const seen = Object.create(null);

  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--help' || token === '--version') throw cliError('CLI_META_EXCLUSIVE');
    if (!startsWithDoubleDash(token)) {
      throw cliError(token.length > 0 && token[0] === '-'
        ? 'CLI_FLAG_UNKNOWN'
        : 'CLI_POSITIONAL');
    }
    if (containsEquals(token)) throw cliError('CLI_FLAG_EQUALS');

    const definition = flagDefinition(token);
    if (definition === null) throw cliError('CLI_FLAG_UNKNOWN');
    if (!flagAllowed(first, definition.key)) throw cliError('CLI_FLAG_INAPPLICABLE');
    if (HAS_OWN(seen, definition.key)) throw cliError('CLI_FLAG_DUPLICATE');
    seen[definition.key] = true;

    if (!definition.takesValue) {
      options[definition.key] = true;
      continue;
    }

    if (index + 1 >= args.length || startsWithDoubleDash(args[index + 1])) {
      throw cliError('CLI_FLAG_VALUE_REQUIRED');
    }
    const value = args[index + 1];
    if (value.length === 0 || !containsNonSpace(value)) throw cliError('CLI_FLAG_VALUE_EMPTY');
    if (value.length > MAX_FLAG_VALUE_UNITS) throw cliError('CLI_FLAG_VALUE_LIMIT');
    if (containsUnsupportedControl(value)) throw cliError('CLI_FLAG_VALUE_CONTROL');
    options[definition.key] = value;
    index += 1;
  }

  validateRequired(first, options);
  normalizeOptions(options);
  return freezeInvocation(first, options);
}

function requestsJson(argv) {
  if (!Array.isArray(argv) || argv.length > MAX_ARGUMENTS) return false;
  try {
    for (let index = 0; index < argv.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(argv, String(index));
      if (descriptor !== undefined
          && HAS_OWN(descriptor, 'value')
          && descriptor.value === '--json') {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function writeFailure({ code, json, message, stderr, stdout, usage }) {
  if (json) {
    stdout.write(`${JSON.stringify({ ok: false, code, message })}\n`);
    return;
  }
  stderr.write(`Error [${code}]: ${message}\n`);
  if (usage) stderr.write(SHORT_USAGE);
}

function normalizedFailure(error, fallbackCode) {
  if (error instanceof CliArgumentError && HAS_OWN(ERROR_MESSAGES, error.code)) {
    return { code: error.code, message: ERROR_MESSAGES[error.code] };
  }
  return { code: fallbackCode, message: ERROR_MESSAGES[fallbackCode] };
}

function normalizeVersion(value) {
  if (typeof value !== 'string') throw cliError('CLI_VERSION_UNAVAILABLE');
  let start = 0;
  let end = value.length;
  while (start < end) {
    const character = value[start];
    if (character !== '\t' && character !== '\n' && character !== '\r' && character !== ' ') break;
    start += 1;
  }
  while (end > start) {
    const character = value[end - 1];
    if (character !== '\t' && character !== '\n' && character !== '\r' && character !== ' ') break;
    end -= 1;
  }
  let normalized = '';
  let dots = 0;
  let segmentLength = 0;
  for (let index = start; index < end; index += 1) {
    const character = value[index];
    if (character === '.') {
      if (segmentLength === 0 || dots >= 2) throw cliError('CLI_VERSION_UNAVAILABLE');
      dots += 1;
      segmentLength = 0;
    } else if (isDecimal(character)) {
      segmentLength += 1;
    } else {
      throw cliError('CLI_VERSION_UNAVAILABLE');
    }
    normalized += value[index];
  }
  if (dots !== 2 || segmentLength === 0) throw cliError('CLI_VERSION_UNAVAILABLE');
  return normalized;
}

async function readVersionFile() {
  return readFile(new URL('../VERSION', import.meta.url), 'utf8');
}

function dispatchError(code, message) {
  return new SentinelError(code, message);
}

function safeJson(value) {
  const json = JSON.stringify(value);
  if (typeof json !== 'string') {
    throw dispatchError('CLI_RESULT_INVALID', 'Command result is not serializable');
  }
  let safe = '';
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    if (code <= 0x1f
        || (code >= 0x7f && code <= 0x9f)
        || code === 0x061c
        || (code >= 0x200b && code <= 0x200f)
        || (code >= 0x2028 && code <= 0x202e)
        || (code >= 0x2060 && code <= 0x206f)
        || code === 0xfeff) {
      safe += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      safe += json[index];
    }
  }
  return safe;
}

function writeCommandSuccess(invocation, payload, stdout, redact) {
  assertSafePersistedData(payload, redact, 'command result');
  const document = { ok: true, command: invocation.command, ...payload };
  if (invocation.options.json) {
    stdout.write(`${safeJson(document)}\n`);
    return;
  }
  stdout.write(`Sentinel ${invocation.command} completed.\n${safeJson(payload)}\n`);
}

function writeCommandFailure(invocation, code, message, details, context) {
  const document = { ok: false, code, message, ...details };
  if (invocation.options.json) {
    context.stdout.write(`${safeJson(document)}\n`);
    return;
  }
  context.stderr.write(`Error [${code}]: ${message}\n`);
}

function codeUnitCompare(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function ownEnvironmentValue(env, name) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) return undefined;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(env, name);
  } catch {
    return undefined;
  }
  return descriptor !== undefined
    && Object.hasOwn(descriptor, 'value')
    && descriptor.enumerable === true
    && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function validateNonTtyAcknowledgement(invocation, context) {
  if (!invocation.options.sandboxAcknowledged || context.stdin?.isTTY === true) return;
  if (!Object.hasOwn(invocation.options, 'runId')
      || ownEnvironmentValue(context.env, 'SENTINEL_CI_SANDBOX_ACK')
        !== invocation.options.runId) {
    throw dispatchError(
      'SANDBOX_ACK_INVALID',
      'Non-interactive sandbox acknowledgement is not bound to the explicit run identifier',
    );
  }
}

function timestamp(context) {
  const value = context.now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw dispatchError('CLOCK_INVALID', 'Trusted clock did not return a valid timestamp');
  }
  return value.toISOString();
}

function generateRunId(context) {
  const instant = timestamp(context)
    .replaceAll(':', '-')
    .replace('.', '-');
  const entropy = context.randomBytes(4);
  if (!Buffer.isBuffer(entropy) && !(entropy instanceof Uint8Array)) {
    throw dispatchError('ENTROPY_INVALID', 'Trusted entropy source returned invalid bytes');
  }
  const suffix = Buffer.from(entropy).toString('hex');
  if (suffix.length !== 8) {
    throw dispatchError('ENTROPY_INVALID', 'Trusted entropy source returned the wrong byte count');
  }
  return `${instant}-${suffix}`;
}

function trustedDiscovery(config) {
  const discovery = config.discovery ?? {};
  return {
    openapi: [...(discovery.openapi ?? [])].sort(codeUnitCompare),
    vueRouter: [...(discovery.vueRouter ?? [])].sort(codeUnitCompare),
  };
}

function reportRootFor(targetBoundary, config) {
  const relative = config.reportDir;
  if (typeof relative !== 'string'
      || relative.length === 0
      || relative.length > 4096
      || relative.includes('\0')
      || relative.includes('\\')
      || containsUnsupportedControl(relative)
      || path.isAbsolute(relative)
      || path.win32.isAbsolute(relative)) {
    throw dispatchError('REPORT_DIR_INVALID', 'Trusted report directory must be a relative path');
  }
  const segments = relative.split('/');
  if (segments.some((segment) => segment.length === 0
    || segment === '.'
    || segment === '..'
    || Buffer.byteLength(segment) > 255)) {
    throw dispatchError('REPORT_DIR_INVALID', 'Trusted report directory is not canonical');
  }
  const versioned = segments[segments.length - 1] === 'sentinel-v2'
    ? relative
    : `${relative}/sentinel-v2`;
  const resolved = path.resolve(targetBoundary.root, versioned);
  const relation = path.relative(targetBoundary.root, resolved);
  if (relation === ''
      || path.isAbsolute(relation)
      || relation === '..'
      || relation.startsWith(`..${path.sep}`)) {
    throw dispatchError('REPORT_DIR_INVALID', 'Trusted report directory escapes the target root');
  }
  return resolved;
}

function assertSafePersistedData(value, redact, stage, depth = 0) {
  if (depth > 64) {
    throw dispatchError('CLI_DATA_UNSAFE', 'Command data exceeds its safety depth');
  }
  if (typeof value === 'string') {
    if (containsUnsupportedControl(value) || redact(value) !== value) {
      throw dispatchError('CLI_DATA_UNSAFE', `Unsafe string rejected at ${stage}`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertSafePersistedData(value[index], redact, stage, depth + 1);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    assertSafePersistedData(key, redact, stage, depth + 1);
    assertSafePersistedData(value[key], redact, stage, depth + 1);
  }
}

function assertSecretFreeData(value, redact, stage, depth = 0) {
  if (depth > 64) {
    throw dispatchError('CLI_DATA_UNSAFE', 'Command data exceeds its safety depth');
  }
  if (typeof value === 'string') {
    if (redact(value) !== value) {
      throw dispatchError('CLI_DATA_UNSAFE', `Secret-bearing string rejected at ${stage}`);
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertSecretFreeData(value[index], redact, stage, depth + 1);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    assertSecretFreeData(key, redact, stage, depth + 1);
    assertSecretFreeData(value[key], redact, stage, depth + 1);
  }
}

async function loadCommandContext(options, context) {
  const targetBoundary = await TargetBoundary.create(options.target);
  const config = await loadTrustedConfig({
    configPath: options.config,
    targetRoot: targetBoundary.root,
  });
  const redact = createAvailableRedactor(roleSecretRefs(config), context.env);
  assertSafePersistedData(options, redact, 'operator intent');
  assertSafePersistedData(targetBoundary.root, redact, 'target root');
  assertSafePersistedData(config, redact, 'trusted config');
  const reportRoot = reportRootFor(targetBoundary, config);
  assertSafePersistedData(reportRoot, redact, 'report root');
  return {
    targetBoundary,
    config,
    redact,
    reportRoot,
  };
}

function roleSecretRefs(config) {
  return Object.keys(config.roles)
    .sort(codeUnitCompare)
    .map((role) => config.roles[role].tokenRef);
}

async function setupResult(commandContext, context) {
  const { config, targetBoundary } = commandContext;
  const origins = config.approvedOrigins.map((origin) => parseApprovedOrigin(origin, {
    allowNonLoopback: config.allowNonLoopback === true,
  })).sort(codeUnitCompare);
  const roles = Object.keys(config.roles).sort(codeUnitCompare).map((role) => {
    let available = true;
    try {
      resolveSecret(config.roles[role].tokenRef, context.env);
    } catch (error) {
      if (error?.code !== 'SECRET_UNAVAILABLE') throw error;
      available = false;
    }
    return { role, available };
  });
  let chromeAvailable = true;
  try {
    await context.resolveChrome({
      executablePath: config.chromePath ?? undefined,
      targetRoot: targetBoundary.root,
    });
  } catch {
    chromeAvailable = false;
  }
  const discovery = trustedDiscovery(config);
  let discoveryAvailable = false;
  let coverage = null;
  try {
    const manifest = await freshManifest(commandContext, context);
    discoveryAvailable = true;
    coverage = manifest.coverage.status;
  } catch (error) {
    if (error?.code === 'CLI_DATA_UNSAFE') throw error;
  }
  return {
    schemaVersion: '2.0',
    executionReady: origins.length > 0
      && roles.every((entry) => entry.available)
      && chromeAvailable
      && discoveryAvailable
      && (!config.requireCompleteCoverage || coverage === 'complete'),
    discovery,
    discoveryAvailable,
    coverage,
    origins,
    roles,
    chromeAvailable,
  };
}

async function freshManifest(commandContext, context) {
  const manifest = await buildManifest({
    targetBoundary: commandContext.targetBoundary,
    config: commandContext.config,
    generatedAt: timestamp(context),
  });
  assertSafePersistedData(manifest, commandContext.redact, 'discovered manifest');
  return manifest;
}

async function executeEngines(mode, inputs, context, failedEngines) {
  if (mode === 'api') {
    try {
      return await context.sweepApi(inputs);
    } catch {
      failedEngines.push('api');
      throw dispatchError('SWEEP_INCOMPLETE', 'Required API sweep did not complete');
    }
  }
  if (mode === 'browser') {
    try {
      return await context.sweepBrowser(inputs);
    } catch {
      failedEngines.push('browser');
      throw dispatchError('SWEEP_INCOMPLETE', 'Required browser sweep did not complete');
    }
  }
  const [api, browser] = await Promise.allSettled([
    context.sweepApi(inputs),
    context.sweepBrowser(inputs),
  ]);
  if (api.status !== 'fulfilled') failedEngines.push('api');
  if (browser.status !== 'fulfilled') failedEngines.push('browser');
  if (failedEngines.length > 0) {
    throw dispatchError('SWEEP_INCOMPLETE', 'One or more required sweep engines did not complete');
  }
  return [...api.value, ...browser.value];
}

function requireExecutableWork(plan, mode) {
  const apiReady = plan.operations.some((decision) => decision.action === 'execute');
  const browserReady = plan.routes.some((decision) => decision.action === 'execute');
  if ((mode === 'api' && !apiReady)
      || (mode === 'browser' && !browserReady)
      || (mode === 'sweep' && (!apiReady || !browserReady))) {
    throw dispatchError(
      'EXECUTION_NOT_READY',
      'Trusted policy did not authorize required work for the selected mode',
    );
  }
}

async function executeRun(invocation, commandContext, context) {
  const { config, reportRoot, targetBoundary } = commandContext;
  const runId = invocation.options.runId ?? generateRunId(context);
  await RunBoundary.ensureReportRoot(reportRoot);
  const manifest = await freshManifest(commandContext, context);
  const plan = buildExecutionPlan({
    manifest,
    config,
    mode: invocation.command,
    sandboxAcknowledged: invocation.options.sandboxAcknowledged,
  });
  requireExecutableWork(plan, invocation.command);
  const { redact } = commandContext;
  const startedAt = timestamp(context);
  const failedEngines = [];
  let publication;
  try {
    publication = await publishRun({
      reportRoot,
      runId,
      writeArtifacts: async (runBoundary) => {
        await runBoundary.writeJson('sentinel-manifest.json', manifest);
        const observations = await executeEngines(invocation.command, {
          manifest,
          plan,
          config,
          env: context.env,
          runBoundary,
          targetBoundary,
        }, context, failedEngines);
        const findings = buildFindings({
          runId,
          manifest,
          plan,
          observations,
          coverage: manifest.coverage,
          requireCompleteCoverage: config.requireCompleteCoverage,
          startedAt,
          finishedAt: timestamp(context),
          redact,
        });
        return { findings };
      },
    });
  } catch (error) {
    if (failedEngines.length === 0) throw error;
    writeCommandFailure(
      invocation,
      'SWEEP_INCOMPLETE',
      'One or more required sweep engines did not complete',
      { failedEngines },
      context,
    );
    return 1;
  }
  const result = {
    runId: publication.runId,
    latestRunId: publication.latestRunId,
    summary: publication.findings.summary,
    coverage: publication.findings.coverage.status,
  };
  writeCommandSuccess(invocation, result, context.stdout, commandContext.redact);
  return summaryExitCode(publication.findings);
}

async function readExistingRun(commandContext, runId) {
  const published = await readPublishedRun({
    reportRoot: commandContext.reportRoot,
    runId,
  });
  assertSafePersistedData(published.manifest, commandContext.redact, 'published manifest');
  assertSafePersistedData(published.findings, commandContext.redact, 'published findings');
  assertSecretFreeData(published.markdown, commandContext.redact, 'published Markdown');
  assertSecretFreeData(published.dashboard, commandContext.redact, 'published dashboard');
  assertSecretFreeData(published.prComment, commandContext.redact, 'published PR comment');
  return published;
}

async function existingRun(invocation, commandContext) {
  return readExistingRun(commandContext, invocation.options.run);
}

async function dispatchCommand(invocation, context) {
  validateNonTtyAcknowledgement(invocation, context);
  const commandContext = await loadCommandContext(invocation.options, context);
  if (invocation.command === 'setup') {
    writeCommandSuccess(
      invocation,
      await setupResult(commandContext, context),
      context.stdout,
      commandContext.redact,
    );
    return 0;
  }
  if (invocation.command === 'manifest') {
    const manifest = await freshManifest(commandContext, context);
    await OutputBoundary.writeFile(
      invocation.options.output,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    writeCommandSuccess(invocation, {
      schemaVersion: manifest.schemaVersion,
      coverage: manifest.coverage.status,
      operations: manifest.operations.length,
      routes: manifest.routes.length,
    }, context.stdout, commandContext.redact);
    return 0;
  }
  if (invocation.command === 'api'
      || invocation.command === 'browser'
      || invocation.command === 'sweep') {
    return executeRun(invocation, commandContext, context);
  }
  if (invocation.command === 'report' || invocation.command === 'dashboard') {
    const published = await existingRun(invocation, commandContext);
    const contents = invocation.command === 'report' ? published.markdown : published.dashboard;
    await OutputBoundary.writeFile(invocation.options.output, contents);
    writeCommandSuccess(invocation, {
      runId: published.runId,
      summary: published.findings.summary,
      coverage: published.findings.coverage.status,
    }, context.stdout, commandContext.redact);
    return 0;
  }
  if (invocation.command === 'export') {
    const published = await existingRun(invocation, commandContext);
    const artifacts = exportCollection({
      format: invocation.options.format,
      manifest: published.manifest,
      config: commandContext.config,
    });
    assertSecretFreeData(artifacts, commandContext.redact, 'export artifacts');
    await OutputBoundary.writeTree(invocation.options.output, artifacts);
    writeCommandSuccess(invocation, {
      runId: published.runId,
      format: invocation.options.format,
      artifacts: artifacts.length,
    }, context.stdout, commandContext.redact);
    return 0;
  }
  if (invocation.command === 'trends') {
    const history = await readSweepHistory({ reportRoot: commandContext.reportRoot });
    const trends = computeTrends(history);
    writeCommandSuccess(invocation, { trends }, context.stdout, commandContext.redact);
    return 0;
  }
  if (invocation.command === 'diff') {
    const [newer, older] = await Promise.all([
      readExistingRun(commandContext, invocation.options.run),
      readExistingRun(commandContext, invocation.options.against),
    ]);
    writeCommandSuccess(invocation, {
      runId: newer.runId,
      against: older.runId,
      diff: diffFindings(older.findings, newer.findings),
    }, context.stdout, commandContext.redact);
    return 0;
  }
  if (invocation.command === 'clean') {
    const result = await cleanRuns({
      reportRoot: commandContext.reportRoot,
      keep: invocation.options.keep,
    });
    writeCommandSuccess(invocation, result, context.stdout, commandContext.redact);
    return 0;
  }
  throw dispatchError('CLI_COMMAND_UNKNOWN', 'Command is not supported');
}

export function createCommandDispatcher({
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  now = () => new Date(),
  randomBytes = systemRandomBytes,
  resolveChrome = resolveChromeExecutable,
  sweepApi: sweepApiImpl = sweepApi,
  sweepBrowser: sweepBrowserImpl = sweepBrowser,
} = {}) {
  const context = Object.freeze({
    env,
    stdin,
    stdout,
    stderr,
    now,
    randomBytes,
    resolveChrome,
    sweepApi: sweepApiImpl,
    sweepBrowser: sweepBrowserImpl,
  });
  return async (invocation) => dispatchCommand(invocation, context);
}

export async function runCli(argv, {
  dispatch,
  readVersion: readVersionOption = readVersionFile,
  stdout = process.stdout,
  stderr = process.stderr,
  stdin = process.stdin,
  env = process.env,
} = {}) {
  const json = requestsJson(argv);
  let invocation;
  try {
    invocation = parseCliArgs(argv);
  } catch (error) {
    const failure = normalizedFailure(error, 'CLI_ARGUMENTS_INVALID');
    writeFailure({ ...failure, json, stderr, stdout, usage: true });
    return 1;
  }

  if (invocation.type === 'meta') {
    if (invocation.action === 'help') {
      stdout.write(USAGE);
      return 0;
    }
    try {
      stdout.write(`${normalizeVersion(await readVersionOption())}\n`);
      return 0;
    } catch {
      const failure = normalizedFailure(null, 'CLI_VERSION_UNAVAILABLE');
      writeFailure({ ...failure, json: false, stderr, stdout, usage: false });
      return 1;
    }
  }

  const selectedDispatch = dispatch === undefined
    ? createCommandDispatcher({ stdout, stderr, stdin, env })
    : dispatch;
  if (typeof selectedDispatch !== 'function') {
    const failure = normalizedFailure(null, 'CLI_DISPATCH_UNAVAILABLE');
    writeFailure({ ...failure, json: invocation.options.json, stderr, stdout, usage: false });
    return 1;
  }

  // The lifecycle dispatcher owns canonical success/domain output. This layer
  // freezes operator intent, contains unexpected failures, and enforces the
  // public 0/1/2 exit-code contract without fabricating execution results.
  try {
    const exitCode = await selectedDispatch(invocation);
    if (exitCode !== 0 && exitCode !== 1 && exitCode !== 2) {
      const failure = normalizedFailure(null, 'CLI_DISPATCH_INVALID');
      writeFailure({ ...failure, json: invocation.options.json, stderr, stdout, usage: false });
      return 1;
    }
    return exitCode;
  } catch {
    const failure = normalizedFailure(null, 'CLI_COMMAND_FAILED');
    writeFailure({ ...failure, json: invocation.options.json, stderr, stdout, usage: false });
    return 1;
  }
}

function processArguments() {
  const args = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    args[args.length] = process.argv[index];
  }
  return args;
}

const modulePath = fileURLToPath(import.meta.url);
const invokedPath = typeof process.argv[1] === 'string' ? path.resolve(process.argv[1]) : '';
if (invokedPath === modulePath) {
  process.exitCode = await runCli(processArguments());
}
