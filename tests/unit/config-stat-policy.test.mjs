import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import test from 'node:test';

import * as configModule from '../../runtime/lib/config.mjs';

function regularStat({
  mode = 0o600,
  uid = 1000,
  nlink = 1,
  dev = 10,
  ino = 20,
  birthtimeNs = 30n,
  ctimeNs = 40n,
  size = 50n,
  mtimeNs = 60n,
  atimeNs = 70n,
} = {}) {
  return {
    mode: fsConstants.S_IFREG | mode,
    uid,
    nlink,
    dev,
    ino,
    birthtimeNs,
    ctimeNs,
    size,
    mtimeNs,
    atimeNs,
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

test('external config stat policy rejects hard-link aliases', () => {
  assert.throws(
    () => configModule.validateTrustedFileStat(
      regularStat({ nlink: 2 }),
      {
        label: 'CONFIG',
        requirePrivateMode: true,
        platform: 'linux',
        effectiveUid: 1000,
      },
    ),
    { code: 'CONFIG_LINK_COUNT_INVALID' },
  );
});

test('opened descriptor identity must match the pre-open path identity', () => {
  assert.equal(typeof configModule.validateOpenedFileIdentity, 'function');
  const validate = configModule.validateOpenedFileIdentity;

  assert.doesNotThrow(() => validate(
    regularStat({ dev: 10n, ino: 20n }),
    regularStat({ dev: 10n, ino: 20n }),
    { label: 'CONFIG', platform: 'linux' },
  ));
  assert.throws(
    () => validate(
      regularStat({ dev: 10n, ino: 20n }),
      regularStat({ dev: 10n, ino: 21n }),
      { label: 'CONFIG', platform: 'linux' },
    ),
    { code: 'CONFIG_FILE_CHANGED' },
  );
  assert.throws(
    () => validate(
      regularStat({ dev: 10n, ino: 20n }),
      regularStat({ dev: 11n, ino: 20n }),
      { label: 'DEFAULTS', platform: 'linux' },
    ),
    { code: 'DEFAULTS_FILE_CHANGED' },
  );
});

test('Windows descriptor identity uses available file IDs and otherwise fails closed', () => {
  assert.equal(typeof configModule.validateOpenedFileIdentity, 'function');
  const validate = configModule.validateOpenedFileIdentity;

  assert.doesNotThrow(() => validate(
    regularStat({ dev: 0n, ino: 12345n }),
    regularStat({ dev: 0n, ino: 12345n }),
    { label: 'CONFIG', platform: 'win32' },
  ));
  assert.throws(
    () => validate(
      regularStat({ dev: 0n, ino: 0n }),
      regularStat({ dev: 0n, ino: 0n }),
      { label: 'CONFIG', platform: 'win32' },
    ),
    { code: 'CONFIG_FILE_CHANGED' },
  );
});

test('opened descriptor identity binds reuse-resistant metadata but ignores atime', () => {
  const validate = configModule.validateOpenedFileIdentity;
  const expected = regularStat();

  assert.doesNotThrow(() => validate(
    expected,
    regularStat({ atimeNs: 999n }),
    { label: 'CONFIG', platform: 'linux' },
  ));
  for (const field of ['birthtimeNs', 'ctimeNs', 'size', 'mtimeNs']) {
    assert.throws(
      () => validate(
        expected,
        regularStat({ [field]: expected[field] + 1n }),
        { label: 'CONFIG', platform: 'linux' },
      ),
      { code: 'CONFIG_FILE_CHANGED' },
      field,
    );
  }
});

test('extended identity rejects unavailable epoch-zero timestamps but permits an empty file', () => {
  const validate = configModule.validateOpenedFileIdentity;
  const empty = regularStat({ size: 0n });

  assert.doesNotThrow(() => validate(
    empty,
    regularStat({ size: 0n }),
    { label: 'CONFIG', platform: 'win32' },
  ));
  for (const field of ['birthtimeNs', 'ctimeNs', 'mtimeNs']) {
    assert.throws(
      () => validate(
        regularStat({ [field]: 0n }),
        regularStat({ [field]: 0n }),
        { label: 'CONFIG', platform: 'win32' },
      ),
      { code: 'CONFIG_FILE_CHANGED' },
      field,
    );
  }
});
