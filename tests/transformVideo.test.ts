/**
 * `transform_media` on VIDEO inputs, over the real tool on an in-memory MCP transport with
 * real ffmpeg (skipped when ffmpeg is not installed). No network, no cost.
 *
 *  - `output_format:"mp4"` on a non-mp4 container must actually transcode (it used to fall
 *    through to the passthrough and return the .mkv/.webm unchanged);
 *  - audio an mp4 can't carry as-is (PCM) is re-encoded instead of failing `-c:a copy`;
 *  - a passthrough keeps the real container extension (an .mkv was written as `.mp4`);
 *  - frame extraction from a video passed as BYTES works with a single temp copy.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { ffmpegAvailable, withVideoFile } from '../src/media/ffmpeg.js';
import { detectMedia } from '../src/util/mime.js';
import { makeFakeGateway, startMcpHarness, textOf, uriToPath, type McpHarness } from './helpers/mcp.js';

const FF_TIMEOUT = 60_000;
const hasFfmpeg = await ffmpegAvailable();

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} ${code}: ${err.slice(-300)}`))));
  });
}
/** Codec names of a file's streams, e.g. ['h264', 'aac']. */
async function codecs(path: string): Promise<string[]> {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path]);
  return out.trim().split(/\r?\n/).filter(Boolean);
}

let dir: string;
let mkvPath: string;
let mp4Path: string;
let h: McpHarness;

const call = (args: Record<string, unknown>) => h.call('transform_media', args);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'air-tv-'));
  if (hasFfmpeg) {
    mkvPath = join(dir, 'clip.mkv');
    mp4Path = join(dir, 'clip.mp4');
    // MPEG-4 Part 2 video + PCM audio in Matroska: PCM cannot be stream-copied into mp4.
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-shortest', mkvPath]);
    await run('ffmpeg', ['-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=64x48:rate=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', mp4Path]);
  }
  h = await startMcpHarness({
    gateway: makeFakeGateway(),
    image: { model: 'x/y' },
    outDir: join(dir, 'out'),
    clientName: 'transform-video-test',
    tmpPrefix: 'air-tv-',
  });
});

