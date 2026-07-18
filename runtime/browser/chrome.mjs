import { constants as fsConstants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
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

async function createFreshProfile(profileDir) {
  if (typeof profileDir !== 'string'
      || profileDir.length === 0
      || !path.isAbsolute(profileDir)
      || path.basename(path.resolve(profileDir)) === path.parse(profileDir).root) {
    throw chromeError('CHROME_PROFILE_INVALID', 'Chrome profile path must be a specific absolute path');
  }
  const resolved = path.resolve(profileDir);
  try {
    await lstat(resolved);
    throw chromeError('CHROME_PROFILE_NOT_FRESH', 'Chrome profile must not already exist');
  } catch (error) {
    if (error instanceof SentinelError) throw error;
    if (error?.code !== 'ENOENT') {
      throw chromeError('CHROME_PROFILE_INVALID', 'Chrome profile path is invalid');
    }
  }
  try {
    await mkdir(resolved, { mode: 0o700 });
  } catch {
    throw chromeError('CHROME_PROFILE_CREATE_FAILED', 'Chrome profile could not be created');
  }
  return resolved;
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

  const executable = await resolveChromeExecutable({ executablePath, targetRoot });
  const profile = await createFreshProfile(profileDir);
  const args = Object.freeze([
    '--headless=new',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-popup-blocking',
    '--disable-sync',
    '--metrics-recording-only',
    '--disable-dev-shm-usage',
    'about:blank',
  ]);

  let child;
  try {
    child = spawn(executable, args, {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    await rm(profile, { recursive: true, force: true });
    throw chromeError('CHROME_LAUNCH_FAILED', 'Chrome could not be launched');
  }

  const exitPromise = new Promise((resolve) => child.once('exit', resolve));
  let closed = false;
  const terminate = async () => {
    if (closed) return;
    closed = true;
    let terminated = false;
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
    } catch {
      try {
        signalProcessGroup(child, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      terminated = process.platform === 'win32'
        ? await waitForExit(exitPromise, 2000)
        : await waitForProcessGroupExit(child.pid, 2000).catch(() => false);
      await waitForExit(exitPromise, 2000);
    } finally {
      child.stderr?.destroy();
      await rm(profile, { recursive: true, force: true });
    }
    if (!terminated) {
      throw chromeError('CHROME_TERMINATION_FAILED', 'Chrome process tree did not terminate');
    }
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
      const onExit = () => finish(chromeError('CHROME_EXITED_EARLY', 'Chrome exited before CDP was ready'));
      const timeout = setTimeout(
        () => finish(chromeError('CHROME_LAUNCH_TIMEOUT', 'Chrome CDP readiness timed out')),
        timeoutMs,
      );
      timeout.unref?.();
      child.once('error', onError);
      child.once('exit', onExit);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-65_536);
        const match = /(?:^|\n)DevTools listening on (ws:\/\/[^\s]+)(?:\r?\n|$)/u.exec(stderr);
        if (!match) return;
        const validated = validatedDevToolsUrl(match[1]);
        if (validated !== null) finish(null, validated);
      });
    });

    return Object.freeze({
      pid: child.pid,
      args,
      webSocketUrl,
      close: terminate,
    });
  } catch (error) {
    await terminate();
    throw error;
  }
}
