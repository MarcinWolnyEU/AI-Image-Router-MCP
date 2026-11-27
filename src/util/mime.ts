/**
 * The ONE magic-byte detector for every input the tools accept: images and video
 * containers. Everything else (`detectImageMime`, `sniffImageMime`, media-kind
 * resolution in `util/inputs.ts`) is built on it, so a format is added in one place.
 * It replaced five ad-hoc sniffers whose drifting coverage sent AVIF to a provider
 * labelled `image/png` and classified every ISO-BMFF `ftyp` file (AVIF/HEIC included)
 * as video.
 *
 * Magic bytes are authoritative: callers must not let a declared mime (data: URL,
 * content-type header) override a detection, and `null` means "not a format we
 * accept", which fail-closed callers refuse.
 */

export type DetectedKind = 'image' | 'video';

export interface DetectedMedia {
  kind: DetectedKind;
  mime: string;
  /**
   * Videos only: the ffmpeg demuxer for this container. `media/ffmpeg.ts` forces it with `-f`,
   * so ffmpeg never picks a demuxer from the content (HLS and DASH open other files).
   */
  demuxer?: string;
}

const video = (mime: string, demuxer: string): DetectedMedia => ({ kind: 'video', mime, demuxer });

/** ISO-BMFF brands that make an `ftyp` file a still image rather than a movie. */
const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);

/** BITMAPINFOHEADER-family sizes a real BMP declares at offset 14. */
const BMP_DIB_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);

const ascii = (b: Buffer, start: number, end: number): string => b.toString('latin1', start, end);

/** Major + compatible brands of a leading `ftyp` box (lowercased), or null when there is none. */
function ftypBrands(b: Buffer): string[] | null {
  if (b.length < 12 || ascii(b, 4, 8) !== 'ftyp') return null;
  const boxSize = b.readUInt32BE(0);
  const end = Math.min(b.length, boxSize >= 16 ? boxSize : 12);
  const brands = [ascii(b, 8, 12)];
  for (let o = 16; o + 4 <= end; o += 4) brands.push(ascii(b, o, o + 4));
  return brands.map((s) => s.toLowerCase());
}

/**
 * Most entries an ICO directory may declare. Real icons hold a few dozen at most. A QuickTime
 * file whose first atom is 256 bytes also starts `00 00 01 00`, and its atom name then lands in
 * the count field, which reads as over 24,000 entries.
 */
const MAX_ICO_ENTRIES = 512;

/**
 * An ICO directory: reserved 0, type 1, 1 to `MAX_ICO_ENTRIES` entries, and a first entry whose
 * reserved byte is 0 and whose plane count is 0 or 1. Four bytes alone (`00 00 01 00`) also start
 * MPEG start codes, so the first entry is checked too.
 */
export function isIcoSignature(b: Buffer): boolean {
  if (b.length < 22 || b[0] !== 0 || b[1] !== 0 || b[2] !== 1 || b[3] !== 0) return false;
  const count = b.readUInt16LE(4);
  const planes = b.readUInt16LE(10);
  return count > 0 && count <= MAX_ICO_ENTRIES && b[9] === 0 && planes <= 1;
}

const startsWith = (b: Buffer, sig: readonly number[]): boolean => sig.every((v, i) => b[i] === v);

/** Formats identified purely by their leading bytes. */
const PREFIX_SIGNATURES: ReadonlyArray<{ sig: readonly number[]; media: DetectedMedia }> = [
  { sig: [0x89, 0x50, 0x4e, 0x47], media: { kind: 'image', mime: 'image/png' } },
  { sig: [0xff, 0xd8, 0xff], media: { kind: 'image', mime: 'image/jpeg' } },
  { sig: [0x47, 0x49, 0x46, 0x38], media: { kind: 'image', mime: 'image/gif' } }, // "GIF8"
  { sig: [0x49, 0x49, 0x2a, 0x00], media: { kind: 'image', mime: 'image/tiff' } }, // little-endian
  { sig: [0x4d, 0x4d, 0x00, 0x2a], media: { kind: 'image', mime: 'image/tiff' } }, // big-endian
];

type Detector = (b: Buffer) => DetectedMedia | null;

