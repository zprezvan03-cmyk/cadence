/**
 * Native BiniLyrics provider for Cadence — the keyless community TTML catalogue the Better Lyrics
 * extension consumes as its `binimum-richsynced` / `binimum-synced` sources (see the extension's
 * `unified.ts` Binimum branch and its current `PROVIDER_CONFIGS`).
 *
 * The request flow is adapted from the MIT-licensed `createBinimumProvider` in
 * `@braccato/provider-blyrics` (the Better Lyrics author's official reusable fetch package),
 * reworked to Cadence's raw-text candidate architecture:
 *   1. GET the index with track/artist (+ optional album/duration): metadata lookup, no API key.
 *   2. Each returned record exposes a `lyricsUrl` pointing at the TTML file; fetch its text.
 * The documented response schema (https://lyrics.binimum.org/developers):
 *   { total, source, results: [{ id, track_name, artist_name, album_name, duration, isrc,
 *     timing_type: "word" | "line", lyricsUrl }] }
 * `timing_type` distinguishes word-level from line-level timing; the payload itself is re-checked
 * so a mislabeled record can never be advertised as richer than it is.
 */

import { BINIMUM_BASE_URL, BINIMUM_REQUEST_TIMEOUT_MS } from "../../shared/upstream/better-lyrics/constants";
import type { LyricsCandidate, LyricsSyncType } from "../../shared/types";
import { ttmlSyncHint } from "./betterLyrics";
import {
  describeHttpError,
  getJson,
  getText,
  isAbort,
  retryAfter,
  type ProviderOutcome,
  type ProviderQuery,
  type ProviderStatus,
} from "./http";

const PROVIDER = "binimum";
const SEARCH_LIMIT = 6;

interface BinimumRecord {
  id?: string;
  track_name?: unknown;
  artist_name?: unknown;
  album_name?: unknown;
  duration?: unknown;
  isrc?: unknown;
  timing_type?: unknown;
  lyricsUrl?: unknown;
}

interface BinimumIndex {
  total?: number;
  results?: unknown;
}

function asRecords(json: unknown): BinimumRecord[] {
  if (typeof json !== "object" || json === null) return [];
  const results = (json as BinimumIndex).results;
  return Array.isArray(results) ? (results.filter(r => r && typeof r === "object") as BinimumRecord[]) : [];
}

function indexUrl(query: ProviderQuery): string {
  const params = new URLSearchParams({ track: query.title, artist: query.artist });
  if (query.album) params.set("album", query.album);
  if (query.duration > 0) params.set("duration", String(Math.round(query.duration)));
  return `${BINIMUM_BASE_URL}/?${params.toString()}`;
}

function classify(record: BinimumRecord, ttml: string): { source: string; syncHint: LyricsSyncType } {
  // timing_type is authoritative per the API docs; the payload span check is the fallback.
  const payloadHint = ttmlSyncHint(ttml);
  if (record.timing_type === "word" || (record.timing_type !== "line" && payloadHint === "richsync")) {
    return { source: "binimum-richsynced", syncHint: "richsync" };
  }
  return { source: "binimum-synced", syncHint: "synced" };
}

function matchMetadata(record: BinimumRecord) {
  return {
    matchTitle: typeof record.track_name === "string" ? record.track_name : null,
    matchArtist: typeof record.artist_name === "string" ? record.artist_name : null,
    matchAlbum: typeof record.album_name === "string" ? record.album_name : null,
    matchDuration: typeof record.duration === "number" && Number.isFinite(record.duration) ? record.duration : null,
  };
}

