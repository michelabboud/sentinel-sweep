import { constants as fsConstants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { SentinelError } from '../lib/errors.mjs';

const SYSTEM_CANDIDATES = Object.freeze([
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/google-chrome',
]);
const CHROME_PROFILE_PARENT = '/tmp';
const CHROME_PROFILE_PREFIX = '.chrome-profile-';

function chromeError(code, message) {
  return new SentinelError(code, message);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!path.isAbsolute(relative)
      && relative !== '..'
      && !relative.startsWith(`..${path.sep}`));
}

async function canonicalDirectory(directory, code) {
  const resolved = path.resolve(directory);
  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch {
    throw chromeError(code, 'Directory is unavailable');
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw chromeError(code, 'Directory is not a canonical regular directory');
  }
  return realpath(resolved);
}

async function validateExecutable(candidate) {
  let canonical;
  try {
    canonical = await realpath(candidate);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw new Error('not a file');
    await access(canonical, fsConstants.X_OK);
  } catch {
    throw chromeError('CHROME_NOT_EXECUTABLE', 'Chrome executable is unavailable');
  }
  return canonical;
}

export async function resolveChromeExecutable({ executablePath, targetRoot } = {}) {
  let canonicalTarget = null;
  let lexicalTarget = null;
  if (targetRoot !== undefined) {
    if (typeof targetRoot !== 'string' || targetRoot.length === 0) {
      throw chromeError('CHROME_TARGET_INVALID', 'Target root is invalid');
    }
    lexicalTarget = path.resolve(targetRoot);
    canonicalTarget = await canonicalDirectory(targetRoot, 'CHROME_TARGET_INVALID');
  }

  if (executablePath !== undefined && executablePath !== null) {
    if (typeof executablePath !== 'string'
        || executablePath.length === 0
        || !path.isAbsolute(executablePath)) {
      throw chromeError('CHROME_PATH_NOT_ABSOLUTE', 'Configured Chrome path must be absolute');
    }
    const lexicalExecutable = path.resolve(executablePath);
    if (lexicalTarget !== null && isWithin(lexicalTarget, lexicalExecutable)) {
      throw chromeError('CHROME_TARGET_LOCAL', 'Target-local Chrome executables are forbidden');
    }
    const canonical = await validateExecutable(lexicalExecutable);
    if (canonicalTarget !== null && isWithin(canonicalTarget, canonical)) {
      throw chromeError('CHROME_TARGET_LOCAL', 'Target-local Chrome executables are forbidden');
    }
    return canonical;
  }

  for (const candidate of SYSTEM_CANDIDATES) {
    try {
      const canonical = await validateExecutable(candidate);
      if (canonicalTarget === null || !isWithin(canonicalTarget, canonical)) return canonical;
    } catch {
      // Continue only through the fixed system candidate list.
    }
  }
  throw chromeError('CHROME_NOT_FOUND', 'No allowlisted system Chrome executable was found');
}

function sameIdentity(left, right) {
  return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino);
}

async function validatedProfileParent() {
  if (process.platform !== 'linux' || typeof process.geteuid !== 'function') {
    throw chromeError(
      'CHROME_PROFILE_PLATFORM_UNSUPPORTED',
      'Secure Chrome profile isolation requires Linux process identity support',
    );
  }
  let initial;
  let canonical;
  try {
    initial = await lstat(CHROME_PROFILE_PARENT, { bigint: true });
    canonical = await realpath(CHROME_PROFILE_PARENT);
  } catch {
    throw chromeError('CHROME_PROFILE_PARENT_INVALID', 'Chrome profile parent is unavailable');
  }
  if (canonical !== CHROME_PROFILE_PARENT
      || initial.isSymbolicLink()
      || !initial.isDirectory()
      || initial.uid !== 0n
      || (initial.mode & 0o7777n) !== 0o1777n) {
    throw chromeError(
      'CHROME_PROFILE_PARENT_INVALID',
      'Chrome profile parent is not the canonical system temporary directory',
    );
  }
  return initial;
}

