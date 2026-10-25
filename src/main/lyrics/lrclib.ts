/**
 * LRCLIB provider for Cadence.
 *
 * LRCLIB is one of the providers Better Lyrics uses upstream (as `lrclib-synced` / `lrclib-plain`
 * in src/core/constants.ts). Verified against https://lrclib.net/docs:
 * - `GET /api/get` requires both `track_name` and `artist_name`, plus optional `album_name` and
 *   optional `duration` (1..3600 seconds, ±2s server tolerance).
 * - `GET /api/search` accepts `track_name` (or `q`), optional `artist_name`, optional `album_name`.
 * - Identifies itself via `User-Agent` and `Lrclib-Client` headers, honors `429` (`Retry-After`),
 *   and distinguishes `404` misses from `429`/`5xx`/malformed/timeout/network errors.
 */

import { LRCLIB_BASE_URL } from "../../shared/upstream/better-lyrics/constants";
import type { LyricsCandidate } from "../../shared/types";
import {
  CLIENT_NAME,
  describeHttpError,
  getJson,
  isAbort,
  retryAfter,
  type ProviderOutcome,
  type ProviderStatus,
} from "./http";
import { matchScore, MATCH_SCORE_THRESHOLD } from "./matching";
import { inspectLyricsPayload } from "./syncInspection";

export const LRCLIB_REQUEST_TIMEOUT_MS = 8_000;
const MIN_LRCLIB_DURATION_SECONDS = 1;
const MAX_LRCLIB_DURATION_SECONDS = 3_600;
const PROVIDER = "lrclib";
const DEFAULT_LRCLIB_KEYS: ReadonlySet<string> = new Set(["lrclib-synced", "lrclib-plain"]);

export interface LrclibQuery {
  title: string;
  artist: string;
  album: string;
  duration: number;
}

interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number;
  instrumental?: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export type LrclibResult = ProviderOutcome;

const LRCLIB_HEADERS: Record<string, string> = {
  "Lrclib-Client": CLIENT_NAME,
};

function isRecordObject(value: unknown): value is LrclibRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordToCandidates(
  record: LrclibRecord,
  enabledKeys: ReadonlySet<string>,
  attachMatchMetadata: boolean
): LyricsCandidate[] {
  const candidates: LyricsCandidate[] = [];
  const href = typeof record.id === "number" ? `https://lrclib.net/lyrics/${record.id}` : "https://lrclib.net";
  const matchMeta = attachMatchMetadata
    ? {
        matchTitle: typeof record.trackName === "string" ? record.trackName : null,
        matchArtist: typeof record.artistName === "string" ? record.artistName : null,
        matchAlbum: typeof record.albumName === "string" ? record.albumName : null,
        matchDuration:
          typeof record.duration === "number" && Number.isFinite(record.duration)
            ? record.duration
            : null,
      }
    : undefined;

  let demotedPlainFromSynced: string | null = null;
  if (typeof record.syncedLyrics === "string" && record.syncedLyrics.trim()) {
    const inspected = inspectLyricsPayload(record.syncedLyrics, {
      durationSeconds: typeof record.duration === "number" ? record.duration : undefined,
      title: typeof record.trackName === "string" ? record.trackName : undefined,
      artist: typeof record.artistName === "string" ? record.artistName : undefined,
    });
    if (inspected.usable) {
      if (inspected.syncType !== "none") {
        if (enabledKeys.has("lrclib-synced")) {
          candidates.push({
            source: "lrclib-synced",
            provider: "LRCLIB (synced)",
            text: record.syncedLyrics,
            syncHint: inspected.syncType,
            language: inspected.language,
            songwriters: inspected.songwriters,
            sourceHref: href,
            cached: false,
            ...matchMeta,
          });
        }
      } else {
        // Never advertise untimed text as synchronized lyrics.
        demotedPlainFromSynced = record.syncedLyrics;
      }
    }
  }

  const plainSource =
    typeof record.plainLyrics === "string" && record.plainLyrics.trim()
      ? record.plainLyrics
      : demotedPlainFromSynced;
  if (plainSource && enabledKeys.has("lrclib-plain")) {
    const inspected = inspectLyricsPayload(plainSource);
    if (inspected.usable) {
      candidates.push({
        source: "lrclib-plain",
        provider: "LRCLIB",
        text: plainSource,
        syncHint: "none",
        language: null,
        songwriters: [],
        sourceHref: href,
        cached: false,
        ...matchMeta,
      });
    }
  }

  return candidates;
}

