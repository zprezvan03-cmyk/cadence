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
 * Actual synchronization precision is verified by parsing the TTML payload itself so a mislabeled
 * record is never advertised as word-synced when it only contains line-level `<p>` timings.
 */

import { BINIMUM_BASE_URL, BINIMUM_REQUEST_TIMEOUT_MS } from "../../shared/upstream/better-lyrics/constants";
import type { LyricsCandidate, LyricsSyncType } from "../../shared/types";
import {
  describeHttpError,
  getJson,
  getText,
  isAbort,
  LyricsHttpError,
  retryAfter,
  type ProviderOutcome,
  type ProviderQuery,
  type ProviderStatus,
} from "./http";
import {
  durationWithinTolerance,
  matchScore,
  MATCH_SCORE_THRESHOLD,
} from "./matching";
import { inspectLyricsPayload } from "./syncInspection";

const PROVIDER = "binimum";
const RESOLVE_RECORD_LIMIT = 3;
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

function asRecords(json: unknown): BinimumRecord[] | null {
  if (typeof json !== "object" || json === null) return null;
  const results = (json as BinimumIndex).results;
  if (!Array.isArray(results)) return null;
  return results.filter(r => r && typeof r === "object") as BinimumRecord[];
}

function indexUrl(query: ProviderQuery): string {
  const title = query.title.trim();
  const artist = query.artist.trim();
  const album = query.album.trim();
  const duration = Math.round(query.duration);
  const params = new URLSearchParams({ track: title, artist });
  if (album) params.set("album", album);
  if (Number.isFinite(duration) && duration > 0) params.set("duration", String(duration));
  return `${BINIMUM_BASE_URL}/?${params.toString()}`;
}

function matchMetadata(record: BinimumRecord) {
  return {
    matchTitle: typeof record.track_name === "string" ? record.track_name : null,
    matchArtist: typeof record.artist_name === "string" ? record.artist_name : null,
    matchAlbum: typeof record.album_name === "string" ? record.album_name : null,
    matchDuration: typeof record.duration === "number" && Number.isFinite(record.duration) ? record.duration : null,
  };
}

function recordMatchesQuery(query: ProviderQuery, record: BinimumRecord): boolean {
  const meta = matchMetadata(record);
  if (!meta.matchTitle && !meta.matchArtist) return true;
  if (!durationWithinTolerance(query.duration, meta.matchDuration)) return false;
  return (
    matchScore(query, {
      title: meta.matchTitle ?? "",
      artist: meta.matchArtist ?? "",
      album: meta.matchAlbum,
      duration: meta.matchDuration,
    }) >= MATCH_SCORE_THRESHOLD
  );
}