async function createFreshProfile() {
  const parentIdentity = await validatedProfileParent();
  let suffix;
  try {
    suffix = randomBytes(16).toString('hex');
  } catch {
    throw chromeError('CHROME_PROFILE_CREATE_FAILED', 'Chrome profile name could not be generated');
  }
  const profile = path.join(
    CHROME_PROFILE_PARENT,
    `${CHROME_PROFILE_PREFIX}${process.pid}-${suffix}`,
  );
  if (profile.length > 96) {
    throw chromeError('CHROME_PROFILE_CREATE_FAILED', 'Chrome profile path is too long');
  }
  try {
    await mkdir(profile, { mode: 0o700 });
  } catch {
    throw chromeError('CHROME_PROFILE_CREATE_FAILED', 'Chrome profile could not be created');
  }

  let created;
  try {
    created = await lstat(profile, { bigint: true });
    const [currentParent, canonical] = await Promise.all([
      validatedProfileParent(),
      realpath(profile),
    ]);
    if (canonical !== profile
        || !created.isDirectory()
        || created.isSymbolicLink()
        || created.uid !== BigInt(process.geteuid())
        || (created.mode & 0o7777n) !== 0o700n
        || !sameIdentity(parentIdentity, currentParent)) {
      throw chromeError(
        'CHROME_PROFILE_CREATE_FAILED',
        'Chrome profile identity could not be verified',
      );
    }
    return Object.freeze({ path: profile, identity: created, parentIdentity });
  } catch (error) {
    if (created?.isDirectory()
        && !created.isSymbolicLink()
        && created.uid === BigInt(process.geteuid())) {
      await removeFreshProfile(
        { path: profile, identity: created, parentIdentity },
        { repairMode: true },
      ).catch(() => {});
    }
    if (error instanceof SentinelError) throw error;
    throw chromeError('CHROME_PROFILE_CREATE_FAILED', 'Chrome profile identity could not be verified');
  }
}

async function removeFreshProfile(record, { repairMode = false } = {}) {
  try {
    const [current, parent, canonical] = await Promise.all([
      lstat(record.path, { bigint: true }),
      validatedProfileParent(),
      realpath(record.path),
    ]);
    if (canonical !== record.path
        || current.isSymbolicLink()
        || !current.isDirectory()
        || current.uid !== BigInt(process.geteuid())
        || !sameIdentity(current, record.identity)
        || !sameIdentity(parent, record.parentIdentity)) {
      throw chromeError('CHROME_PROFILE_CHANGED', 'Chrome profile identity changed before cleanup');
    }
    if ((current.mode & 0o7777n) !== 0o700n) {
      if (!repairMode) {
        throw chromeError('CHROME_PROFILE_CHANGED', 'Chrome profile mode changed before cleanup');
      }
      await chmod(record.path, 0o700);
      const repaired = await lstat(record.path, { bigint: true });
      if (repaired.isSymbolicLink()
          || !repaired.isDirectory()
          || repaired.uid !== BigInt(process.geteuid())
          || (repaired.mode & 0o7777n) !== 0o700n
          || !sameIdentity(repaired, record.identity)) {
        throw chromeError('CHROME_PROFILE_CHANGED', 'Chrome profile identity changed before cleanup');
      }
    }
    await rm(record.path, { recursive: true, force: false });
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    if (error?.code === 'ENOENT' || error?.code === 'ELOOP') {
      throw chromeError('CHROME_PROFILE_CHANGED', 'Chrome profile identity changed before cleanup');
    }
    throw chromeError('CHROME_PROFILE_CLEANUP_FAILED', 'Chrome profile could not be removed');
  }
}

async function createChromeEnvironment(profile) {
  const config = path.join(profile, '.config');
  const cache = path.join(profile, '.cache');
  const temporary = path.join(profile, '.tmp');
  const crashDumps = path.join(profile, '.crash-dumps');
  try {
    await Promise.all([
      mkdir(config, { mode: 0o700 }),
      mkdir(cache, { mode: 0o700 }),
      mkdir(temporary, { mode: 0o700 }),
      mkdir(crashDumps, { mode: 0o700 }),
    ]);
  } catch {
    throw chromeError('CHROME_PROFILE_CREATE_FAILED', 'Chrome profile state could not be isolated');
  }
  return Object.freeze({
    HOME: profile,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    TMPDIR: temporary,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PATH: '/usr/bin:/bin',
  });
}

