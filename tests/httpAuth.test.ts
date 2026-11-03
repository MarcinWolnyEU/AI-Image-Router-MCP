/**
 * Unit tests for the HTTP transport's shared-secret check (src/util/httpAuth.ts): null = auth
 * off, an empty secret fails closed, either header may carry the token, and a near-miss (a
 * prefix, the secret plus extra bytes, zero padding) never passes the length-hiding compare.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isHttpRequestAuthorized } from '../src/util/httpAuth.js';

const SECRET = 's3cret-token-0123456789';
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('isHttpRequestAuthorized', () => {
  it('null expected means auth is off', () => {
    assert.equal(isHttpRequestAuthorized({}, null), true);
  });

  it('an empty expected secret denies everything', () => {
    assert.equal(isHttpRequestAuthorized({ 'x-api-key': '' }, ''), false);
    assert.equal(isHttpRequestAuthorized(bearer('anything'), ''), false);
  });

  it('accepts the token as Bearer (any scheme case, surrounding whitespace) or X-API-Key', () => {
    assert.equal(isHttpRequestAuthorized(bearer(SECRET), SECRET), true);
    assert.equal(isHttpRequestAuthorized({ authorization: `  bearer   ${SECRET}  ` }, SECRET), true);
    assert.equal(isHttpRequestAuthorized({ 'x-api-key': ` ${SECRET} ` }, SECRET), true);
  });

  it('either header may carry the right token', () => {
    assert.equal(isHttpRequestAuthorized({ ...bearer('wrong'), 'x-api-key': SECRET }, SECRET), true);
    assert.equal(isHttpRequestAuthorized({ ...bearer(SECRET), 'x-api-key': 'wrong' }, SECRET), true);
  });

  it('refuses no credentials, a non-Bearer scheme, and a wrong token of the same length', () => {
    assert.equal(isHttpRequestAuthorized({}, SECRET), false);
    assert.equal(isHttpRequestAuthorized({ authorization: `Basic ${SECRET}` }, SECRET), false);
    const sameLength = SECRET.slice(0, -1) + (SECRET.endsWith('9') ? '8' : '9');
    assert.equal(sameLength.length, SECRET.length);
    assert.equal(isHttpRequestAuthorized(bearer(sameLength), SECRET), false);
  });

  it('refuses a prefix of the secret and the secret plus trailing bytes', () => {
    assert.equal(isHttpRequestAuthorized(bearer(SECRET.slice(0, -1)), SECRET), false);
    assert.equal(isHttpRequestAuthorized(bearer(SECRET.slice(0, 1)), SECRET), false);
    assert.equal(isHttpRequestAuthorized(bearer(`${SECRET}x`), SECRET), false);
    assert.equal(isHttpRequestAuthorized(bearer(SECRET.repeat(20)), SECRET), false);
  });

  it('zero padding never stands in for the missing bytes (the length check is the last gate)', () => {
    // The candidate is zero-padded to the secret's length before the compare, so a secret that
    // ends in NUL bytes would equal its own NUL-stripped prefix byte for byte.
    assert.equal(isHttpRequestAuthorized({ 'x-api-key': 'abc' }, 'abc\0\0'), false);
    assert.equal(isHttpRequestAuthorized({ 'x-api-key': 'abc\0\0' }, 'abc\0\0'), true);
  });
});
