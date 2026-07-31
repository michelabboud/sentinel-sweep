import assert from 'node:assert/strict';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CdpClient } from '../../runtime/browser/cdp.mjs';
import {
  launchChrome,
  resolveChromeExecutable,
} from '../../runtime/browser/chrome.mjs';

async function findChromeOrSkip(t) {
  try {
    const configured = process.env.SENTINEL_E2E_CHROME;
    if (configured !== undefined && !path.isAbsolute(configured)) {
      throw new Error('SENTINEL_E2E_CHROME must be an absolute executable path');
    }
    return await resolveChromeExecutable({ executablePath: configured });
  } catch (error) {
    if (error?.code === 'CHROME_NOT_FOUND'
        && process.env.SENTINEL_ALLOW_MISSING_CHROME_FOR_UNIT_TESTS === '1') {
      t.skip('System Chrome is unavailable and the explicit unit-test skip is enabled');
      return null;
    }
    throw error;
  }
}

async function processTree(rootPid) {
  const numeric = (await readdir('/proc')).filter((name) => /^\d+$/u.test(name));
  const children = new Map();
  await Promise.all(numeric.map(async (name) => {
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8');
      const closing = stat.lastIndexOf(')');
      const fields = stat.slice(closing + 2).split(' ');
      const parent = Number(fields[1]);
      const pid = Number(name);
      const list = children.get(parent) ?? [];
      list.push(pid);
      children.set(parent, list);
    } catch {
      // Process exited while /proc was being inspected.
    }
  }));

  const result = new Set([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.shift();
    for (const child of children.get(parent) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        pending.push(child);
      }
    }
  }
  return [...result];
}

async function crashpadProcesses() {
  if (process.platform !== 'linux') return new Map();
  const result = new Map();
  const numeric = (await readdir('/proc')).filter((name) => /^\d+$/u.test(name));
  await Promise.all(numeric.map(async (pid) => {
    try {
      const command = await readFile(`/proc/${pid}/cmdline`);
      if (command.includes(Buffer.from('chrome_crashpad_handler'))) {
        result.set(pid, command.toString('utf8'));
      }
    } catch {
      // Process exited while /proc was being inspected.
    }
  }));
  return result;
}