after(async () => {
  await h.close();
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('transform_media video', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  it('output_format mp4 on an .mkv TRANSCODES to a real mp4 (PCM audio re-encoded, not copied)', { timeout: FF_TIMEOUT }, async () => {
    const r = await call({ image: mkvPath, output_format: 'mp4' });
    assert.equal(r.isError, undefined, textOf(r));
    const link = r.content.find((c) => c.type === 'resource_link')!;
    assert.match(link.name ?? '', /\.mp4$/);
    const out = uriToPath(link.uri!);
    assert.equal(detectMedia(await readFile(out))?.mime, 'video/mp4', 'the bytes are an mp4 container, not the source mkv');
    assert.deepEqual(await codecs(out), ['h264', 'aac']);
  });

  it('output_format mp4 on an mp4 needs no re-encode: the file passes through unchanged', { timeout: FF_TIMEOUT }, async () => {
    const r = await call({ image: mp4Path, output_format: 'mp4' });
    assert.equal(r.isError, undefined, textOf(r));
    const link = r.content.find((c) => c.type === 'resource_link')!;
    assert.ok((await readFile(uriToPath(link.uri!))).equals(await readFile(mp4Path)));
  });

  it('downsizing an .mkv with PCM audio succeeds (audio is re-encoded for the mp4 container)', { timeout: FF_TIMEOUT }, async () => {
    const r = await call({ image: mkvPath, width: 32 });
    assert.equal(r.isError, undefined, textOf(r));
    const out = uriToPath(r.content.find((c) => c.type === 'resource_link')!.uri!);
    assert.deepEqual(await codecs(out), ['h264', 'aac']);
  });

  it('a passthrough keeps the real container extension (.mkv, not .mp4)', { timeout: FF_TIMEOUT }, async () => {
    const r = await call({ image: `data:video/x-matroska;base64,${(await readFile(mkvPath)).toString('base64')}` });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(r.content.find((c) => c.type === 'resource_link')!.name ?? '', /\.mkv$/);
  });

  it('extracts a still from a video passed as base64 bytes', { timeout: FF_TIMEOUT }, async () => {
    const r = await call({ image: (await readFile(mp4Path)).toString('base64'), output_format: 'png' });
    assert.equal(r.isError, undefined, textOf(r));
    const out = uriToPath(r.content.find((c) => c.type === 'resource_link')!.uri!);
    const meta = await sharp(await readFile(out)).metadata();
    assert.equal(meta.format, 'png');
    assert.equal(meta.width, 64);
  });
});

describe('ffmpeg temp input (no ffmpeg needed)', () => {
  it('bytes no signature identifies are never written for ffmpeg, whatever mime they claim', async () => {
    // An HLS playlist served as video/mp4: ffmpeg would pick its demuxer by content and follow it.
    const playlist = Buffer.from('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:10.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n');
    let called = false;
    await assert.rejects(
      withVideoFile({ kind: 'video', mimeType: 'video/mp4', bytes: playlist }, async () => {
        called = true;
      }),
      /not a recognized video/,
    );
    assert.equal(called, false);
  });

  it('a LOCAL file is gated too: an HLS playlist named clip.mp4 is refused, a real container passes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'air-gate-'));
    try {
      const fake = join(dir, 'clip.mp4');
      await writeFile(fake, '#EXTM3U\n#EXTINF:10.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n');
      let called = false;
      await assert.rejects(
        withVideoFile({ kind: 'video', mimeType: 'video/mp4', path: fake }, async () => {
          called = true;
        }),
        /not a recognized video/,
      );
      assert.equal(called, false);
      const real = join(dir, 'real.mkv');
      await writeFile(real, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....matroska....')]));
      assert.equal(await withVideoFile({ kind: 'video', mimeType: 'video/x-matroska', path: real }, async (m) => m.path), real);
      // A file that can't be read is refused, never passed on unchecked (a locked file fails the same read).
      const missing = join(dir, 'nope.mp4');
      await assert.rejects(
        withVideoFile({ kind: 'video', mimeType: 'video/mp4', path: missing }, async () => {
          called = true;
        }),
        /ENOENT/,
      );
      assert.equal(called, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a DASH manifest dressed as a QuickTime atom is refused, as bytes and as a local clip.mov', async () => {
    // ffmpeg's DASH probe finds `<MPD` anywhere, and the demuxer opens the BaseURL (a local file or a URL).
    const manifest = Buffer.from(
      '<!--free--><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period><AdaptationSet><Representation id="1" bandwidth="1"><BaseURL>C:/private/clip.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>\n',
    );
    const dir = await mkdtemp(join(tmpdir(), 'air-gate-'));
    try {
      const fake = join(dir, 'clip.mov');
      await writeFile(fake, manifest);
      let called = false;
      const reached = async () => {
        called = true;
      };
      await assert.rejects(withVideoFile({ kind: 'video', mimeType: 'video/quicktime', bytes: manifest }, reached), /not a recognized video/);
      await assert.rejects(withVideoFile({ kind: 'video', mimeType: 'video/quicktime', path: fake }, reached), /not a recognized video/);
      assert.equal(called, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a recognized container is written under the extension its bytes prove, not the claimed one', async () => {
    const ebml = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....matroska....')]);
    const seen = await withVideoFile({ kind: 'video', mimeType: 'video/mp4', bytes: ebml }, async (m) => ({ path: m.path, mime: m.mimeType, bytes: await readFile(m.path) }));
    assert.match(seen.path, /input\.mkv$/);
    assert.equal(seen.mime, 'video/x-matroska');
    assert.deepEqual(seen.bytes, ebml);
  });

  it('names the demuxer its signature proves, which every ffmpeg run forces with -f', async () => {
    const ebml = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('....matroska....')]);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypisom'), Buffer.alloc(24)]);
    const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(28)]);
    for (const [bytes, demuxer] of [[ebml, 'matroska'], [mp4, 'mov'], [ogg, 'ogg']] as const) {
      assert.equal(await withVideoFile({ kind: 'video', mimeType: 'video/mp4', bytes }, async (m) => m.demuxer), demuxer);
    }
  });

  it('an image never reaches ffmpeg, even when it claims to be a video', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } }).png().toBuffer();
    await assert.rejects(withVideoFile({ kind: 'video', mimeType: 'video/mp4', bytes: png }, async () => 'reached'), /not a recognized video/);
  });
});

describe('transform_media video passthrough (no ffmpeg needed)', () => {
  const mkvHeader = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('matroska'), Buffer.alloc(32)]);

  it('a local video in filePath mode is linked where it is, not read or copied', async () => {
    const src = join(dir, 'passthrough.mkv');
    await writeFile(src, mkvHeader);
    const r = await call({ image: src });
    assert.equal(r.isError, undefined, textOf(r));
    const link = r.content.find((c) => c.type === 'resource_link')!;
    assert.equal(link.uri, pathToFileURL(src).href);
    assert.equal(link.mimeType, 'video/x-matroska');
    assert.match(textOf(r), /\(unchanged\)/);
  });

  it('the container comes from the bytes: a webm named .mp4 is reported as webm', async () => {
    const src = join(dir, 'really-webm.mp4');
    await writeFile(src, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(32)]));
    const r = await call({ image: src, output_mode: 'base64' });
    assert.equal(r.isError, undefined, textOf(r));
    assert.match(textOf(r), /video\/webm/);
    assert.match(r.content.find((c) => c.type === 'resource_link')?.name ?? textOf(r), /\.webm/);
  });

  it('bytes no signature identifies are refused, whatever mime they were declared with', async () => {
    const playlist = Buffer.from('#EXTM3U\n#EXTINF:10.0,\nfile:///etc/passwd\n#EXT-X-ENDLIST\n');
    const r = await call({ image: `data:video/mp4;base64,${playlist.toString('base64')}`, output_mode: 'base64' });
    assert.equal(r.isError, true);
    assert.match(textOf(r), /not a recognized video/);
  });
});