async function toCandidate(
  record: BinimumRecord,
  enabledKeys: ReadonlySet<string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<LyricsCandidate | null> {
  if (typeof record.lyricsUrl !== "string" || !record.lyricsUrl) return null;
  const file = await getText(record.lyricsUrl, timeoutMs, signal);
  if (!file.ok || !file.text.trim()) return null;
  // Storage errors can surface as HTML; only accept actual TTML documents.
  if (!/<tt[\s>]/i.test(file.text)) return null;
  const { source, syncHint } = classify(record, file.text);
  if (!enabledKeys.has(source)) return null;
  return {
    source,
    provider: "BiniLyrics",
    text: file.text,
    syncHint,
    language: null,
    songwriters: [],
    sourceHref: BINIMUM_BASE_URL,
    cached: false,
    ...matchMetadata(record),
  };
}

function rateLimitStatus(headers: Headers): ProviderStatus {
  const wait = retryAfter(headers);
  return {
    provider: PROVIDER,
    status: "error",
    detail: wait ? `Rate limited; retry after ${wait}s` : "Rate limited",
  };
}

/** Automatic resolution: the index's best match (its first record), mirroring the upstream client. */
export async function fetchBinimum(
  query: ProviderQuery,
  enabledKeys: ReadonlySet<string>,
  signal?: AbortSignal,
  timeoutMs: number = BINIMUM_REQUEST_TIMEOUT_MS
): Promise<ProviderOutcome> {
  try {
    const index = await getJson(indexUrl(query), timeoutMs, signal);
    if (index.status === 429) return { candidates: [], statuses: [rateLimitStatus(index.headers)] };
    if (!index.ok) {
      if (index.status === 404) return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on BiniLyrics" }] };
      const body = typeof index.json === "object" && index.json !== null ? (index.json as { error?: string }).error : undefined;
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "error", detail: body || `Request failed (${index.status})` }] };
    }

    const records = asRecords(index.json);
    if (records.length === 0) {
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on BiniLyrics" }] };
    }

    const candidate = await toCandidate(records[0], enabledKeys, timeoutMs, signal);
    if (!candidate) {
      // A catalogue row without a usable/allowed file is a miss for this provider order, not an
      // error: the index itself answered successfully.
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No usable BiniLyrics result" }] };
    }
    return { candidates: [candidate], statuses: [{ provider: PROVIDER, status: "hit", detail: "TTML via BiniLyrics" }] };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { candidates: [], statuses: [{ provider: PROVIDER, ...describeHttpError(error) }] };
  }
}

/**
 * Manual search: every returned version (capped) is fetched so the selector can show alternatives
 * and the rows can be cached for offline re-selection. Individual file failures never sink the
 * whole search.
 */
export async function searchBinimum(
  query: ProviderQuery,
  enabledKeys: ReadonlySet<string>,
  signal?: AbortSignal,
  timeoutMs: number = BINIMUM_REQUEST_TIMEOUT_MS
): Promise<ProviderOutcome> {
  try {
    const index = await getJson(indexUrl(query), timeoutMs, signal);
    if (index.status === 429) return { candidates: [], statuses: [rateLimitStatus(index.headers)] };
    if (!index.ok) {
      if (index.status === 404) return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on BiniLyrics" }] };
      const body = typeof index.json === "object" && index.json !== null ? (index.json as { error?: string }).error : undefined;
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "error", detail: body || `Request failed (${index.status})` }] };
    }

    const records = asRecords(index.json).slice(0, SEARCH_LIMIT);
    if (records.length === 0) {
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on BiniLyrics" }] };
    }

    const settled = await Promise.allSettled(
      records.map(record => toCandidate(record, enabledKeys, timeoutMs, signal))
    );
    const candidates = settled.flatMap(outcome =>
      outcome.status === "fulfilled" && outcome.value ? [outcome.value] : []
    );
    if (candidates.length === 0) {
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No usable BiniLyrics result" }] };
    }
    return { candidates, statuses: [{ provider: PROVIDER, status: "hit", detail: `${candidates.length} result${candidates.length === 1 ? "" : "s"}` }] };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { candidates: [], statuses: [{ provider: PROVIDER, ...describeHttpError(error) }] };
  }
}
