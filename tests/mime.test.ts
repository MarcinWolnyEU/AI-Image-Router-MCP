/**
 * The single magic-byte detector (`src/util/mime.ts`) that every input path uses, and
 * the AVIF/HEIC cases the five separate sniffers it replaced got wrong: AVIF labelled
 * `image/png` (Mistral vision skipped its re-encode), and any ISO-BMFF `ftyp` header
 * classified as VIDEO (an AVIF passed as base64 went to ffmpeg). Pure, no I/O.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { detectMedia, detectImageMime, isIcoSignature, sniffImageMime } from '../src/util/mime.js';
import { resolveMediaInput } from '../src/util/inputs.js';
import { buildIco, icoImageFromPng } from '../src/media/ico.js';

/** An ISO-BMFF `ftyp` box: major brand + compatible brands, then filler. */
function ftyp(major: string, compatible: string[] = []): Buffer {
  const size = 16 + 4 * compatible.length;
  const box = Buffer.alloc(size + 16);
  box.writeUInt32BE(size, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(major, 8, 'latin1');
  compatible.forEach((b, i) => box.write(b, 16 + 4 * i, 'latin1'));
  return box;
}

/** A video detection: the container's mime and the ffmpeg demuxer forced for it. */
const V = (mime: string, demuxer: string) => ({ kind: 'video', mime, demuxer });

const solid = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#336699' } });

describe('detectMedia: images', () => {
  it('recognises png / jpeg / webp / gif / tiff / avif produced by sharp', async () => {
    const formats = [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['webp', 'image/webp'], ['gif', 'image/gif'], ['tiff', 'image/tiff'], ['avif', 'image/avif']] as const;
    const cases: Array<[Buffer, string]> = [];
    for (const [format, mime] of formats) cases.push([await solid().toFormat(format).toBuffer(), mime]);
    for (const [bytes, mime] of cases) assert.deepEqual(detectMedia(bytes), { kind: 'image', mime }, mime);
  });

  it('an AVIF whose MAJOR brand is mif1 is still AVIF (compatible-brand scan)', () => {
    assert.deepEqual(detectMedia(ftyp('mif1', ['mif1', 'miaf', 'avif'])), { kind: 'image', mime: 'image/avif' });
  });

  it('HEIC / HEIF brands are images, not video', () => {
    assert.deepEqual(detectMedia(ftyp('heic', ['mif1', 'heic'])), { kind: 'image', mime: 'image/heic' });
    assert.deepEqual(detectMedia(ftyp('mif1', ['mif1'])), { kind: 'image', mime: 'image/heic' });
  });

  it('recognises an ICO, and a real BMP header', async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#ff000080' } }).png().toBuffer();
    assert.deepEqual(detectMedia(buildIco([icoImageFromPng(png)])), { kind: 'image', mime: 'image/x-icon' });
    const bmp = Buffer.alloc(64);
    bmp.write('BM', 0, 'latin1');
    bmp.writeUInt32LE(64, 2);
    bmp.writeUInt32LE(54, 10);
    bmp.writeUInt32LE(40, 14); // BITMAPINFOHEADER
    assert.deepEqual(detectMedia(bmp), { kind: 'image', mime: 'image/bmp' });
  });

  it('text that merely starts with "BM" or 00 00 01 00 is NOT an image', () => {
    assert.equal(detectMedia(Buffer.from('BMW makes cars, this is plain text and not a bitmap')), null);
    assert.equal(detectMedia(Buffer.from([0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0])), null, 'ICO with zero entries');
  });
});