const detectPrefixSignature: Detector = (b) => PREFIX_SIGNATURES.find((e) => startsWith(b, e.sig))?.media ?? null;

/** A byte no text document holds: a C0 control character other than tab, LF and CR. */
const isBinaryByte = (v: number): boolean => v < 0x20 && v !== 0x09 && v !== 0x0a && v !== 0x0d;
const hasBinaryByte = (b: Buffer, start: number, end: number): boolean => b.subarray(start, end).some(isBinaryByte);

/**
 * RIFF container: WebP still or AVI movie. `RIFF`, a size and `AVI ` can all be printable, so an
 * AVI also needs a binary byte in the 12 bytes after the form type: a real one has its `LIST`
 * chunk there, whose size of a few KB starts with `00`.
 */
const detectRiff: Detector = (b) => {
  if (b.length < 12 || ascii(b, 0, 4) !== 'RIFF') return null;
  const form = ascii(b, 8, 12);
  if (form === 'WEBP') return { kind: 'image', mime: 'image/webp' };
  if (form === 'AVI ' && hasBinaryByte(b, 12, 24)) return video('video/x-msvideo', 'avi');
  return null;
};

/** "BM" plus a real DIB header size. A bare "BM" also starts plenty of text. */
const detectBmp: Detector = (b) =>
  b.length >= 18 && b[0] === 0x42 && b[1] === 0x4d && b.readUInt32LE(6) === 0 && BMP_DIB_SIZES.has(b.readUInt32LE(14))
    ? { kind: 'image', mime: 'image/bmp' }
    : null;

const detectIco: Detector = (b) => (isIcoSignature(b) ? { kind: 'image', mime: 'image/x-icon' } : null);

/**
 * ISO-BMFF and QuickTime open with a box: a big-endian size, then a 4-character type. The type
 * alone proves nothing, because text can spell it at offset 4: `<!--free--><MPD …>` is a DASH
 * manifest, and ffmpeg (whose DASH probe finds `<MPD` anywhere) would follow it to local files and
 * URLs. So the header must also be binary. A size below 16 MB starts with 0x00 and a 64-bit one
 * with `00 00 00 01`. A larger 32-bit size can be all printable bytes, so the 8 bytes after the
 * type count too, and for an `mdat` (whose payload is codec data that may start printable) so
 * do the next 48. XML cannot hold such a byte: XML 1.0 allows no C0 control but tab, LF and CR.
 */
const hasBinaryBoxHeader = (b: Buffer): boolean => hasBinaryByte(b, 0, ascii(b, 4, 8) === 'mdat' ? 64 : 16);

/** A legal atom size: 0 (the atom runs to the end of the file), 1 (a 64-bit size follows the type), else at least the 8-byte header. */
function isLegalAtomSize(b: Buffer): boolean {
  const size = b.readUInt32BE(0);
  if (size === 1) return b.length >= 16 && b.readBigUInt64BE(8) >= 16n;
  return size === 0 || size >= 8;
}

/**
 * Files with no leading `ftyp` that ffmpeg's mov demuxer still reads: older QuickTime opens with
 * one of the first set (the atoms its probe accepts), and fragmented-MP4 segments with the second.
 */
const QT_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot', 'udta', 'junk', 'pict', 'uuid', 'ediw', 'prfl']);
const FRAGMENT_BOXES = new Set(['styp', 'sidx', 'moof']);
const detectFtyplessMovie: Detector = (b) => {
  if (!isLegalAtomSize(b)) return null;
  const type = ascii(b, 4, 8);
  if (QT_ATOMS.has(type)) return video('video/quicktime', 'mov');
  return FRAGMENT_BOXES.has(type) ? video('video/mp4', 'mov') : null;
};

/** ISO-BMFF: AVIF / HEIC stills vs mp4 / mov movies, told apart by their brands. */
const detectIsoBmff: Detector = (b) => {
  if (b.length < 12 || !hasBinaryBoxHeader(b)) return null;
  const brands = ftypBrands(b);
  if (!brands) return detectFtyplessMovie(b);
  if (brands.some((x) => AVIF_BRANDS.has(x))) return { kind: 'image', mime: 'image/avif' };
  if (brands.some((x) => HEIF_BRANDS.has(x))) return { kind: 'image', mime: 'image/heic' };
  return video(brands[0]!.startsWith('qt') ? 'video/quicktime' : 'video/mp4', 'mov');
};

