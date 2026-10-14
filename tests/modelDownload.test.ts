/**
 * Background-removal model download (`ensureModelFile`) over a stubbed `fetch`, no network.
 * The write side used to be an unpiped `createWriteStream`: a write error (ENOSPC/EACCES,
 * or the target vanishing) raised while the loop awaited the next chunk had NO listener,
 * became an uncaughtException and killed the server on the startup pre-warm path.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BG_MODELS, ensureModelFile, huggingFaceConfigUrl, type BgModelSpec } from '../src/bgremoval/models.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const BYTES = Buffer.alloc(256 * 1024, 7);
const md5 = (b: Buffer) => createHash('md5').update(b).digest('hex');
const spec = (hash = md5(BYTES)): BgModelSpec =>
  ({ key: 'isnet-general-use', filename: 'fake-model.onnx', url: 'https://models.invalid/fake-model.onnx', hash: { algo: 'md5', value: hash }, approxMB: 1 }) as unknown as BgModelSpec;

function serve(body: Buffer): void {
  globalThis.fetch = (async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } })) as typeof fetch;
}

describe('ensureModelFile', () => {
  it('downloads, verifies the checksum and renames into place', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'air-dl-'));
    serve(BYTES);
    const path = await ensureModelFile(spec(), dir);
    assert.equal(path, join(dir, 'fake-model.onnx'));
    assert.ok(readFileSync(path).equals(BYTES));
    assert.equal(existsSync(`${path}.part`), false);
  });

  it('a WRITE failure rejects cleanly (no uncaught stream error that would kill the server)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'air-dl-'));
    mkdirSync(join(dir, 'fake-model.onnx.part')); // the temp target is a directory → the write stream errors
    serve(BYTES);
    await assert.rejects(ensureModelFile(spec(), dir), /fake-model\.onnx/);
    assert.equal(existsSync(join(dir, 'fake-model.onnx')), false);
  });

  it('a checksum mismatch rejects and leaves no partial file behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'air-dl-'));
    serve(BYTES);
    await assert.rejects(ensureModelFile(spec('0'.repeat(32)), dir), /Checksum mismatch/);
    assert.equal(existsSync(join(dir, 'fake-model.onnx.part')), false);
    assert.equal(existsSync(join(dir, 'fake-model.onnx')), false);
  });
});

describe('Hugging Face config.json companion', () => {
  const HF_URL = 'https://huggingface.co/some-owner/some-repo/resolve/main/onnx/model.onnx';
  const hfSpec = (): BgModelSpec => ({ ...spec(), url: HF_URL });

  /** Serves BYTES for the model and `configBody` (or a status) for config.json; records every URL. */
  function serveRepo(configBody: string | number): string[] {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith('/config.json')) {
        return typeof configBody === 'number' ? new Response('nope', { status: configBody }) : new Response(configBody, { status: 200 });
      }
      return new Response(BYTES, { status: 200, headers: { 'content-length': String(BYTES.length) } });
    }) as typeof fetch;
    return urls;
  }

  it('derives the repo-root config.json URL, and only for huggingface.co', () => {
    assert.equal(huggingFaceConfigUrl(HF_URL), 'https://huggingface.co/some-owner/some-repo/resolve/main/config.json');
    assert.equal(huggingFaceConfigUrl('https://huggingface.co/o/r/resolve/abc123/BEN2_Base.onnx'), 'https://huggingface.co/o/r/resolve/abc123/config.json');
    assert.equal(huggingFaceConfigUrl('https://github.com/danielgatis/rembg/releases/download/v0.0.0/x.onnx'), null);
    assert.equal(huggingFaceConfigUrl('https://huggingface.co/o/r/blob/main/x.onnx'), null);
    assert.equal(huggingFaceConfigUrl('not a url'), null);
  });

  it('every Hugging Face model in the catalog resolves a config.json URL; the others do not', () => {
    for (const m of Object.values(BG_MODELS)) {
      const isHf = new URL(m.url).hostname === 'huggingface.co';
      assert.equal(huggingFaceConfigUrl(m.url) !== null, isHf, m.key);
    }
  });

  it('downloads config.json after the model and overwrites a config.json left by another model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'air-dl-'));
    writeFileSync(join(dir, 'config.json'), '{"model_type":"old"}');
    const urls = serveRepo('{"model_type":"swin"}');
    const path = await ensureModelFile(hfSpec(), dir);
    assert.deepEqual(urls, [HF_URL, 'https://huggingface.co/some-owner/some-repo/resolve/main/config.json']);
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{"model_type":"swin"}');
    assert.ok(readFileSync(path).equals(BYTES));
    assert.equal(existsSync(join(dir, 'config.json.part')), false);
  });

  it('a missing config.json (404) does not fail the download and leaves the old file alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'air-dl-'));
    writeFileSync(join(dir, 'config.json'), '{"keep":true}');
    serveRepo(404);
    const messages: string[] = [];
    const path = await ensureModelFile(hfSpec(), dir, (i) => messages.push(i.message));
    assert.ok(readFileSync(path).equals(BYTES));
    assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{"keep":true}');
    assert.ok(messages.some((m) => /Could not fetch .*config\.json.*404/.test(m)), messages.join(' | '));
    assert.equal(existsSync(join(dir, 'config.json.part')), false);
  });

  it('does not fetch config.json when the model download fails its checksum', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'air-dl-'));
    const urls = serveRepo('{}');
    await assert.rejects(ensureModelFile({ ...hfSpec(), hash: { algo: 'md5', value: '0'.repeat(32) } }, dir), /Checksum mismatch/);
    assert.deepEqual(urls, [HF_URL]);
  });

  it('a non-Hugging-Face model never requests a config.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'air-dl-'));
    const urls = serveRepo('{}');
    await ensureModelFile(spec(), dir);
    assert.deepEqual(urls, ['https://models.invalid/fake-model.onnx']);
    assert.equal(existsSync(join(dir, 'config.json')), false);
  });
});
