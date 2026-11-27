import { rawRequest } from '../util/http.js';
import { detectImageMime } from '../util/mime.js';

const BASE = 'https://api.tinify.com';
const TINIFY_ORIGIN = new URL(BASE).origin;

/** Image types `/shrink` ingests. Other rasters (gif/bmp/tiff) must be converted to PNG first. */
export const TINIFY_INPUT_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);

function authHeader(key: string): string {
  return 'Basic ' + Buffer.from(`api:${key}`).toString('base64');
}

function tinifyMessage(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string; message?: string };
    return [j.error, j.message].filter(Boolean).join(': ') || body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

export class TinifyError extends Error {
  constructor(
    message: string,
    /** The HTTP status Tinify answered with; `null` when the failure happened before any request was sent. */
    readonly status: number | null,
  ) {
    super(message);
    this.name = 'TinifyError';
  }
}

/**
 * Only bytes whose magic bytes prove an image Tinify ingests are uploaded, so a buffer that is
 * not an image (a mis-resolved input, a text or config file) never leaves the machine.
 */
function isAllowedUpload(bytes: Buffer): boolean {
  return TINIFY_INPUT_MIMES.has(detectImageMime(bytes) ?? '');
}

/**
 * The result URL comes from Tinify's `Location` header and is sent the API key, so it must stay
 * on api.tinify.com: a Location naming any other host would hand that host the key.
 */
function resultUrl(location: string): string {
  let url: URL;
  try {
    url = new URL(location, BASE);
  } catch {
    throw new TinifyError('Tinify returned an unparseable result Location.', 201);
  }
  if (url.origin !== TINIFY_ORIGIN) throw new TinifyError(`Tinify returned a result Location outside ${TINIFY_ORIGIN}; the API key is not sent there.`, 201);
  return url.href;
}

/** A Tinify answer is used (and so saved) only when its magic bytes are the image type we asked for. */
function expectImage(out: Buffer, mimeType: string, step: string): Buffer {
  const actual = detectImageMime(out);
  if (actual !== mimeType) throw new TinifyError(`Tinify ${step} returned ${actual ?? 'unrecognized bytes'} instead of ${mimeType}.`, 200);
  return out;
}

/** Upload bytes to /shrink; returns the result resource URL (Location header). */
async function shrink(key: string, bytes: Buffer, signal?: AbortSignal): Promise<string> {
  if (!isAllowedUpload(bytes)) {
    throw new TinifyError(`Not sent to Tinify: the input is ${detectImageMime(bytes) ?? 'not a recognized image'}, and Tinify takes PNG, JPEG, WebP or AVIF only.`, null);
  }
  const res = await rawRequest(`${BASE}/shrink`, {
    method: 'POST',
    headers: { Authorization: authHeader(key) },
    body: bytes,
    signal,
    timeoutMs: 120_000,
  });
  if (res.status !== 201) {
    throw new TinifyError(`Tinify shrink failed: ${tinifyMessage(await res.text().catch(() => ''))}`, res.status);
  }
  const location = res.headers.get('location');
  if (!location) throw new TinifyError('Tinify shrink did not return a result Location.', res.status);
  return resultUrl(location);
}

/**
 * Compress an image. Compress never converts, so `mimeType` (the type the caller will save the
 * result as) must already be the upload's own: JPEG bytes a caller believes are PNG are refused
 * before they are sent, instead of coming back as a JPEG that then gets a `.png` name.
 */
export async function tinifyCompress(key: string, bytes: Buffer, mimeType: string, signal?: AbortSignal): Promise<Buffer> {
  const actual = detectImageMime(bytes);
  if (actual !== mimeType) {
    throw new TinifyError(`Not sent to Tinify: compress keeps the input's format, and the input is ${actual ?? 'not a recognized image'}, not ${mimeType}.`, null);
  }
  const url = await shrink(key, bytes, signal);
  const res = await rawRequest(url, { method: 'GET', headers: { Authorization: authHeader(key) }, signal, timeoutMs: 120_000 });
  if (!res.ok) throw new TinifyError(`Tinify download failed: ${tinifyMessage(await res.text().catch(() => ''))}`, res.status);
  return expectImage(Buffer.from(await res.arrayBuffer()), mimeType, 'compress');
}

/** Compress + convert an image to another format (default image/webp); returns the converted bytes. */
export async function tinifyConvert(key: string, bytes: Buffer, type = 'image/webp', signal?: AbortSignal): Promise<Buffer> {
  const url = await shrink(key, bytes, signal);
  const res = await rawRequest(url, {
    method: 'POST',
    headers: { Authorization: authHeader(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({ convert: { type } }),
    signal,
    timeoutMs: 120_000,
  });
  if (!res.ok) throw new TinifyError(`Tinify convert failed: ${tinifyMessage(await res.text().catch(() => ''))}`, res.status);
  return expectImage(Buffer.from(await res.arrayBuffer()), type, 'convert');
}

/** Quick credential check: returns the monthly Compression-Count, or throws TinifyError. */
export async function tinifyValidate(key: string, signal?: AbortSignal): Promise<number | null> {
  // A POST to /shrink with no body returns 400 (bad request) for a valid key, 401 for an invalid one.
  const res = await rawRequest(`${BASE}/shrink`, { method: 'POST', headers: { Authorization: authHeader(key) }, body: '', signal, timeoutMs: 30_000, retries: 0 });
  if (res.status === 401) throw new TinifyError('Tinify credentials are invalid.', 401);
  const count = res.headers.get('compression-count');
  return count ? Number(count) : null;
}