async function toCandidate(
  record: BinimumRecord,
  enabledKeys: ReadonlySet<string>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<LyricsCandidate | null> {
  if (typeof record.lyricsUrl !== "string" || !record.lyricsUrl) return null;
  const file = await getText(record.lyricsUrl, timeoutMs, signal);
  if (file.status === 429) {
    throw new LyricsHttpError("Rate limited", "rate-limit", 429, retryAfter(file.headers));
  }
  if (file.status >= 500) {
    throw new LyricsHttpError(`Server error (${file.status})`, "server", file.status);
  }
  if (!file.ok || !file.text.trim()) return null;
  // Storage errors can surface as HTML; only accept actual TTML documents.
  if (!/<tt[\s>]/i.test(file.text)) return null;

  const meta = matchMetadata(record);
  const inspected = inspectLyricsPayload(file.text, {
    durationSeconds: meta.matchDuration ?? undefined,
    title: meta.matchTitle ?? undefined,
    artist: meta.matchArtist ?? undefined,
  });
  if (!inspected.usable || inspected.format !== "ttml") return null;

  const syncHint: LyricsSyncType = inspected.syncType === "richsync" ? "richsync" : "synced";
  const source = syncHint === "richsync" ? "binimum-richsynced" : "binimum-synced";
  if (!enabledKeys.has(source)) return null;

  return {
    source,
    provider: "BiniLyrics",
    text: file.text,
    syncHint,
    language: inspected.language,
    songwriters: inspected.songwriters,
    sourceHref: BINIMUM_BASE_URL,
    cached: false,
    ...meta,
  };
}

function rateLimitStatus(headers: Headers): ProviderStatus {
  const wait = retryAfter(headers);
  return {
    provider: PROVIDER,
    status: "error",
    detail: wait ? `Rate limited; retry after ${wait}s` : "Rate limited",
    ...(wait !== undefined ? { retryAfterSeconds: wait } : {}),
  };
}

/** Automatic resolution: checks top matching index records and verifies actual TTML sync precision. */
export async function fetchBinimum(
  query: ProviderQuery,
  enabledKeys: ReadonlySet<string>,
  signal?: AbortSignal,
  timeoutMs: number = BINIMUM_REQUEST_TIMEOUT_MS
): Promise<ProviderOutcome> {
  if (!query.title.trim() && !query.artist.trim()) {
    return {
      candidates: [],
      statuses: [{ provider: PROVIDER, status: "skipped", detail: "Song or artist required" }],
    };
  }
  try {
    const index = await getJson(indexUrl(query), timeoutMs, signal);
    if (index.status === 429) return { candidates: [], statuses: [rateLimitStatus(index.headers)] };
    if (!index.ok) {
      if (index.status === 404) {
        return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on BiniLyrics" }] };
      }
      const body =
        typeof index.json === "object" && index.json !== null
          ? (index.json as { error?: string }).error
          : undefined;
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "error", detail: body || `Request failed (${index.status})` }] };
    }

    const records = asRecords(index.json);
    if (records === null) {
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "error", detail: "Malformed response" }] };
    }
    const matching = records.filter(record => recordMatchesQuery(query, record)).slice(0, RESOLVE_RECORD_LIMIT);
    if (matching.length === 0) {
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on BiniLyrics" }] };
    }

    let transientError: unknown = null;
    for (const record of matching) {
      try {
        const candidate = await toCandidate(record, enabledKeys, timeoutMs, signal);
        if (candidate) {
          return {
            candidates: [candidate],
            statuses: [{ provider: PROVIDER, status: "hit", detail: "TTML via BiniLyrics" }],
          };
        }
      } catch (error) {
        if (isAbort(error)) throw error;
        if (!transientError) transientError = error;
      }
    }

    if (transientError) {
      return { candidates: [], statuses: [{ provider: PROVIDER, ...describeHttpError(transientError) }] };
    }
    return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No usable BiniLyrics result" }] };
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
  if (!query.title.trim() && !query.artist.trim()) {
    return {
      candidates: [],
      statuses: [{ provider: PROVIDER, status: "skipped", detail: "Song or artist required" }],
    };
  }
  try {
    const index = await getJson(indexUrl(query), timeoutMs, signal);
    if (index.status === 429) return { candidates: [], statuses: [rateLimitStatus(index.headers)] };
    if (!index.ok) {
      if (index.status === 404) {
        return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on BiniLyrics" }] };
      }
      const body =
        typeof index.json === "object" && index.json !== null
          ? (index.json as { error?: string }).error
          : undefined;
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "error", detail: body || `Request failed (${index.status})` }] };
    }

    const parsedRecords = asRecords(index.json);
    if (parsedRecords === null) {
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "error", detail: "Malformed response" }] };
    }
    const records = parsedRecords.slice(0, SEARCH_LIMIT);
    if (records.length === 0) {
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on BiniLyrics" }] };
    }

    const settled = await Promise.allSettled(
      records.map(record => toCandidate(record, enabledKeys, timeoutMs, signal))
    );
    let transientError: unknown = null;
    for (const outcome of settled) {
      if (outcome.status === "rejected") {
        if (isAbort(outcome.reason)) throw outcome.reason;
        if (!transientError) transientError = outcome.reason;
      }
    }

    const candidates = settled.flatMap(outcome =>
      outcome.status === "fulfilled" && outcome.value ? [outcome.value] : []
    );
    if (candidates.length === 0) {
      if (transientError) {
        return { candidates: [], statuses: [{ provider: PROVIDER, ...describeHttpError(transientError) }] };
      }
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No usable BiniLyrics result" }] };
    }
    return {
      candidates,
      statuses: [{ provider: PROVIDER, status: "hit", detail: `${candidates.length} result${candidates.length === 1 ? "" : "s"}` }],
    };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { candidates: [], statuses: [{ provider: PROVIDER, ...describeHttpError(error) }] };
  }
}