/** EBML (webm / mkv): the DocType string sits in the first few dozen bytes. */
const detectEbml: Detector = (b) => {
  if (!startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return null;
  const head = ascii(b, 0, Math.min(b.length, 64));
  return head.includes('matroska') ? video('video/x-matroska', 'matroska') : video('video/webm', 'matroska');
};

/**
 * Other movie containers with a fixed leading signature. Each holds a byte no text can (a C0
 * control or `00`), so no playlist or manifest can start with one.
 */
const VIDEO_PREFIX_SIGNATURES: ReadonlyArray<{ sig: readonly number[]; media: DetectedMedia }> = [
  { sig: [0x46, 0x4c, 0x56, 0x01], media: video('video/x-flv', 'flv') }, // "FLV" v1
  { sig: [0x4f, 0x67, 0x67, 0x53, 0x00], media: video('video/ogg', 'ogg') }, // "OggS", stream structure version 0
  { sig: [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11], media: video('video/x-ms-asf', 'asf') }, // ASF header GUID
  { sig: [0x00, 0x00, 0x01, 0xba], media: video('video/mpeg', 'mpeg') }, // MPEG-PS pack header
  { sig: [0x00, 0x00, 0x01, 0xb3], media: video('video/mpeg', 'mpegvideo') }, // MPEG-1/2 elementary stream (sequence header)
];

const detectVideoPrefix: Detector = (b) => VIDEO_PREFIX_SIGNATURES.find((e) => startsWith(b, e.sig))?.media ?? null;

/** MPEG-TS packet size, and where the first three packets end (a `readFileHead` sniff holds 512 bytes of them). */
const TS_PACKET = 188;
const TS_SNIFF_END = 3 * TS_PACKET;

/**
 * MPEG transport stream: a 0x47 sync byte every 188 bytes, each packet header unscrambled with a
 * valid adaptation-field value. Text can meet all of that ("G" at each offset, a printable 4th
 * byte), so the packets must also hold a binary byte: real ones do (the PAT's zero
 * pointer field and PID, a PES start code, null-packet padding). Needs the first two packets.
 */
const isTsPacket = (b: Buffer, o: number): boolean => b[o] === 0x47 && (b[o + 3]! & 0xc0) === 0 && (b[o + 3]! & 0x30) !== 0;
const detectMpegTs: Detector = (b) =>
  b.length > TS_PACKET + 3 &&
  isTsPacket(b, 0) &&
  isTsPacket(b, TS_PACKET) &&
  (b.length <= 2 * TS_PACKET + 3 || isTsPacket(b, 2 * TS_PACKET)) &&
  hasBinaryByte(b, 0, TS_SNIFF_END)
    ? video('video/mp2t', 'mpegts')
    : null;

/**
 * Tried in order; each family claims only bytes it positively identifies. ISO-BMFF goes before
 * ICO: a QuickTime file whose first atom is 256 bytes also starts `00 00 01 00`.
 */
const DETECTORS: readonly Detector[] = [detectPrefixSignature, detectRiff, detectBmp, detectIsoBmff, detectIco, detectEbml, detectVideoPrefix, detectMpegTs];

/** Identify bytes by signature: a recognised image or video, else null. */
export function detectMedia(b: Buffer): DetectedMedia | null {
  if (b.length < 4) return null;
  for (const detect of DETECTORS) {
    const found = detect(b);
    if (found) return found;
  }
  return null;
}

/** The image mime the bytes prove, or null for anything that is not a recognised image. */
export function detectImageMime(b: Buffer): string | null {
  const d = detectMedia(b);
  return d?.kind === 'image' ? d.mime : null;
}

/**
 * Image mime for bytes a provider returned without one: the detected type, else
 * `image/png` (the providers' de-facto default). Never use this to VALIDATE input:
 * it cannot say "not an image"; use `detectImageMime` for that.
 */
export function sniffImageMime(b: Buffer): string {
  return detectImageMime(b) ?? 'image/png';
}