async function profileCrashpadProcesses(profile, executable) {
  if (process.platform !== 'linux') return [];
  const currentUid = typeof process.geteuid === 'function' ? process.geteuid() : null;
  if (currentUid === null) {
    throw chromeError('CHROME_CRASHPAD_CONTAINMENT_FAILED', 'Crash reporter ownership is unavailable');
  }
  const executableDirectory = path.dirname(executable);
  const entries = await readdir('/proc', { withFileTypes: true });
  const matches = [];
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) return;
    const processRoot = path.join('/proc', entry.name);
    try {
      const command = await readFile(path.join(processRoot, 'cmdline'));
      const arguments_ = command.toString('utf8').split('\0').filter((value) => value !== '');
      const database = arguments_.find((value) => value.startsWith('--database='));
      if (database === undefined
          || !isWithin(profile, database.slice('--database='.length))) return;
      const processIdentity = await lstat(processRoot);
      const processExecutable = await realpath(path.join(processRoot, 'exe'));
      if (processIdentity.uid !== currentUid
          || path.dirname(processExecutable) !== executableDirectory
          || !/^\w*chrome\w*_crashpad_handler$/u.test(path.basename(processExecutable))) {
        throw chromeError(
          'CHROME_CRASHPAD_CONTAINMENT_FAILED',
          'Chrome crash reporter identity could not be verified',
        );
      }
      matches.push(Number(entry.name));
    } catch (error) {
      if (error instanceof SentinelError) throw error;
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error?.code)) {
        throw chromeError(
          'CHROME_CRASHPAD_CONTAINMENT_FAILED',
          'Chrome crash reporter could not be inspected',
        );
      }
    }
  }));
  return matches;
}

async function containCrashpadHandlers(profile, executable) {
  if (process.platform !== 'linux') return;
  const deadline = Date.now() + 1500;
  let quietSince = null;
  while (Date.now() < deadline) {
    const handlers = await profileCrashpadProcesses(profile, executable);
    if (handlers.length === 0) {
      if (quietSince === null) quietSince = Date.now();
      if (Date.now() - quietSince >= 250) return;
    } else {
      quietSince = null;
      for (const pid of handlers) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          if (error?.code !== 'ESRCH') {
            throw chromeError(
              'CHROME_CRASHPAD_CONTAINMENT_FAILED',
              'Chrome crash reporter could not be terminated',
            );
          }
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw chromeError(
    'CHROME_CRASHPAD_CONTAINMENT_FAILED',
    'Chrome crash reporter did not remain terminated',
  );
}

function validatedDevToolsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:'
      || (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]')
      || url.username !== ''
      || url.password !== ''
      || url.search !== ''
      || url.hash !== ''
      || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(url.pathname)) {
    return null;
  }
  return url.href;
}