describe('detectMedia: video', () => {
  it('mp4 / quicktime ftyp brands are video', () => {
    assert.deepEqual(detectMedia(ftyp('isom', ['isom', 'iso2', 'avc1', 'mp41'])), V('video/mp4', 'mov'));
    assert.deepEqual(detectMedia(ftyp('qt  ', ['qt  '])), V('video/quicktime', 'mov'));
  });

  it('EBML: webm vs matroska by doctype; RIFF AVI', () => {
    const ebml = (doctype: string) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from(doctype, 'latin1'), Buffer.alloc(16)]);
    assert.deepEqual(detectMedia(ebml('webm')), V('video/webm', 'matroska'));
    assert.deepEqual(detectMedia(ebml('matroska')), V('video/x-matroska', 'matroska'));
    const avi = Buffer.alloc(16);
    avi.write('RIFF', 0, 'latin1');
    avi.write('AVI ', 8, 'latin1');
    assert.deepEqual(detectMedia(avi), V('video/x-msvideo', 'avi'));
  });

  it('other movie containers: FLV, Ogg, ASF, MPEG-PS, MPEG-TS, and ftyp-less QuickTime', () => {
    const pad = (head: number[]) => Buffer.concat([Buffer.from(head), Buffer.alloc(32)]);
    assert.deepEqual(detectMedia(pad([0x46, 0x4c, 0x56, 0x01, 0x05])), V('video/x-flv', 'flv'));
    assert.deepEqual(detectMedia(pad([0x4f, 0x67, 0x67, 0x53, 0x00])), V('video/ogg', 'ogg'));
    assert.deepEqual(detectMedia(pad([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11])), V('video/x-ms-asf', 'asf'));
    assert.deepEqual(detectMedia(pad([0x00, 0x00, 0x01, 0xba])), V('video/mpeg', 'mpeg'));
    assert.deepEqual(detectMedia(pad([0x00, 0x00, 0x01, 0xb3])), V('video/mpeg', 'mpegvideo'), 'an elementary stream has its own demuxer');
    const ts = Buffer.alloc(564);
    for (const o of [0, 188, 376]) {
      ts[o] = 0x47;
      ts[o + 3] = 0x10; // payload only, unscrambled
    }
    assert.deepEqual(detectMedia(ts), V('video/mp2t', 'mpegts'));
    const moov = Buffer.alloc(32);
    moov.writeUInt32BE(32, 0);
    moov.write('moov', 4, 'latin1');
    assert.deepEqual(detectMedia(moov), V('video/quicktime', 'mov'));
  });

  it('a lone 0x47 byte, text that merely starts like a signature, or a playlist is not a video', () => {
    assert.equal(detectMedia(Buffer.from('G'.repeat(400))), null);
    assert.equal(detectMedia(Buffer.from('FLVxyz not a flv header')), null);
    assert.equal(detectMedia(Buffer.from('#EXTM3U\n#EXTINF:10,\nfile:///etc/passwd\n')), null);
  });

  it('no video signature can be met by text: Ogg, MPEG-TS and AVI need a binary byte', () => {
    const mpd = '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><BaseURL>C:/private/clip.mp4</BaseURL></MPD>';
    assert.equal(detectMedia(Buffer.from(`OggS ${mpd}`)), null, '"OggS" alone is printable');
    // "G" every 188 bytes with a printable 4th byte (`1` = adaptation 11, unscrambled) passes the packet checks.
    const text = Buffer.from(' '.repeat(564));
    for (const o of [0, 188, 376]) text.write('G 01', o, 'latin1');
    assert.equal(detectMedia(text), null, 'printable TS packet headers');
    assert.equal(detectMedia(Buffer.from(`RIFFAAAAAVI LISTAAAAhdrl ${mpd}`)), null, 'a printable RIFF size and LIST chunk');
  });

  /** A QuickTime atom header: the 4 size bytes, the type, then whatever follows. */
  const atom = (size: number[], type: string, rest: number[] = []) => Buffer.concat([Buffer.from(size), Buffer.from(type, 'latin1'), Buffer.from(rest), Buffer.alloc(24)]);
  const QUICKTIME = V('video/quicktime', 'mov');

  it('ftyp-less QuickTime: 64-bit, to-end-of-file and large first atoms, and a pnot preview', () => {
    assert.deepEqual(detectMedia(atom([0, 0, 0, 1], 'mdat', [0, 0, 0, 1, 0x40, 0, 0, 0])), QUICKTIME, 'size 1: a 64-bit size follows (a >4 GB capture)');
    assert.deepEqual(detectMedia(atom([0, 0, 0, 0], 'mdat')), QUICKTIME, 'size 0: the atom runs to the end of the file');
    assert.deepEqual(detectMedia(atom([0, 0, 0, 8], 'wide')), QUICKTIME);
    assert.deepEqual(detectMedia(atom([0, 0, 0, 0x14], 'pnot')), QUICKTIME);
    // A 1 GB mdat whose size happens to be four printable bytes: the payload still shows it is binary.
    assert.deepEqual(detectMedia(atom([0x40, 0x41, 0x42, 0x43], 'mdat', [0, 0, 0x2f, 0x1c, 0x65, 0x88, 0x84, 0])), QUICKTIME);
    // Same, but the first 8 payload bytes are printable too: an mdat's payload counts up to byte 64.
    assert.deepEqual(detectMedia(atom([0x40, 0x41, 0x42, 0x43], 'mdat', [...Buffer.from('ABCDEFGHIJKL'), 0x01])), QUICKTIME);
  });

  it('a first atom of exactly 256 bytes is QuickTime, not an ICO (both start 00 00 01 00)', () => {
    const mov = atom([0, 0, 1, 0], 'free');
    assert.deepEqual(detectMedia(mov), QUICKTIME);
    assert.equal(isIcoSignature(mov), false, 'the atom name read as an entry count is over 24,000');
  });

  it("the other first boxes ffmpeg's mov demuxer reads: older QuickTime atoms and fragmented-MP4 segments", () => {
    for (const type of ['junk', 'udta', 'pict', 'uuid']) assert.deepEqual(detectMedia(atom([0, 0, 0, 0x10], type)), QUICKTIME, type);
    for (const type of ['styp', 'sidx', 'moof']) assert.deepEqual(detectMedia(atom([0, 0, 0, 0x18], type)), V('video/mp4', 'mov'), type);
  });

  it('an atom size that cannot exist is not QuickTime', () => {
    assert.equal(detectMedia(atom([0, 0, 0, 5], 'moov')), null, 'smaller than its own 8-byte header');
    assert.equal(detectMedia(atom([0, 0, 0, 1], 'mdat', [0, 0, 0, 0, 0, 0, 0, 9])), null, 'a 64-bit size below its 16-byte header');
  });

  it('text with a box type at offset 4 is not a movie: a DASH manifest must never reach ffmpeg', () => {
    const manifest = (opening: string) => Buffer.from(`${opening}<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period><AdaptationSet><Representation id="1" bandwidth="1"><BaseURL>C:/private/clip.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>\n`);
    const openings = [
      '<!--free-->', '<!--wide-->', '<!--skip-->', '<!--moov-->', '<!--mdat-->', '<!--pnot-->',
      '<?\u00e9free ?>', // a processing instruction whose name starts with a non-ASCII letter
      '  <?free ?>',
      '<!--ftypjp2 -->', // ffmpeg scores an `ftyp` with a jp2 brand below its DASH probe
      '<!--ftypisom-->',
    ];
    for (const opening of openings) assert.equal(detectMedia(manifest(opening)), null, opening);
    assert.equal(detectMedia(Buffer.from('The free tier includes 100 requests per month.')), null);
    assert.equal(detectImageMime(Buffer.from('<!--ftypavif--><svg xmlns="http://www.w3.org/2000/svg"/>')), null, 'nor an AVIF');
  });

  it('unknown bytes → null (documents included: no tool accepts them)', () => {
    assert.equal(detectMedia(Buffer.from('hello world')), null);
    assert.equal(detectMedia(Buffer.alloc(0)), null);
    assert.equal(detectMedia(Buffer.from('%PDF-1.7\n')), null);
    assert.equal(detectMedia(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])), null, 'zip (DOCX/PPTX)');
  });
});

