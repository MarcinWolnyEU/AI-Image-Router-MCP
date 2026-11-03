import { timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Shared-secret auth for the Streamable HTTP transport (`config.http.authToken`).
 * Accepts `Authorization: Bearer <token>` (Le Chat "HTTP Bearer", Vibe `headers`/`api_key_env`)
 * or `X-API-Key: <token>` (Le Chat "API token" with a custom header), compared in constant
 * time without leaking the token's length (`tokenMatches`). `expected` null → auth disabled.
 * An EMPTY `expected` is a misconfiguration (a token was configured but resolved to
 * nothing) and fails CLOSED: it must never be read as "auth off".
 */
export function isHttpRequestAuthorized(headers: IncomingHttpHeaders, expected: string | null): boolean {
  if (expected === null) return true;
  if (expected.length === 0) return false;
  const candidates: string[] = [];
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) candidates.push(m[1]!.trim());
  }
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string') candidates.push(apiKey.trim());
  return candidates.some((c) => tokenMatches(c, expected));
}

/**
 * Constant-time equality that also hides the secret's length. `timingSafeEqual` needs equal
 * lengths, so the candidate is truncated or zero-padded to exactly the secret's byte length:
 * `Buffer.concat(list, n)` always writes `n` bytes (the copy is clamped, the rest zero-filled),
 * whatever the candidate's length. The length check runs last, so a prefix of the secret, or
 * the secret plus trailing bytes, still fails.
 * No hash: a digest only equalised the lengths, and a fast hash over a credential is what
 * CodeQL's js/insufficient-password-hash flags. A slow KDF is no fix either: it would hand
 * every unauthenticated request a CPU lever.
 */
function tokenMatches(candidate: string, expected: string): boolean {
  const want = Buffer.from(expected, 'utf8');
  const got = Buffer.from(candidate, 'utf8');
  return timingSafeEqual(Buffer.concat([got], want.length), want) && got.length === want.length;
}

/** The hostname of a `Host` header value (`example.com:8765`, `[::1]:8765`), lowercased. */
function hostnameOfHost(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '');
}

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const isLoopbackOrIp = (hostname: string): boolean => hostname === 'localhost' || IPV4_RE.test(hostname) || /^\[[0-9a-f:.]+\]$/.test(hostname);

/**
 * DNS-rebinding / cross-site guard for the HTTP transport while NO auth token is set (MCP spec:
 * local servers must validate Origin). A rebinding page reaches 127.0.0.1 through ITS OWN domain
 * name, so the browser stamps that name into `Host` and `Origin`; we accept only loopback names,
 * IP literals and the configured `allowedHosts`. An `Origin` (browsers always send one on a
 * cross-origin POST) must pass the same test, and the opaque `null` origin never does. Returns
 * null when the request may proceed, else the reason it was refused. With auth enabled the
 * token is the protection and this check is skipped (a tunnel's public hostname must work).
 */
export function checkRequestOrigin(headers: IncomingHttpHeaders, opts: { authEnabled: boolean; allowedHosts: string[] }): string | null {
  if (opts.authEnabled) return null;
  const allowed = new Set(opts.allowedHosts.map((h) => h.trim().toLowerCase()));
  const ok = (hostname: string): boolean => isLoopbackOrIp(hostname) || allowed.has(hostname);
  const host = headers['host'];
  if (typeof host === 'string' && host.trim() && !ok(hostnameOfHost(host))) {
    return `Host "${host}" is not allowed`;
  }
  const origin = headers['origin'];
  if (typeof origin === 'string') {
    let hostname: string;
    try {
      hostname = new URL(origin).hostname.toLowerCase();
    } catch {
      return `Origin "${origin}" is not allowed`;
    }
    if (!hostname || !ok(hostname)) return `Origin "${origin}" is not allowed`;
  }
  return null;
}
