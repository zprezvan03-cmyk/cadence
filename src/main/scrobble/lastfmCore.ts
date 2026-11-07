/**
 * last.fm scrobbling client core.
 *
 * Cadence intentionally ships no shared last.fm API key: the user supplies
 * their own key/secret in Settings, authorizes Cadence in the browser, and
 * the resulting long-lived session key is stored locally. Requests are
 * signed locally with MD5 (last.fm's required scheme) and sent through the
 * same runtime fetch transport as the lyrics providers, which on desktop is
 * the native Rust HTTP command (so POST works without WebView2 CORS limits).
 */

import type { LastFmSettings } from "../../shared/types";
import { runtimeFetch } from "../lyrics/http";

const API_URL = "https://ws.audioscrobbler.com/2.0/";

/* ------------------------------------------------------------------ MD5 */

const MD5_K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function leftRotate(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/** MD5 hex digest of the UTF-8 encoding of `input`. Verified against RFC 1321 vectors in tests. */
export function md5Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLengthLow = (bytes.length << 3) >>> 0;
  const bitLengthHigh = Math.floor(bytes.length / 0x20000000) >>> 0;

  const paddedLength = (((bytes.length + 8) >> 6) + 1) << 6;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLengthLow, true);
  view.setUint32(paddedLength - 4, bitLengthHigh, true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const words = new Array<number>(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = view.getUint32(offset + i * 4, true);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + MD5_K[i] + words[g]) >>> 0;
      const previousD = d;
      d = c;
      c = b;
      b = (b + leftRotate(sum, MD5_S[i])) >>> 0;
      a = previousD;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  let hex = "";
  for (const word of [a0, b0, c0, d0]) {
    for (let byte = 0; byte < 4; byte += 1) {
      hex += ((word >>> (byte * 8)) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

/* ----------------------------------------------------------- API signing */

/**
 * last.fm request signature: sort parameters by name (excluding `format`,
 * `callback`, and any existing `api_sig`), concatenate name+value pairs,
 * append the shared secret, MD5 the result.
 */
export function lastFmSignature(params: Record<string, string>, secret: string): string {
  const base = Object.entries(params)
    .filter(([key]) => key !== "format" && key !== "callback" && key !== "api_sig")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}${value}`)
    .join("");
  return md5Hex(base + secret);
}

export class LastFmError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "LastFmError";
  }
}

export interface LastFmCredentials {
  apiKey: string;
  apiSecret: string;
  sessionKey?: string;
}

export interface LastFmTrackInfo {
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  trackNo?: number | null;
}

type FetchLike = typeof fetch;

async function callLastFm(
  method: string,
  params: Record<string, string>,
  credentials: LastFmCredentials,
  options: { signed: boolean; session?: boolean; fetchFn?: FetchLike },
): Promise<Record<string, unknown>> {
  if (!credentials.apiKey) throw new LastFmError("Add your last.fm API key in Settings first.");
  const bodyParams: Record<string, string> = {
    method,
    api_key: credentials.apiKey,
    ...params,
  };
  if (options.session) {
    if (!credentials.sessionKey) {
      throw new LastFmError("Connect your last.fm account in Settings first.");
    }
    bodyParams.sk = credentials.sessionKey;
  }
  if (options.signed) {
    if (!credentials.apiSecret) throw new LastFmError("Add your last.fm shared secret in Settings first.");
    bodyParams.api_sig = lastFmSignature(bodyParams, credentials.apiSecret);
  }
  bodyParams.format = "json";

  const fetchFn = options.fetchFn ?? runtimeFetch;
  const response = await fetchFn(API_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(bodyParams).toString(),
  });
  let json: unknown;
  try {
    json = JSON.parse(await response.text());
  } catch {
    throw new LastFmError(`last.fm returned an unreadable response (HTTP ${response.status}).`);
  }
  const record = (json ?? {}) as Record<string, unknown>;
  if (typeof record.error === "number") {
    throw new LastFmError(
      typeof record.message === "string" ? record.message : "last.fm rejected the request.",
      record.error,
    );
  }
  if (!response.ok) {
    throw new LastFmError(`last.fm request failed (HTTP ${response.status}).`);
  }
  return record;
}

function trackParams(track: LastFmTrackInfo): Record<string, string> {
  const params: Record<string, string> = {
    artist: track.artist,
    track: track.title,
  };
  if (track.album) params.album = track.album;
  if (track.duration && track.duration > 0) params.duration = String(Math.round(track.duration));
  if (track.trackNo && track.trackNo > 0) params.trackNumber = String(track.trackNo);
  return params;
}

/* ------------------------------------------------------------------ auth */

export async function lastFmGetToken(
  credentials: LastFmCredentials,
  fetchFn?: FetchLike,
): Promise<string> {
  const json = await callLastFm("auth.getToken", {}, credentials, { signed: true, fetchFn });
  if (typeof json.token !== "string" || !json.token) {
    throw new LastFmError("last.fm did not return an authorization token.");
  }
  return json.token;
}

export function lastFmAuthUrl(apiKey: string, token: string): string {
  return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;
}

export async function lastFmGetSession(
  credentials: LastFmCredentials,
  token: string,
  fetchFn?: FetchLike,
): Promise<{ sessionKey: string; username: string }> {
  const json = await callLastFm("auth.getSession", { token }, credentials, {
    signed: true,
    fetchFn,
  });
  const session = (json.session ?? {}) as Record<string, unknown>;
  if (typeof session.key !== "string" || !session.key) {
    throw new LastFmError("last.fm did not return a session. Approve Cadence in your browser, then try again.");
  }
  return {
    sessionKey: session.key,
    username: typeof session.name === "string" ? session.name : "",
  };
}

/* ------------------------------------------------------------- scrobble */

export async function lastFmUpdateNowPlaying(
  credentials: LastFmCredentials,
  track: LastFmTrackInfo,
  fetchFn?: FetchLike,
): Promise<void> {
  await callLastFm("track.updateNowPlaying", trackParams(track), credentials, {
    signed: true,
    session: true,
    fetchFn,
  });
}

/** Returns true when last.fm accepted the scrobble. */
export async function lastFmScrobble(
  credentials: LastFmCredentials,
  track: LastFmTrackInfo,
  startedAtSeconds: number,
  fetchFn?: FetchLike,
): Promise<boolean> {
  const json = await callLastFm(
    "track.scrobble",
    { ...trackParams(track), timestamp: String(Math.floor(startedAtSeconds)) },
    credentials,
    { signed: true, session: true, fetchFn },
  );
  const scrobbles = (json.scrobbles ?? {}) as Record<string, unknown>;
  const attr = (scrobbles["@attr"] ?? {}) as Record<string, unknown>;
  return attr.accepted !== "0" && attr.accepted !== 0;
}

/**
 * last.fm's scrobble rule: tracks longer than 30 seconds scrobble once half
 * the track — or four minutes, whichever comes first — has actually played.
 * Returns null for tracks that can never scrobble.
 */
export function scrobbleThresholdSeconds(durationSeconds: number): number | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 30) return null;
  return Math.min(durationSeconds / 2, 240);
}

export function shouldScrobble(input: {
  durationSeconds: number;
  listenedSeconds: number;
  alreadyScrobbled: boolean;
}): boolean {
  if (input.alreadyScrobbled) return false;
  const threshold = scrobbleThresholdSeconds(input.durationSeconds);
  return threshold !== null && input.listenedSeconds >= threshold;
}

export function isLastFmConnected(settings: LastFmSettings): boolean {
  return Boolean(settings.apiKey && settings.apiSecret && settings.sessionKey);
}
