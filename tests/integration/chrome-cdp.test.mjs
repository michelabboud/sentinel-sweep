import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
    return await resolveChromeExecutable({});
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

test('launches a fresh Chrome profile, speaks CDP, captures PNG, and terminates its process tree', async (t) => {
  const chrome = await findChromeOrSkip(t);
  if (chrome === null) return;
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sentinel-chrome-cdp-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const targetRoot = path.join(temporary, 'target');
  await mkdir(targetRoot);
  const existingProfile = path.join(temporary, 'not-fresh');
  await mkdir(existingProfile);
  await writeFile(path.join(existingProfile, 'marker'), 'not fresh');

  await assert.rejects(
    launchChrome({
      executablePath: chrome,
      profileDir: existingProfile,
      targetRoot,
      headless: true,
      timeoutMs: 10_000,
    }),
    { code: 'CHROME_PROFILE_NOT_FRESH' },
  );

  const profileDir = path.join(temporary, 'fresh-profile');
  const session = await launchChrome({
    executablePath: chrome,
    profileDir,
    targetRoot,
    headless: true,
    timeoutMs: 10_000,
  });
  let client;
  const observedPids = await processTree(session.pid);
  try {
    assert.equal(session.args.includes('--headless=new'), true);
    assert.equal(session.args.includes('--remote-debugging-port=0'), true);
    assert.equal(session.args.includes('--disable-background-networking'), true);
    assert.equal(session.args.at(-1), 'about:blank');
    assert.equal(session.args.some((argument) => /bearer|authorization|secret/iu.test(argument)), false);
    await access(profileDir);

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
  await assert.rejects(access(profileDir), { code: 'ENOENT' });
});