function signalProcessGroup(child, signal) {
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

async function waitForExit(exitPromise, timeoutMs) {
  let timer;
  return Promise.race([
    exitPromise.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processGroupExists(pid);
}

function killWindowsProcessTree(pid) {
  return new Promise((resolve) => {
    let killer;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    killer.once('error', () => resolve(false));
    killer.once('exit', (code) => resolve(code === 0));
  });
}

export async function launchChrome({
  executablePath,
  profileDir,
  targetRoot,
  headless,
  timeoutMs,
} = {}) {
  if (headless !== true) {
    throw chromeError('CHROME_HEADLESS_REQUIRED', 'Sentinel requires headless Chrome');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw chromeError('CHROME_TIMEOUT_INVALID', 'Chrome launch timeout is invalid');
  }
  if (profileDir !== undefined) {
    throw chromeError(
      'CHROME_PROFILE_CALLER_PATH_FORBIDDEN',
      'Chrome profile paths are generated only by Sentinel',
    );
  }

  const executable = await resolveChromeExecutable({ executablePath, targetRoot });
  const profileRecord = await createFreshProfile();
  const profile = profileRecord.path;
  let environmentProfile;
  let environment;
  try {
    environmentProfile = await realpath(profile);
    environment = await createChromeEnvironment(environmentProfile);
  } catch (error) {
    try {
      await removeFreshProfile(profileRecord);
    } catch {
      // Preserve the primary environment-isolation failure.
    }
    throw error;
  }
  const args = Object.freeze([
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    // Chrome passes this path to sandboxed descendants. Sentinel generated and
    // identity-verified this exact private /tmp directory; artifact writes use
    // their separately pinned run boundary.
    `--user-data-dir=${environmentProfile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-popup-blocking',
    '--disable-sync',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--noerrdialogs',
    `--crash-dumps-dir=${path.join(environmentProfile, '.crash-dumps')}`,
    '--metrics-recording-only',
    '--disable-dev-shm-usage',
    'about:blank',
  ]);
  let child;
  try {
    child = spawn(executable, args, {
      detached: process.platform !== 'win32',
      env: environment,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    try {
      await removeFreshProfile(profileRecord);
    } catch {
      // Preserve the primary process-spawn failure.
    }
    throw chromeError('CHROME_LAUNCH_FAILED', 'Chrome could not be launched');
  }

  const exitPromise = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
    else {
      child.once('exit', resolve);
      child.once('error', resolve);
    }
  });
  let closed = false;
  const terminate = async () => {
    if (closed) return;
    closed = true;
    let terminated = false;
    let terminationError = null;
    try {
      if (process.platform === 'win32') {
        await killWindowsProcessTree(child.pid);
        terminated = await waitForExit(exitPromise, 4000);
        if (!terminated) {
          child.kill('SIGKILL');
          terminated = await waitForExit(exitPromise, 2000);
        }
      } else {
        signalProcessGroup(child, 'SIGTERM');
        terminated = await waitForProcessGroupExit(child.pid, 2000);
        if (!terminated) {
          signalProcessGroup(child, 'SIGKILL');
          terminated = await waitForProcessGroupExit(child.pid, 2000);
        }
        await waitForExit(exitPromise, 2000);
      }
    } catch (error) {
      terminationError = error;
      try {
        signalProcessGroup(child, 'SIGKILL');
      } catch (signalError) {
        try {
          child.kill('SIGKILL');
        } catch (killError) {
          terminationError = killError ?? signalError;
        }
      }
      terminated = process.platform === 'win32'
        ? await waitForExit(exitPromise, 2000)
        : await waitForProcessGroupExit(child.pid, 2000).catch(() => false);
      await waitForExit(exitPromise, 2000);
      if (terminated) terminationError = null;
    }

    child.stderr?.destroy();
    let containmentError = null;
    let profileCleanupError = null;
    try {
      await containCrashpadHandlers(environmentProfile, executable);
    } catch (error) {
      containmentError = error;
    }
    try {
      await removeFreshProfile(profileRecord);
    } catch (error) {
      profileCleanupError = error;
    }

    if (!terminated) {
      throw chromeError('CHROME_TERMINATION_FAILED', 'Chrome process tree did not terminate');
    }
    if (terminationError !== null) throw terminationError;
    if (containmentError !== null) throw containmentError;
    if (profileCleanupError !== null) throw profileCleanupError;
  };

  try {
    const webSocketUrl = await new Promise((resolve, reject) => {
      let stderr = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.off('error', onError);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve(value);
      };
      const onError = () => finish(chromeError('CHROME_LAUNCH_FAILED', 'Chrome launch failed'));
      // The exit code, signal, and Chrome's own stderr tail are the only
      // evidence an early exit leaves behind; without them the failure is
      // undiagnosable on remote hosts (proven on CI, 2026-07-31). Pre-ready
      // stderr is Chrome's log output — credentials never appear in it.
      const onExit = () => finish(chromeError(
        'CHROME_EXITED_EARLY',
        `Chrome exited before CDP was ready (exit=${child.exitCode ?? 'null'}, signal=${child.signalCode ?? 'null'}); stderr tail: ${stderr.slice(-600).trim() || '(empty)'}`,
      ));
      const timeout = setTimeout(
        () => finish(chromeError('CHROME_LAUNCH_TIMEOUT', 'Chrome CDP readiness timed out')),
        timeoutMs,
      );
      timeout.unref?.();
      child.once('error', onError);
      child.once('exit', onExit);
      if (child.exitCode !== null || child.signalCode !== null) onExit();
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-65_536);
        const match = /(?:^|\n)DevTools listening on (ws:\/\/[^\s]+)(?:\r?\n|$)/u.exec(stderr);
        if (!match) return;
        const validated = validatedDevToolsUrl(match[1]);
        if (validated !== null) finish(null, validated);
      });
    });

    await containCrashpadHandlers(environmentProfile, executable);
    return Object.freeze({
      pid: child.pid,
      args,
      profileDir: profile,
      webSocketUrl,
      close: terminate,
    });
  } catch (error) {
    try {
      await terminate();
    } catch {
      // A launch/readiness failure is primary; cleanup failures must not replace it.
    }
    throw error;
  }
}
