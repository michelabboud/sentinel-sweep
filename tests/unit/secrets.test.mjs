import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRedactor,
  parseSecretRef,
  resolveSecret,
} from '../../runtime/lib/secrets.mjs';

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
