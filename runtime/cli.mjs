#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (HAS_OWN(options, 'runId') && !validRunId(options.runId)) {
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

export async function runCli(argv, {
  dispatch = null,
  readVersion: readVersionOption = readVersionFile,
  stdout = process.stdout,
  stderr = process.stderr,
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

  if (typeof dispatch !== 'function') {
    const failure = normalizedFailure(null, 'CLI_DISPATCH_UNAVAILABLE');
    writeFailure({ ...failure, json: invocation.options.json, stderr, stdout, usage: false });
    return 1;
  }

  // The lifecycle dispatcher owns canonical success/domain output. This layer
  // freezes operator intent, contains unexpected failures, and enforces the
  // public 0/1/2 exit-code contract without fabricating execution results.
  try {
    const exitCode = await dispatch(invocation);
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
