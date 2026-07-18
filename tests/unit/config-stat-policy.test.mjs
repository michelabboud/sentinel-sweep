import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import test from 'node:test';

import * as configModule from '../../runtime/lib/config.mjs';

function regularStat({ mode = 0o600, uid = 1000 } = {}) {
  return {
    mode: fsConstants.S_IFREG | mode,
    uid,
    isFile: () => true,
  };
}

test('trusted-file stat policy enforces owner and exact private modes on POSIX', () => {
  assert.equal(typeof configModule.validateTrustedFileStat, 'function');
  const validate = configModule.validateTrustedFileStat;

  for (const mode of [0o600, 0o400]) {
    assert.doesNotThrow(() => validate(regularStat({ mode }), {
      label: 'CONFIG',
      requirePrivateMode: true,
      platform: 'linux',
      effectiveUid: 1000,
    }));
  }
  for (const mode of [0o644, 0o640, 0o666, 0o4600]) {
    assert.throws(
      () => validate(regularStat({ mode }), {
        label: 'CONFIG',
        requirePrivateMode: true,
        platform: 'linux',
        effectiveUid: 1000,
      }),
      { code: 'CONFIG_MODE_INSECURE' },
      mode.toString(8),
    );
  }
  assert.throws(
    () => validate(regularStat({ mode: 0o600, uid: 1001 }), {
      label: 'CONFIG',
      requirePrivateMode: true,
      platform: 'linux',
      effectiveUid: 1000,
    }),
    { code: 'CONFIG_OWNER_INVALID' },
  );
});

test('bundled defaults stat policy allows checked-in mode 0644', () => {
  assert.equal(typeof configModule.validateTrustedFileStat, 'function');
  assert.doesNotThrow(() => configModule.validateTrustedFileStat(
    regularStat({ mode: 0o644, uid: 2000 }),
    {
      label: 'DEFAULTS',
      requirePrivateMode: false,
      platform: 'linux',
      effectiveUid: 1000,
    },
  ));
});

test('trusted-file stat policy rejects non-regular descriptors before trust decisions', () => {
  assert.equal(typeof configModule.validateTrustedFileStat, 'function');
  assert.throws(
    () => configModule.validateTrustedFileStat(
      { mode: fsConstants.S_IFDIR | 0o700, uid: 1000, isFile: () => false },
      {
        label: 'CONFIG',
        requirePrivateMode: true,
        platform: 'linux',
        effectiveUid: 1000,
      },
    ),
    { code: 'CONFIG_NOT_FILE' },
  );
});