function pickBest(
  records: unknown[],
  query: LrclibQuery,
  enabledKeys: ReadonlySet<string>
): LyricsCandidate[] {
  const scored: { candidates: LyricsCandidate[]; score: number; hasSynced: boolean }[] = [];
  for (const item of records) {
    if (!isRecordObject(item)) continue;
    const candidates = recordToCandidates(item, enabledKeys, false);
    if (candidates.length === 0) continue;
    const score = matchScore(query, {
      title: typeof item.trackName === "string" ? item.trackName : "",
      artist: typeof item.artistName === "string" ? item.artistName : "",
      album: typeof item.albumName === "string" ? item.albumName : null,
      duration: typeof item.duration === "number" ? item.duration : null,
    });
    if (score >= MATCH_SCORE_THRESHOLD) {
      scored.push({
        candidates,
        score,
        hasSynced: candidates.some(c => c.source === "lrclib-synced"),
      });
    }
  }
  if (scored.length === 0) return [];
  scored.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.03) return b.score - a.score;
    if (a.hasSynced !== b.hasSynced) return a.hasSynced ? -1 : 1;
    return b.score - a.score;
  });
  return scored[0].candidates;
}

function rateLimitOutcome(headers: Headers): LrclibResult {
  const wait = retryAfter(headers);
  const status: ProviderStatus = {
    provider: PROVIDER,
    status: "error",
    detail: wait ? `Rate limited; retry after ${wait}s` : "Rate limited",
    ...(wait !== undefined ? { retryAfterSeconds: wait } : {}),
  };
  return { candidates: [], statuses: [status] };
}

