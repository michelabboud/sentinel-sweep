import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRedactor,
  identityRedactor,
  isTrustedRedactor,
  parseSecretRef,
  resolveSecret,
} from '../../runtime/lib/secrets.mjs';

test('brands only module-constructed deterministic redactors', () => {
  const redact = createRedactor(['env:SENTINEL_TOKEN'], {
    SENTINEL_TOKEN: 'stable-secret',
  });
  assert.equal(isTrustedRedactor(identityRedactor), true);
  assert.equal(isTrustedRedactor(redact), true);
  assert.equal(isTrustedRedactor((value) => value), false);
  assert.equal(identityRedactor('unchanged'), 'unchanged');
  assert.equal(redact('stable-secret'), '[REDACTED]');
  assert.equal(redact('stable-secret'), '[REDACTED]');
});

test('parseSecretRef accepts only strict environment references', () => {
  assert.deepEqual(parseSecretRef('env:SENTINEL_ADMIN_TOKEN'), {
    kind: 'env',
    name: 'SENTINEL_ADMIN_TOKEN',
  });
  for (const ref of [
    'SENTINEL_ADMIN_TOKEN',
    'env:a',
    'env:lower_case',
    'env:1TOKEN',
    'file:/tmp/token',
    'env:SENTINEL-TOKEN',
  ]) {
    assert.throws(() => parseSecretRef(ref));
  }
});

test('resolveSecret returns the referenced value and never exposes missing values', () => {
  assert.equal(
    resolveSecret('env:SENTINEL_ADMIN_TOKEN', {
      SENTINEL_ADMIN_TOKEN: 'top-secret',
    }),
    'top-secret',
  );

  for (const env of [{}, { SENTINEL_ADMIN_TOKEN: '' }]) {
    assert.throws(
      () => resolveSecret('env:SENTINEL_ADMIN_TOKEN', env),
      (error) => {
        assert.equal(error.code, 'SECRET_UNAVAILABLE');
        assert.match(JSON.stringify(error), /SENTINEL_ADMIN_TOKEN/);
        assert.doesNotMatch(JSON.stringify(error), /top-secret/);
        return true;
      },
    );
  }
});

test('resolveSecret rejects inherited, accessor, non-enumerable, and proxy environment data', () => {
  const inherited = Object.create({ SENTINEL_ADMIN_TOKEN: 'inherited-secret' });
  let getterReads = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'SENTINEL_ADMIN_TOKEN', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return 'accessor-secret';
    },
  });
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'SENTINEL_ADMIN_TOKEN', {
    configurable: true,
    enumerable: false,
    value: 'hidden-secret',
  });
  let proxyReads = 0;
  const proxy = new Proxy({ SENTINEL_ADMIN_TOKEN: 'proxy-secret' }, {
    get(target, property, receiver) {
      proxyReads += 1;
      return Reflect.get(target, property, receiver);
    },
    getOwnPropertyDescriptor(target, property) {
      proxyReads += 1;
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
  });

  for (const env of [inherited, accessor, nonEnumerable, proxy]) {
    assert.throws(
      () => resolveSecret('env:SENTINEL_ADMIN_TOKEN', env),
      (error) => error?.code === 'SECRET_ENV_INVALID',
    );
  }
  assert.equal(getterReads, 0);
  assert.equal(proxyReads, 0);
});

test('createRedactor removes resolved values and common authorization encodings', () => {
  const env = { SENTINEL_ADMIN_TOKEN: 'top-secret' };
  const redact = createRedactor(['env:SENTINEL_ADMIN_TOKEN'], env);
  const basic = Buffer.from(`admin:${env.SENTINEL_ADMIN_TOKEN}`).toString('base64');
  const serializedBasic = Buffer.from(`user:${env.SENTINEL_ADMIN_TOKEN}`).toString('base64');

  assert.equal(redact('token top-secret'), 'token [REDACTED]');
  assert.equal(
    redact(`Authorization: Bearer top-secret\nAuthorization: Basic ${basic}`),
    'Authorization: Bearer [REDACTED]\nAuthorization: Basic [REDACTED]',
  );
  const serializedHeaders = redact(JSON.stringify({ Authorization: `Basic ${serializedBasic}` }));
  assert.doesNotMatch(serializedHeaders, new RegExp(serializedBasic, 'u'));
  const persistedError = redact(JSON.stringify({ error: `request failed: ${env.SENTINEL_ADMIN_TOKEN}` }));
  assert.doesNotMatch(persistedError, /top-secret/);
});

test('createRedactor ignores resolved values shorter than four characters', () => {
  const redact = createRedactor(['env:API_TOKEN'], { API_TOKEN: 'abc' });
  assert.equal(redact('alphabet abc'), 'alphabet abc');
});
