/**
 * Unit tests for the HTTP retry policy (src/util/http.ts) over a stubbed global
 * `fetch`: a POST may start a BILLED generation, so it is only re-sent when the
 * failure proves it was not processed (429, never-connected), never on a
 * timeout / 5xx / truncated 200, which are ambiguous. GETs keep full retries.
 * Also: token resolution never yields an empty secret.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayHttpError, getJson, postJson, rawRequest, requestNeverSent } from '../src/util/http.js';
import { resolveApiKey, resolveToken, ConfigError } from '../src/config/schema.js';

const realFetch = globalThis.fetch;
let calls = 0;

/** Install a fetch stub that plays `steps` in order (the last one repeats). */
function stubFetch(steps: Array<() => Response | Promise<Response>>): void {
  calls = 0;
  globalThis.fetch = (async () => {
    const step = steps[Math.min(calls, steps.length - 1)]!;
    calls += 1;
    return step();
  }) as typeof fetch;
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const text = (status: number, body: string) => () => new Response(body, { status });
const reject = (err: unknown) => () => Promise.reject(err);
/** undici's shape for a socket-level failure. */
const socketError = (code: string): Error => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) });
const timeoutError = (): Error => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('POST (non-idempotent) retry policy', () => {
  it('a 5xx is NOT re-sent (the provider may already be running/billing it)', async () => {
    stubFetch([json(502, { error: { message: 'upstream' } }), json(200, { ok: true })]);
    await assert.rejects(postJson('https://x.test/gen', { p: 1 }), (e: unknown) => e instanceof GatewayHttpError && e.status === 502);
    assert.equal(calls, 1);
  });

  it('a client-side timeout is NOT re-sent', async () => {
    stubFetch([reject(timeoutError()), json(200, { ok: true })]);
    await assert.rejects(postJson('https://x.test/gen', {}), /timeout/);
    assert.equal(calls, 1);
  });

  it('a connection reset (ambiguous: may have been received) is NOT re-sent', async () => {
    stubFetch([reject(socketError('ECONNRESET')), json(200, { ok: true })]);
    await assert.rejects(postJson('https://x.test/gen', {}));
    assert.equal(calls, 1);
  });

  it('a truncated 200 is NOT re-sent (it was accepted) and the error says so', async () => {
    stubFetch([text(200, '{"id":"job-1","sta'), json(200, { ok: true })]);
    await assert.rejects(postJson('https://x.test/gen', {}), /NOT re-sent/);
    assert.equal(calls, 1);
  });

  it('429 IS retried (rate-limited → not processed), honouring Retry-After', async () => {
    stubFetch([json(429, {}, { 'retry-after': '0.01' }), json(200, { ok: true })]);
    assert.deepEqual(await postJson('https://x.test/gen', {}), { ok: true });
    assert.equal(calls, 2);
  });

  it('a connection that never opened (ECONNREFUSED / DNS) IS retried', async () => {
    stubFetch([reject(socketError('ECONNREFUSED')), json(200, { ok: true })]);
    assert.deepEqual(await postJson('https://x.test/gen', {}, { retries: 1 }), { ok: true });
    assert.equal(calls, 2);
  });

  it('idempotent:true opts a harmless POST back into full retries', async () => {
    stubFetch([json(503, {}), json(200, { ok: true })]);
    assert.deepEqual(await postJson('https://x.test/agents', {}, { idempotent: true, retries: 1 }), { ok: true });
    assert.equal(calls, 2);
  });
});

describe('GET (idempotent) retry policy', () => {
  it('5xx and a truncated 200 are retried', async () => {
    stubFetch([json(500, {}), text(200, '{"partial'), json(200, { ok: 1 })]);
    assert.deepEqual(await getJson('https://x.test/status', { retries: 2 }), { ok: 1 });
    assert.equal(calls, 3);
  });

  it('a timeout is retried', async () => {
    stubFetch([reject(timeoutError()), json(200, { ok: 1 })]);
    assert.deepEqual(await getJson('https://x.test/status', { retries: 1 }), { ok: 1 });
    assert.equal(calls, 2);
  });

  it('rawRequest gives up after `retries` and returns the last response', async () => {
    stubFetch([json(500, { n: 1 })]);
    const res = await rawRequest('https://x.test/status', { retries: 1 });
    assert.equal(res.status, 500);
    assert.equal(calls, 2);
  });
});