function errorDetailFromBody(json: unknown, httpStatus: number): string {
  if (typeof json === "object" && json !== null) {
    const message = (json as { message?: unknown; error?: unknown }).message ?? (json as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return httpStatus >= 500 ? `Server error (${httpStatus})` : `Request failed (${httpStatus})`;
}

export async function fetchLrclib(
  query: LrclibQuery,
  signal?: AbortSignal,
  enabledKeys: ReadonlySet<string> = DEFAULT_LRCLIB_KEYS,
  timeoutMs: number = LRCLIB_REQUEST_TIMEOUT_MS
): Promise<LrclibResult> {
  if (!enabledKeys.has("lrclib-synced") && !enabledKeys.has("lrclib-plain")) {
    return {
      candidates: [],
      statuses: [{ provider: PROVIDER, status: "skipped", detail: "Provider disabled" }],
    };
  }

  const title = query.title.trim();
  const artist = query.artist.trim();
  const album = query.album.trim();
  const duration = Math.round(query.duration);

  if (!title && !artist) {
    return {
      candidates: [],
      statuses: [{ provider: PROVIDER, status: "skipped", detail: "Song or artist required" }],
    };
  }

  let lastError: ProviderStatus | null = null;
  let sawInstrumental = false;

  // `/api/get` requires both `track_name` and `artist_name` per https://lrclib.net/docs.
  if (title && artist) {
    const params = new URLSearchParams({
      track_name: title,
      artist_name: artist,
    });
    if (album) params.set("album_name", album);
    if (
      Number.isFinite(duration) &&
      duration >= MIN_LRCLIB_DURATION_SECONDS &&
      duration <= MAX_LRCLIB_DURATION_SECONDS
    ) {
      params.set("duration", String(duration));
    }

    try {
      const exact = await getJson(
        `${LRCLIB_BASE_URL}/get?${params.toString()}`,
        timeoutMs,
        signal,
        LRCLIB_HEADERS
      );
      if (exact.status === 429) {
        return rateLimitOutcome(exact.headers);
      }
      if (exact.ok) {
        if (!isRecordObject(exact.json)) {
          lastError = { provider: PROVIDER, status: "error", detail: "Malformed response" };
        } else {
          if (exact.json.instrumental === true) sawInstrumental = true;
          const candidates = recordToCandidates(exact.json, enabledKeys, false);
          if (candidates.length > 0) {
            const hasSynced = candidates.some(c => c.source === "lrclib-synced");
            return {
              candidates,
              statuses: [
                {
                  provider: PROVIDER,
                  status: "hit",
                  detail: hasSynced ? "Synced lyrics found" : "Plain lyrics found",
                },
              ],
            };
          }
        }
      } else if (exact.status !== 404 && exact.status !== 400) {
        lastError = {
          provider: PROVIDER,
          status: "error",
          detail: errorDetailFromBody(exact.json, exact.status),
        };
      }
    } catch (error) {
      if (isAbort(error)) throw error;
      lastError = { provider: PROVIDER, ...describeHttpError(error) };
    }
  }

  const searchParams = new URLSearchParams();
  if (title) {
    searchParams.set("track_name", title);
    if (artist) searchParams.set("artist_name", artist);
    if (album) searchParams.set("album_name", album);
  } else {
    searchParams.set("q", artist);
  }

  try {
    const search = await getJson(
      `${LRCLIB_BASE_URL}/search?${searchParams.toString()}`,
      timeoutMs,
      signal,
      LRCLIB_HEADERS
    );
    if (search.status === 429) {
      return rateLimitOutcome(search.headers);
    }
    if (search.status === 404) {
      return {
        candidates: [],
        statuses: [
          lastError ?? {
            provider: PROVIDER,
            status: "miss",
            detail: sawInstrumental ? "Instrumental track on LRCLIB" : "No matching lyrics on LRCLIB",
          },
        ],
      };
    }
    if (!search.ok) {
      return {
        candidates: [],
        statuses: [
          {
            provider: PROVIDER,
            status: "error",
            detail: errorDetailFromBody(search.json, search.status),
          },
        ],
      };
    }
    if (!Array.isArray(search.json)) {
      return {
        candidates: [],
        statuses: [{ provider: PROVIDER, status: "error", detail: "Malformed response" }],
      };
    }

    const candidates = pickBest(search.json, query, enabledKeys);
    if (candidates.length === 0) {
      return {
        candidates: [],
        statuses: [
          lastError ?? {
            provider: PROVIDER,
            status: "miss",
            detail: sawInstrumental ? "Instrumental track on LRCLIB" : "No matching lyrics on LRCLIB",
          },
        ],
      };
    }

    const hasSynced = candidates.some(c => c.source === "lrclib-synced");
    return {
      candidates,
      statuses: [
        {
          provider: PROVIDER,
          status: "hit",
          detail: hasSynced ? "Synced lyrics found" : "Plain lyrics found",
        },
      ],
    };
  } catch (error) {
    if (isAbort(error)) throw error;
    return {
      candidates: [],
      statuses: [{ provider: PROVIDER, ...describeHttpError(error) }],
    };
  }
}

const SEARCH_RESULT_LIMIT = 8;

/**
 * Manual-search variant: returns every usable LRCLIB record (synced preferred per record) instead
 * of only the closest one, so the lyrics selector can offer alternatives. Each candidate carries
 * the catalogue record's own metadata for display.
 */
export async function searchLrclib(
  query: LrclibQuery,
  enabledKeys: ReadonlySet<string>,
  signal?: AbortSignal,
  timeoutMs: number = LRCLIB_REQUEST_TIMEOUT_MS
): Promise<LrclibResult> {
  if (!enabledKeys.has("lrclib-synced") && !enabledKeys.has("lrclib-plain")) {
    return {
      candidates: [],
      statuses: [{ provider: PROVIDER, status: "skipped", detail: "Provider disabled" }],
    };
  }

  const title = query.title.trim();
  const artist = query.artist.trim();
  const album = query.album.trim();
  if (!title && !artist) {
    return {
      candidates: [],
      statuses: [{ provider: PROVIDER, status: "skipped", detail: "Song or artist required" }],
    };
  }

  const params = new URLSearchParams();
  if (title) {
    params.set("track_name", title);
    if (artist) params.set("artist_name", artist);
    if (album) params.set("album_name", album);
  } else {
    params.set("q", artist);
  }

  try {
    const response = await getJson(
      `${LRCLIB_BASE_URL}/search?${params.toString()}`,
      timeoutMs,
      signal,
      LRCLIB_HEADERS
    );
    if (response.status === 429) {
      return rateLimitOutcome(response.headers);
    }
    if (response.status === 404) {
      return {
        candidates: [],
        statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on LRCLIB" }],
      };
    }
    if (!response.ok) {
      return {
        candidates: [],
        statuses: [
          {
            provider: PROVIDER,
            status: "error",
            detail: errorDetailFromBody(response.json, response.status),
          },
        ],
      };
    }
    if (!Array.isArray(response.json)) {
      return {
        candidates: [],
        statuses: [{ provider: PROVIDER, status: "error", detail: "Malformed response" }],
      };
    }

    const candidates: LyricsCandidate[] = [];
    for (const item of response.json) {
      if (!isRecordObject(item)) continue;
      for (const candidate of recordToCandidates(item, enabledKeys, true)) {
        candidates.push(candidate);
        if (candidates.length >= SEARCH_RESULT_LIMIT) break;
      }
      if (candidates.length >= SEARCH_RESULT_LIMIT) break;
    }

    return candidates.length > 0
      ? {
          candidates,
          statuses: [
            {
              provider: PROVIDER,
              status: "hit",
              detail: `${candidates.length} result${candidates.length === 1 ? "" : "s"}`,
            },
          ],
        }
      : {
          candidates: [],
          statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on LRCLIB" }],
        };
  } catch (error) {
    if (isAbort(error)) throw error;
    return {
      candidates: [],
      statuses: [{ provider: PROVIDER, ...describeHttpError(error) }],
    };
  }
}