async function processEnvironment(pid) {
  const environment = new Map();
  const raw = await readFile(`/proc/${pid}/environ`, 'utf8');
  for (const entry of raw.split('\0')) {
    const separator = entry.indexOf('=');
    if (separator > 0) environment.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return environment;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitForProcessesToExit(pids, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processExists(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(pids.filter(processExists), [], 'Chrome process tree remained alive');
}

async function generatedProfilesForCurrentProcess() {
  const prefix = `.chrome-profile-${process.pid}-`;
  return (await readdir('/tmp')).filter((entry) => entry.startsWith(prefix)).sort();
}

test('rejects a caller-selected Chrome profile path before creating it', async () => {
  const callerChosen = `/tmp/caller-chosen-${process.pid}`;
  await assert.rejects(access(callerChosen), { code: 'ENOENT' });
  await assert.rejects(
    launchChrome({
      profileDir: callerChosen,
      headless: true,
      timeoutMs: 1000,
    }),
    { code: 'CHROME_PROFILE_CALLER_PATH_FORBIDDEN' },
  );
  await assert.rejects(access(callerChosen), { code: 'ENOENT' });
});

test('resolves only trusted Chrome paths and rejects a target-local executable', async (t) => {
  const chrome = await findChromeOrSkip(t);
  if (chrome === null) return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-chrome-path-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const targetRoot = path.join(temporary, 'target');
  await mkdir(targetRoot);
  const targetChrome = path.join(targetRoot, 'chrome');
  await writeFile(targetChrome, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await chmod(targetChrome, 0o700);

  await assert.rejects(
    resolveChromeExecutable({ executablePath: 'google-chrome', targetRoot }),
    { code: 'CHROME_PATH_NOT_ABSOLUTE' },
  );
  await assert.rejects(
    resolveChromeExecutable({ executablePath: targetChrome, targetRoot }),
    { code: 'CHROME_TARGET_LOCAL' },
  );
  assert.equal(await resolveChromeExecutable({ executablePath: chrome, targetRoot }), chrome);
  assert.equal(path.isAbsolute(await resolveChromeExecutable({ targetRoot })), true);
});

test('removes an exclusively created profile when post-create mode verification fails', async (t) => {
  const chrome = await findChromeOrSkip(t);
  if (chrome === null) return;
  const before = await generatedProfilesForCurrentProcess();
  const previousUmask = process.umask(0o777);
  try {
    await assert.rejects(
      launchChrome({ executablePath: chrome, headless: true, timeoutMs: 1000 }),
      { code: 'CHROME_PROFILE_CREATE_FAILED' },
    );
  } finally {
    process.umask(previousUmask);
  }
  assert.deepEqual(await generatedProfilesForCurrentProcess(), before);
});

test('launches a fresh Chrome profile, speaks CDP, captures PNG, and terminates its process tree', async (t) => {
  const chrome = await findChromeOrSkip(t);
  if (chrome === null) return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-chrome-cdp-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const targetRoot = path.join(temporary, 'target');
  await mkdir(targetRoot);

  const crashpadBaseline = await crashpadProcesses();
  const environmentCanary = 'sentinel-parent-environment-must-not-reach-chrome';
  process.env.SENTINEL_CHROME_ENV_CANARY = environmentCanary;
  let session;
  try {
    session = await launchChrome({
      executablePath: chrome,
      targetRoot,
      headless: true,
      timeoutMs: 10_000,
    });
  } finally {
    delete process.env.SENTINEL_CHROME_ENV_CANARY;
  }
  const profileDir = session.profileDir;
  let client;
  const observedPids = await processTree(session.pid);
  try {
    assert.equal(session.args.includes('--headless=new'), true);
    assert.equal(session.args.includes('--remote-debugging-port=0'), true);
    assert.equal(session.args.includes('--disable-background-networking'), true);
    assert.equal(session.args.includes('--disable-popup-blocking'), true);
    assert.equal(session.args.includes('--disable-breakpad'), true);
    assert.equal(session.args.includes('--disable-crash-reporter'), true);
    assert.equal(session.args.at(-1), 'about:blank');
    assert.equal(path.dirname(profileDir), '/tmp');
    assert.match(
      path.basename(profileDir),
      new RegExp(`^\\.chrome-profile-${process.pid}-[a-f0-9]{32}$`, 'u'),
    );
    assert.ok(profileDir.length <= 96);
    assert.equal(session.args.includes(`--user-data-dir=${profileDir}`), true);
    assert.equal(session.args.some((argument) => /bearer|authorization|secret/iu.test(argument)), false);
    await access(profileDir);
    const childEnvironment = await processEnvironment(session.pid);
    assert.equal(childEnvironment.get('HOME'), profileDir);
    assert.equal(childEnvironment.get('XDG_CONFIG_HOME'), path.join(profileDir, '.config'));
    assert.equal(childEnvironment.get('XDG_CACHE_HOME'), path.join(profileDir, '.cache'));
    assert.equal(childEnvironment.get('TMPDIR'), path.join(profileDir, '.tmp'));
    assert.equal([...childEnvironment.values()].includes(environmentCanary), false);
    const newCrashpad = [...await crashpadProcesses()]
      .filter(([pid, command]) => crashpadBaseline.get(pid) !== command);
    assert.deepEqual(newCrashpad, [], 'Chrome spawned a persistent crashpad handler');

    client = await CdpClient.connect(session.webSocketUrl);
    const { targetId } = await client.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await client.send(
      'Target.attachToTarget',
      { targetId, flatten: true },
    );
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    await client.send('Page.navigate', {
      url: 'data:text/html,<title>Sentinel CDP Ready</title><main>ready</main>',
    }, sessionId);
    const title = await client.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    }, sessionId);
    assert.equal(title.result.value, 'Sentinel CDP Ready');

    const screenshot = await client.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
    }, sessionId);
    const bytes = Buffer.from(screenshot.data, 'base64');
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(bytes.length > 100);
    await client.send('Target.closeTarget', { targetId });
  } finally {
    await client?.close();
    await session.close();
  }

  await waitForProcessesToExit(observedPids);
  const crashpadAfterClose = [...await crashpadProcesses()]
    .filter(([pid, command]) => crashpadBaseline.get(pid) !== command);
  assert.deepEqual(crashpadAfterClose, [], 'Chrome left a crashpad handler after close');
  await assert.rejects(access(profileDir), { code: 'ENOENT' });
});