describe('requestNeverSent', () => {
  it('recognises never-connected socket errors (incl. nested causes and AggregateError)', () => {
    assert.equal(requestNeverSent(socketError('ECONNREFUSED')), true);
    assert.equal(requestNeverSent(socketError('ENOTFOUND')), true);
    assert.equal(requestNeverSent(socketError('UND_ERR_CONNECT_TIMEOUT')), true);
    const agg = Object.assign(new TypeError('fetch failed'), {
      cause: new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ENETUNREACH' })]),
    });
    assert.equal(requestNeverSent(agg), true);
  });
  it('treats resets, timeouts, and mixed aggregates as possibly-sent', () => {
    assert.equal(requestNeverSent(socketError('ECONNRESET')), false);
    assert.equal(requestNeverSent(timeoutError()), false);
    const mixed = new AggregateError([Object.assign(new Error('a'), { code: 'ECONNREFUSED' }), Object.assign(new Error('b'), { code: 'ECONNRESET' })]);
    assert.equal(requestNeverSent(mixed), false);
    assert.equal(requestNeverSent(null), false);
  });
});

describe('resolveToken never returns an empty secret', () => {
  it('rejects an empty / whitespace inline token', async () => {
    await assert.rejects(resolveToken({ type: 'inline', value: '' }), ConfigError);
    await assert.rejects(resolveToken({ type: 'inline', value: '   ' }), /empty/);
  });
  it('rejects a set-but-blank env var, and an unset one', async () => {
    process.env['AIR_TEST_BLANK_TOKEN'] = '  \n';
    await assert.rejects(resolveToken({ type: 'env', value: 'AIR_TEST_BLANK_TOKEN' }), /is empty/);
    delete process.env['AIR_TEST_BLANK_TOKEN'];
    await assert.rejects(resolveToken({ type: 'env', value: 'AIR_TEST_BLANK_TOKEN' }), /not set/);
  });
  it('trims a real value', async () => {
    assert.equal(await resolveToken({ type: 'inline', value: '  abc  ' }), 'abc');
  });
});

describe('resolveApiKey only lets a key-shaped value leave the machine', () => {
  it("accepts every provider's key format", async () => {
    for (const key of ['sk-or-v1-0123abcd', '0f1e2d3c-aaaa-bbbb-cccc-000000000000:5ecret', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_-', 'AbCd1234']) {
      assert.equal(await resolveApiKey({ type: 'inline', value: key }), key);
    }
  });
  it('refuses a token file holding something other than one key, without echoing its contents', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'air-key-'));
    try {
      const pem = join(dir, 'wrong.txt');
      await writeFile(pem, '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n');
      await assert.rejects(resolveApiKey({ type: 'file', value: pem }), (err: Error) => {
        assert.ok(err instanceof ConfigError);
        assert.match(err.message, /does not hold a single API key/);
        assert.match(err.message, /wrong\.txt/);
        assert.doesNotMatch(err.message, /MIIEvQ|BEGIN/);
        return true;
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('refuses an oversized token file from its size alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'air-key-'));
    try {
      const big = join(dir, 'big.txt');
      await writeFile(big, Buffer.alloc(70 * 1024, 0x6b)); // one valid-looking run, but 70 KiB
      await assert.rejects(resolveApiKey({ type: 'file', value: big }), (err: Error) => err instanceof ConfigError && /over 64 KiB/.test(err.message));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('refuses a token path that is not a regular file (a directory, a device) without reading it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'air-key-'));
    try {
      await assert.rejects(resolveToken({ type: 'file', value: dir }), (err: Error) => err instanceof ConfigError && /not a regular file|could not be read/.test(err.message));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // `stat().size` is 0 for a device, so only the handle's own fstat (and a bounded read) stop an endless read.
    if (existsSync('/dev/zero')) await assert.rejects(resolveApiKey({ type: 'file', value: '/dev/zero' }), /not a regular file/);
  });
  it('refuses inner whitespace, non-ASCII and oversized values', async () => {
    await assert.rejects(resolveApiKey({ type: 'inline', value: 'Bearer sk-abc' }), /single API key/);
    await assert.rejects(resolveApiKey({ type: 'inline', value: 'klucz-żółw' }), /single API key/);
    await assert.rejects(resolveApiKey({ type: 'inline', value: 'k'.repeat(4097) }), /over 4096 characters/);
  });
  it('keeps resolveToken permissive (the HTTP auth secret never leaves the machine)', async () => {
    assert.equal(await resolveToken({ type: 'inline', value: 'my shared secret' }), 'my shared secret');
  });
});