describe('image-mime helpers built on detectMedia', () => {
  it('detectImageMime is null for non-images (video, pdf, text)', () => {
    assert.equal(detectImageMime(ftyp('isom')), null);
    assert.equal(detectImageMime(Buffer.from('%PDF-1.4')), null);
    assert.equal(detectImageMime(Buffer.from('<html>')), null);
  });

  it('sniffImageMime labels AVIF as image/avif (it used to default to image/png)', async () => {
    assert.equal(sniffImageMime(await solid().avif().toBuffer()), 'image/avif');
    assert.equal(sniffImageMime(Buffer.from('opaque')), 'image/png', 'unknown bytes keep the png default');
  });
});

describe('resolveMediaInput classifies by magic bytes', () => {
  it('an AVIF passed as raw base64 is an IMAGE (not video/mp4)', async () => {
    const avif = await solid().avif().toBuffer();
    const r = await resolveMediaInput(avif.toString('base64'));
    assert.equal(r.kind, 'image');
    assert.equal(r.mimeType, 'image/avif');
  });

  it('a data: URL is classified by its bytes, not its declared mime', async () => {
    const avif = await solid().avif().toBuffer();
    const r = await resolveMediaInput(`data:video/mp4;base64,${avif.toString('base64')}`);
    assert.equal(r.kind, 'image');
    assert.equal(r.mimeType, 'image/avif');
  });

  it('a real mp4 header passed as base64 stays video', async () => {
    const r = await resolveMediaInput(ftyp('isom', ['isom', 'mp41']).toString('base64'));
    assert.equal(r.kind, 'video');
    assert.equal(r.mimeType, 'video/mp4');
  });

  it('a local file is typed by its leading bytes, not its extension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'air-mime-'));
    try {
      const jpegAsPng = join(dir, 'photo.png');
      await writeFile(jpegAsPng, await solid().jpeg().toBuffer());
      assert.deepEqual(await resolveMediaInput(jpegAsPng), { kind: 'image', mimeType: 'image/jpeg', path: jpegAsPng });
      const webmAsMp4 = join(dir, 'clip.mp4');
      await writeFile(webmAsMp4, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm'), Buffer.alloc(16)]));
      assert.deepEqual(await resolveMediaInput(webmAsMp4), { kind: 'video', mimeType: 'video/webm', path: webmAsMp4 });
      // No signature matches: the extension still names the kind (the video tools then refuse it).
      const playlist = join(dir, 'list.mp4');
      await writeFile(playlist, '#EXTM3U\n#EXTINF:10,\nfile:///etc/passwd\n');
      assert.equal((await resolveMediaInput(playlist)).kind, 'video');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
