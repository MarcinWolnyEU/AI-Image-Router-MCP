/**
 * Integration tests for reference-image resolution (`generate_image`'s
 * `reference_images`). Exercises the real code paths end-to-end: local files,
 * data/base64 inputs, remote downloads over a live HTTP server, the
 * `z-download-` save+dedup+sanitize behavior, magic-byte format detection, and
 * the fail-closed contract (any bad input ⇒ no generation).
 *
 * Run: `npm test`  (node:test via tsx, no test framework dependency).
 */
import { after, before, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, open, readFile, readdir, writeFile, type FileHandle } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { decodeRawBase64, resolveImageInput, resolveMediaInput, resolveReferenceImages } from '../src/util/inputs.js';
import { saveDownloadCopy, saveFileGroup, sanitizeFilename } from '../src/util/files.js';

// A real 1×1 PNG (valid header → detected as image/png).
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Minimal temp dir for a test. */
async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'airef-'));
}

// ── A live HTTP server serving various reference payloads ────────────────────
let server: Server;
let base = '';
let jpeg: Buffer;
let webp: Buffer;

before(async () => {
  jpeg = await sharp(PNG_1x1).jpeg().toBuffer();
  webp = await sharp(PNG_1x1).webp().toBuffer();
  const asPng = (body: Buffer | string) => ({ status: 200, type: 'image/png', body });
  const routes: Record<string, { status: number; type?: string; body: Buffer | string }> = {
    '/pic.png': asPng(PNG_1x1),
    '/photo.jpg': { status: 200, type: 'image/jpeg', body: jpeg },
    // No extension in the URL; extension must come from the mime type.
    '/noext': asPng(PNG_1x1),
    // Valid image bytes whose URL names some other extension.
    '/payload.html': asPng(PNG_1x1),
    '/mislabelled.jpg': asPng(PNG_1x1),
    '/photo.jpeg': asPng(jpeg),
    // A filename that percent-encodes to more than a filesystem allows.
    [`/${'%E6%97%A5'.repeat(30)}.png`]: asPng(PNG_1x1),
    // Claims to be a PNG but the bytes are HTML; magic-byte check must reject.
    '/lies.png': asPng('<!doctype html><html>nope</html>'),
    '/missing': { status: 404, body: 'not found' },
  };
  server = createServer((req, res) => {
    const route = routes[(req.url ?? '').split('?')[0]!] ?? { status: 404, body: 'unknown' };
    res.writeHead(route.status, route.type ? { 'content-type': route.type } : {}).end(route.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('reference resolution: local & inline inputs', () => {
  it('resolves a valid local PNG file', async () => {
    const dir = await tmp();
    const file = join(dir, 'ref.png');
    await writeFile(file, PNG_1x1);
    const { references, errors, downloads } = await resolveReferenceImages([file]);
    assert.equal(errors.length, 0);
    assert.equal(downloads.length, 0, 'local files are not re-saved as downloads');
    assert.equal(references.length, 1);
    assert.equal(references[0]!.mimeType, 'image/png');
    assert.ok((references[0]!.bytes?.length ?? 0) > 0);
    assert.equal(references[0]!.role, 'reference');
  });

  it('rejects a missing local path (fail-closed)', async () => {
    const { references, errors } = await resolveReferenceImages([join(await tmp(), 'does-not-exist.png')]);
    assert.equal(references.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /local file not found/);
  });

  it('rejects a local file that is not an image', async () => {
    const dir = await tmp();
    const file = join(dir, 'notes.txt');
    await writeFile(file, 'just some text, definitely not an image');
    const { references, errors } = await resolveReferenceImages([file]);
    assert.equal(references.length, 0);
    assert.match(errors[0]!, /not a recognized image/);
  });

  it('resolves a data: URL and raw base64', async () => {
    const dataUrl = `data:image/png;base64,${PNG_1x1.toString('base64')}`;
    const rawB64 = PNG_1x1.toString('base64');
    const { references, errors } = await resolveReferenceImages([dataUrl, rawB64]);
    assert.equal(errors.length, 0);
    assert.equal(references.length, 2);
    assert.ok(references.every((r) => r.mimeType === 'image/png'));
  });

  it('accepts raw base64 that CONTAINS "/" (decided by content, not the path heuristic)', async () => {
    // A real image whose base64 has slashes; nearly every non-trivial one does.
    const raw = Buffer.from(Array.from({ length: 32 * 32 * 3 }, (_, i) => (i * 37 + (i >> 5) * 11) & 255));
    const img = await sharp(raw, { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer();
    const b64 = img.toString('base64');
    assert.ok(b64.includes('/'), 'fixture must contain a "/"');
    const wrapped = b64.replace(/(.{76})/g, '$1\n'); // MIME line wraps are base64 too
    const { references, errors } = await resolveReferenceImages([b64, wrapped]);
    assert.deepEqual(errors, []);
    assert.equal(references.length, 2);
    assert.ok(references.every((r) => r.mimeType === 'image/png'));
  });

  it('a slash-y string that is neither an image nor a file still reads as a missing file', async () => {
    const { errors } = await resolveReferenceImages(['/tmp/abc', 'C:\\nope\\x.png', 'not base64 at all!']);
    assert.match(errors[0]!, /local file not found/);
    assert.match(errors[1]!, /local file not found/);
    assert.match(errors[2]!, /not a URL, data URL, readable file path, or base64 image/);
  });

  it('detects formats by magic bytes, not extension (png/jpeg/webp/gif/bmp/tiff)', async () => {
    const dir = await tmp();
    const cases: Array<[string, Buffer, string]> = [
      ['a.png', PNG_1x1, 'image/png'],
      ['b.jpg', jpeg, 'image/jpeg'],
      ['c.webp', webp, 'image/webp'],
      // header-only buffers are enough; resolution validates the signature, not the full file
      ['d.gif', Buffer.from('GIF89a\x00\x00', 'binary'), 'image/gif'],
      // BMP: 14-byte file header + the 40-byte BITMAPINFOHEADER size (a bare "BM" is too weak a signature)
      ['e.bmp', Buffer.from('BM\x46\x00\x00\x00\x00\x00\x00\x00\x36\x00\x00\x00\x28\x00\x00\x00', 'binary'), 'image/bmp'],
      ['f.tif', Buffer.from('II\x2a\x00\x00\x00', 'binary'), 'image/tiff'],
    ];
    const paths: string[] = [];
    for (const [name, bytes] of cases) {
      const p = join(dir, name);
      await writeFile(p, bytes);
      paths.push(p);
    }
    const { references, errors } = await resolveReferenceImages(paths);
    assert.equal(errors.length, 0, `unexpected errors: ${errors.join('; ')}`);
    assert.deepEqual(
      references.map((r) => r.mimeType),
      cases.map((c) => c[2]),
    );
  });

  it('rejects a data: URL whose declared image mime lies about its bytes (fail-closed, like files/URLs)', async () => {
    const html = `data:image/png;base64,${Buffer.from('<!doctype html><html>nope</html>').toString('base64')}`;
    const truncated = `data:image/png;base64,${Buffer.from('not-a-real-image').toString('base64')}`;
    const { references, errors } = await resolveReferenceImages([html, truncated]);
    assert.equal(references.length, 0, 'no reference may pass on the strength of its declared mime alone');
    assert.equal(errors.length, 2);
    for (const e of errors) assert.match(e, /not a recognized image/);
  });

  it('a data: URL is labelled by its bytes, not its declared mime', async () => {
    const { references, errors } = await resolveReferenceImages([`data:image/png;base64,${jpeg.toString('base64')}`]);
    assert.equal(errors.length, 0);
    assert.equal(references[0]!.mimeType, 'image/jpeg');
  });

  it('rejects a file whose extension says image but bytes are not', async () => {
    const dir = await tmp();
    const file = join(dir, 'fake.png');
    await writeFile(file, Buffer.from('<html>not a png</html>'));
    const { references, errors } = await resolveReferenceImages([file]);
    assert.equal(references.length, 0);
    assert.match(errors[0]!, /not a recognized image/);
  });
});

describe('reference resolution: remote downloads', () => {
  it('downloads a remote image and saves a z-download- copy', async () => {
    const dir = await tmp();
    const { references, downloads, errors } = await resolveReferenceImages([`${base}/pic.png`], { downloadDir: dir });
    assert.equal(errors.length, 0);
    assert.equal(references.length, 1);
    assert.equal(references[0]!.mimeType, 'image/png');
    assert.equal(downloads.length, 1);
    const saved = downloads[0]!;
    assert.ok(existsSync(saved));
    assert.equal(basename(saved), 'z-download-pic.png');
    // The model is served our downloaded bytes, never the URL.
    assert.ok((references[0]!.bytes?.length ?? 0) > 0);
    assert.deepEqual(await readFile(saved), PNG_1x1);
  });

  it('derives the extension from the mime type when the URL has none', async () => {
    const dir = await tmp();
    const { downloads, errors } = await resolveReferenceImages([`${base}/noext`], { downloadDir: dir });
    assert.equal(errors.length, 0);
    assert.equal(basename(downloads[0]!), 'z-download-noext.png');
  });

  it('names the saved copy from its verified bytes, never from the extension in the URL', async () => {
    const cases: Array<[string, string]> = [
      ['/payload.html', 'z-download-payload.png'], // active content can't land on disk under its own extension
      ['/mislabelled.jpg', 'z-download-mislabelled.png'],
      ['/photo.jpeg', 'z-download-photo.jpg'],
    ];
    for (const [path, expected] of cases) {
      const dir = await tmp();
      const { downloads, errors } = await resolveReferenceImages([`${base}${path}`], { downloadDir: dir });
      assert.equal(errors.length, 0, path);
      assert.equal(basename(downloads[0]!), expected);
    }
  });

  it('a URL filename too long for the filesystem still resolves, under a shortened name', async () => {
    const dir = await tmp();
    const { references, downloads, errors } = await resolveReferenceImages([`${base}/${'日'.repeat(30)}.png`], { downloadDir: dir });
    assert.deepEqual(errors, []);
    assert.equal(references.length, 1);
    assert.match(basename(downloads[0]!), /^z-download-(%E6%97%A5)+.*\.png$/);
    assert.ok(existsSync(downloads[0]!));
  });

  it('does not save a copy when no downloadDir is given', async () => {
    const { references, downloads, errors } = await resolveReferenceImages([`${base}/pic.png`]);
    assert.equal(errors.length, 0);
    assert.equal(references.length, 1);
    assert.equal(downloads.length, 0);
  });

  it('dedups colliding download names with -1, -2 …', async () => {
    const dir = await tmp();
    const { downloads, errors } = await resolveReferenceImages(
      [`${base}/pic.png`, `${base}/pic.png`, `${base}/pic.png`],
      { downloadDir: dir },
    );
    assert.equal(errors.length, 0);
    const names = downloads.map((p) => basename(p)).sort();
    assert.deepEqual(names, ['z-download-pic-1.png', 'z-download-pic-2.png', 'z-download-pic.png'].sort());
    // All three actually exist on disk and are distinct.
    assert.equal(new Set(names).size, 3);
    const onDisk = (await readdir(dir)).filter((f) => f.startsWith('z-download-'));
    assert.equal(onDisk.length, 3);
  });

  it('fails closed on HTTP 404 (no reference, clear error)', async () => {
    const dir = await tmp();
    const { references, downloads, errors } = await resolveReferenceImages([`${base}/missing`], { downloadDir: dir });
    assert.equal(references.length, 0);
    assert.equal(downloads.length, 0);
    assert.match(errors[0]!, /could not download \(HTTP 404\)/);
  });

  it('rejects a download whose bytes are not a real image', async () => {
    const { references, errors } = await resolveReferenceImages([`${base}/lies.png`]);
    assert.equal(references.length, 0);
    assert.match(errors[0]!, /not a recognized image/);
  });

  it('reports a connection failure clearly (refused port)', async () => {
    // Port 1 is not listening → fast connection error (exercises the catch path).
    const { references, errors } = await resolveReferenceImages(['http://127.0.0.1:1/x.png']);
    assert.equal(references.length, 0);
    assert.match(errors[0]!, /could not download|timed out/);
  });
});

describe('fail-closed batch semantics', () => {
  it('a mixed batch surfaces the good reference AND the per-input error', async () => {
    const dir = await tmp();
    const good = join(dir, 'good.png');
    await writeFile(good, PNG_1x1);
    const { references, errors } = await resolveReferenceImages([good, join(dir, 'nope.png')]);
    // The resolver returns both; the tool refuses to generate whenever errors is non-empty.
    assert.equal(references.length, 1);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /nope\.png/);
  });
});

describe('saveDownloadCopy / sanitizeFilename', () => {
  it('sanitizes invalid filename characters to "-"', () => {
    assert.equal(sanitizeFilename('a:b*c?'), 'a-b-c-');
    assert.equal(sanitizeFilename('  spaced  name '), 'spaced--name');
    assert.equal(sanitizeFilename('....'), 'file');
  });

  it('caps a long name without splitting a character or leaving a trailing dot', () => {
    assert.equal(sanitizeFilename('a'.repeat(300)), 'a'.repeat(120));
    const cjk = sanitizeFilename(`a${'日'.repeat(100)}`); // the byte limit falls inside a character
    assert.equal(cjk, `a${'日'.repeat(39)}`);
    assert.equal(sanitizeFilename(`${'a'.repeat(119)}.${'b'.repeat(50)}`), 'a'.repeat(119));
  });

  it('prefixes z-download-, sanitizes, and dedups against disk', async () => {
    const dir = await tmp();
    const a = await saveDownloadCopy(dir, PNG_1x1, 'we:rd*name.png');
    const b = await saveDownloadCopy(dir, PNG_1x1, 'we:rd*name.png');
    assert.equal(basename(a.path), 'z-download-we-rd-name.png');
    assert.equal(basename(b.path), 'z-download-we-rd-name-1.png');
    assert.ok(existsSync(a.path) && existsSync(b.path));
  });

  it('never overwrites a file already on disk (EEXIST → next suffix)', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'z-download-pic.png'), 'ORIGINAL');
    await writeFile(join(dir, 'z-download-pic-1.png'), 'ORIGINAL-1');
    const saved = await saveDownloadCopy(dir, PNG_1x1, 'pic.png');
    assert.equal(basename(saved.path), 'z-download-pic-2.png');
    assert.equal(await readFile(join(dir, 'z-download-pic.png'), 'utf8'), 'ORIGINAL');
    assert.equal(await readFile(join(dir, 'z-download-pic-1.png'), 'utf8'), 'ORIGINAL-1');
    assert.ok((await readFile(saved.path)).equals(PNG_1x1));
  });

  it('skips a name occupied by a directory instead of failing or looping', async () => {
    const dir = await tmp();
    await mkdir(join(dir, 'z-download-pic.png'));
    const saved = await saveDownloadCopy(dir, PNG_1x1, 'pic.png');
    assert.equal(basename(saved.path), 'z-download-pic-1.png');
  });

  it('concurrent saves get distinct files and keep their own bytes', async () => {
    const dir = await tmp();
    const payloads = [0, 1, 2, 3].map((i) => Buffer.from(`payload-${i}`));
    const saved = await Promise.all(payloads.map((p) => saveDownloadCopy(dir, p, 'same.bin')));
    assert.equal(new Set(saved.map((s) => s.path)).size, payloads.length);
    for (const [i, s] of saved.entries()) assert.equal(await readFile(s.path, 'utf8'), `payload-${i}`);
  });

  it('a write that fails partway leaves no partial copy', async (t) => {
    const dir = await tmp();
    await instrumentWrites(t, 1);
    await assert.rejects(saveDownloadCopy(dir, PNG_1x1, 'pic.png'), /ENOSPC/);
    assert.deepEqual(await readdir(dir), []);
  });
});

/**
 * Counts writes through a FileHandle (returned as a getter). With `failOn`, that write puts one
 * byte on disk and then fails the way a full disk does, after the file was created.
 */
async function instrumentWrites(t: TestContext, failOn?: number): Promise<() => number> {
  const probe = await open(join(await tmp(), 'probe'), 'w');
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  const realWrite = proto.writeFile;
  let count = 0;
  t.mock.method(proto, 'writeFile', async function (this: FileHandle, data: Buffer) {
    count++;
    if (count !== failOn) return realWrite.call(this, data);
    await this.write(data.subarray(0, 1));
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  });
  return () => count;
}

describe('saveFileGroup', () => {
  const group = (tag: string) => [
    { suffix: '-16x16.png', bytes: Buffer.from(`${tag}-16`) },
    { suffix: '-32x32.png', bytes: Buffer.from(`${tag}-32`) },
  ];

  it('a taken name costs no writes: bytes go out only once the whole group has its names', async (t) => {
    const dir = await tmp();
    await writeFile(join(dir, 'icon-32x32.png'), 'ORIGINAL');
    const writes = await instrumentWrites(t);
    const saved = await saveFileGroup(dir, 'icon', group('new'));
    assert.deepEqual(saved.map((s) => s.filename), ['icon-2-16x16.png', 'icon-2-32x32.png']);
    assert.equal(writes(), 2);
  });

  it('a write that fails partway removes the partial file and the rest of the group, and nothing else', async (t) => {
    const dir = await tmp();
    await writeFile(join(dir, 'unrelated.png'), 'ORIGINAL');
    await instrumentWrites(t, 2); // the first file is complete, the second is cut off
    await assert.rejects(saveFileGroup(dir, 'icon', group('new')), /ENOSPC/);
    assert.deepEqual(await readdir(dir), ['unrelated.png']);
    assert.equal(await readFile(join(dir, 'unrelated.png'), 'utf8'), 'ORIGINAL');
  });

  it('moves the whole group to the next stem when any name is taken, leaving no stray file', async () => {
    const dir = await tmp();
    await writeFile(join(dir, 'icon-32x32.png'), 'ORIGINAL');
    const saved = await saveFileGroup(dir, 'icon', group('new'));
    assert.deepEqual(saved.map((s) => s.filename), ['icon-2-16x16.png', 'icon-2-32x32.png']);
    assert.deepEqual((await readdir(dir)).sort(), ['icon-2-16x16.png', 'icon-2-32x32.png', 'icon-32x32.png']);
    assert.equal(await readFile(join(dir, 'icon-32x32.png'), 'utf8'), 'ORIGINAL');
  });

  it('concurrent groups with one stem never share or overwrite a file', async () => {
    const dir = await tmp();
    const tags = ['a', 'b', 'c', 'd'];
    const groups = await Promise.all(tags.map((t) => saveFileGroup(dir, 'icon', group(t))));
    assert.equal(new Set(groups.flat().map((s) => s.path)).size, tags.length * 2);
    for (const [i, g] of groups.entries()) {
      assert.equal(await readFile(g[0]!.path, 'utf8'), `${tags[i]}-16`);
      assert.equal(await readFile(g[1]!.path, 'utf8'), `${tags[i]}-32`);
    }
    assert.equal((await readdir(dir)).length, tags.length * 2, 'no stray file from an abandoned attempt');
  });

  it('a failed write releases the files this attempt created', async () => {
    const dir = await tmp();
    const files = [
      { suffix: '-16x16.png', bytes: Buffer.from('x') },
      { suffix: '/missing-dir/x.png', bytes: Buffer.from('y') },
    ];
    await assert.rejects(saveFileGroup(dir, 'icon', files), /ENOENT/);
    assert.deepEqual(await readdir(dir), []);
  });

  it('refuses a repeated suffix instead of searching for a free stem forever', async () => {
    const dir = await tmp();
    const repeated = [
      { suffix: '-16x16.png', bytes: Buffer.from('x') },
      { suffix: '-16X16.PNG', bytes: Buffer.from('y') },
    ];
    await assert.rejects(saveFileGroup(dir, 'icon', repeated), /Duplicate filename suffix/);
    assert.deepEqual(await readdir(dir), []);
  });
});

describe('resolveImageInput / resolveMediaInput (mp4 image_to_video, remove_background, crop/transform)', () => {
  // ISO-BMFF `ftyp` box with an mp4 brand, which detectMedia classifies as video/mp4.
  const MP4_HEAD = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42', 'latin1'), Buffer.alloc(16)]);

  it('refuses a VIDEO handed in as an image, before anything is sent (it used to go out labelled image/png)', async () => {
    const dir = await tmp();
    const file = join(dir, 'clip.mp4');
    await writeFile(file, MP4_HEAD);
    await assert.rejects(resolveImageInput(file), /is a video \(video\/mp4\), not a still image/);
    await assert.rejects(resolveImageInput(`data:image/png;base64,${MP4_HEAD.toString('base64')}`), /is a video/);
  });

  it('accepts raw base64 with "/" and labels it by its bytes', async () => {
    const img = await sharp({ create: { width: 24, height: 24, channels: 3, background: '#3a7bd5' } }).jpeg().toBuffer();
    const r = await resolveImageInput(img.toString('base64'));
    assert.equal(r.mimeType, 'image/jpeg');
  });

  it('a missing path is reported as a missing file, not decoded as base64 garbage', async () => {
    await assert.rejects(resolveImageInput('C:\\nope\\photo.png'), /local file not found/);
    await assert.rejects(resolveMediaInput('C:\\nope\\photo.png'), /local file not found/);
    await assert.rejects(resolveMediaInput('/tmp/abc'), /local file not found/);
    const ok = await resolveMediaInput(PNG_1x1.toString('base64'));
    assert.equal(ok.kind, 'image');
  });

  it('decodeRawBase64 is strict: alphabet + clean round-trip only', () => {
    assert.ok(decodeRawBase64(PNG_1x1.toString('base64')));
    assert.equal(decodeRawBase64('C:\\x\\y.png'), null);
    assert.equal(decodeRawBase64('hello world!'), null);
    assert.equal(decodeRawBase64('abc'), null, 'too short to be data');
  });
});