test('waits for the entire POSIX process group and kills a TERM-ignoring descendant', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX process groups are unavailable on Windows');
    return;
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-chrome-group-'));
  const targetRoot = path.join(temporary, 'target');
  const fakeChrome = path.join(temporary, 'fake-chrome');
  const childPidFile = path.join(temporary, 'child.pid');
  await mkdir(targetRoot);
  await writeFile(fakeChrome, `#!/bin/sh
(
  trap '' TERM
  while :; do sleep 60; done
) &
child_pid=$!
printf '%s\\n' "$child_pid" > '${childPidFile}'
trap 'exit 0' TERM
printf '%s\\n' 'DevTools listening on ws://127.0.0.1:9222/devtools/browser/00000000-0000-0000-0000-000000000000' >&2
while :; do sleep 60; done
`, { mode: 0o700 });
  await chmod(fakeChrome, 0o700);

  let session;
  t.after(async () => {
    if (session?.pid) {
      try {
        process.kill(-session.pid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    await rm(temporary, { recursive: true, force: true });
  });

  session = await launchChrome({
    executablePath: fakeChrome,
    targetRoot,
    headless: true,
    timeoutMs: 5000,
  });
  const profileDir = session.profileDir;

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await access(childPidFile);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const descendantPid = Number((await readFile(childPidFile, 'utf8')).trim());
  assert.equal(processExists(descendantPid), true);

  await session.close();
  assert.equal(processExists(descendantPid), false, 'TERM-ignoring descendant remained alive');
  await assert.rejects(access(profileDir), { code: 'ENOENT' });
});

test('preserves a launch failure and removes the profile when crashpad containment also fails', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('The crashpad containment failure fixture uses Linux process metadata');
    return;
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-chrome-cleanup-'));
  const targetRoot = path.join(temporary, 'target');
  const fakeChrome = path.join(temporary, 'fake-chrome.mjs');
  const roguePidFile = path.join(temporary, 'rogue.pid');
  const profilePathFile = path.join(temporary, 'profile.path');
  await mkdir(targetRoot);
  await writeFile(fakeChrome, `#!${process.execPath}
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const profile = process.argv.find((argument) => argument.startsWith('--user-data-dir='))
  ?.slice('--user-data-dir='.length);
const rogue = spawn('/bin/sh', [
  '-c',
  'trap "" TERM; while :; do sleep 60; done',
  'sentinel-rogue-crashpad',
  \`--database=\${profile}\`,
], { detached: true, stdio: 'ignore' });
rogue.unref();
writeFileSync(${JSON.stringify(roguePidFile)}, String(rogue.pid));
writeFileSync(${JSON.stringify(profilePathFile)}, profile);
setTimeout(() => process.exit(17), 100);
`, { mode: 0o700 });
  await chmod(fakeChrome, 0o700);

  let roguePid;
  t.after(async () => {
    if (Number.isInteger(roguePid)) {
      try {
        process.kill(-roguePid, 'SIGKILL');
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error;
      }
    }
    await rm(temporary, { recursive: true, force: true });
  });

  await assert.rejects(
    launchChrome({
      executablePath: fakeChrome,
      targetRoot,
      headless: true,
      timeoutMs: 5000,
    }),
    { code: 'CHROME_EXITED_EARLY' },
  );
  roguePid = Number((await readFile(roguePidFile, 'utf8')).trim());
  const profileDir = await readFile(profilePathFile, 'utf8');
  assert.equal(Number.isInteger(roguePid), true);
  assert.equal(processExists(roguePid), true, 'fixture did not preserve the rogue handler');
  await assert.rejects(access(profileDir), { code: 'ENOENT' });
});

test('fails closed when a generated Chrome profile is modified or substituted', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('The fixed system temporary profile boundary is Linux-specific');
    return;
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-chrome-substitution-'));
  const targetRoot = path.join(temporary, 'target');
  const fakeChrome = path.join(temporary, 'fake-chrome');
  const victim = path.join(temporary, 'victim');
  const victimMarker = path.join(victim, 'must-survive');
  await Promise.all([mkdir(targetRoot), mkdir(victim)]);
  await writeFile(victimMarker, 'untouched');
  await writeFile(fakeChrome, `#!/bin/sh
trap 'exit 0' TERM
printf '%s\n' 'DevTools listening on ws://127.0.0.1:9222/devtools/browser/00000000-0000-0000-0000-000000000000' >&2
while :; do sleep 60; done
`, { mode: 0o700 });
  await chmod(fakeChrome, 0o700);

  const leftovers = [];
  t.after(async () => {
    for (const candidate of leftovers) await rm(candidate, { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  });

  const modeSession = await launchChrome({
    executablePath: fakeChrome,
    targetRoot,
    headless: true,
    timeoutMs: 5000,
  });
  leftovers.push(modeSession.profileDir);
  await chmod(modeSession.profileDir, 0o755);
  await assert.rejects(modeSession.close(), { code: 'CHROME_PROFILE_CHANGED' });
  await access(modeSession.profileDir);

  const substitutedSession = await launchChrome({
    executablePath: fakeChrome,
    targetRoot,
    headless: true,
    timeoutMs: 5000,
  });
  const movedProfile = `${substitutedSession.profileDir}.moved`;
  leftovers.push(substitutedSession.profileDir, movedProfile);
  await rename(substitutedSession.profileDir, movedProfile);
  await symlink(victim, substitutedSession.profileDir, 'dir');
  await assert.rejects(substitutedSession.close(), { code: 'CHROME_PROFILE_CHANGED' });
  assert.equal(await readFile(victimMarker, 'utf8'), 'untouched');
  await access(movedProfile);
});

test('leaves no generated Chrome profile owned by this test process', async () => {
  assert.deepEqual(await generatedProfilesForCurrentProcess(), []);
});
