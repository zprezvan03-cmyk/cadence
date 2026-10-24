/**
 * Unison provider for Cadence — the crowdsourced lyrics API the Better Lyrics extension reads
 * from (extension module `src/modules/lyrics/providers/unison.ts`, backend `better-lyrics/unison`).
 *
 * Why this is usable by a standalone player, verified against the backend and
 * https://docs.betterlyrics.org/unison:
 * - Read endpoints need no API key, no ECDSA identity and no video ID. Signing is only required
 *   for writes (submit/vote/report), which Cadence never performs.
 * - `GET /lyrics?song&artist&album&duration` is a metadata lookup built for exactly the local-file
 *   case; the server normalizes the metadata, matches duration within ±2 s and prefers album.
 * - The response envelope is `{ success, data }`, with `data.format` of `ttml | lrc | plain` and
 *   `data.syncType` of `richsync | linesync | plain`. The raw text is passed through untouched so
 *   the renderer's @braccato/parsers keeps every timestamp, syllable part and instrumental mark.
 *
 * This client is Cadence's own implementation written against the documented public API (the
 * Unison backend is AGPL-3.0; no server code is copied). The extension's source-key taxonomy
 * (`unison-richsynced` / `unison-wordsynced` / `unison-synced` / `unison-plain`) is preserved.
 */

import {
  UNISON_BASE_URL,
  UNISON_REQUEST_TIMEOUT_MS,
} from "../../shared/upstream/better-lyrics/constants";
import type { LyricsCandidate, LyricsSyncType } from "../../shared/types";
import {
  durationWithinTolerance,
  matchScore,
  MATCH_SCORE_THRESHOLD,
} from "./matching";
import {
  describeHttpError,
  getJson,
  isAbort,
  retryAfter,
  type ProviderOutcome,
  type ProviderQuery,
  type ProviderStatus,
} from "./http";

const PROVIDER = "unison";
const SEARCH_LIMIT = 5;

type UnisonFormat = "ttml" | "lrc" | "plain";
type UnisonSyncType = "richsync" | "linesync" | "plain";

interface UnisonEntry {
  id: number;
  videoId?: string | null;
  song?: string | null;
  artist?: string | null;
  album?: string | null;
  duration?: number | null;
  lyrics?: unknown;
  format?: unknown;
  language?: string | null;
  syncType?: unknown;
  confidence?: string | null;
}

interface Envelope {
  success?: boolean;
  data?: unknown;
  error?: string;
  code?: string;
  hint?: string;
}

type CandidateResult =
  | { ok: true; candidate: LyricsCandidate }
  | { ok: false; reason: "invalid" | "disabled" };

/** Maps a Unison entry to the same source-key split the extension produces. */
export function toUnisonCandidate(entry: UnisonEntry, enabledKeys: ReadonlySet<string>): CandidateResult {
  return toCandidate(entry, enabledKeys);
}

function toCandidate(entry: UnisonEntry, enabledKeys: ReadonlySet<string>): CandidateResult {
  const format = entry.format as UnisonFormat | undefined;
  const syncType = entry.syncType as UnisonSyncType | undefined;
  const text = typeof entry.lyrics === "string" ? entry.lyrics : "";
  if (!text || !format || !["ttml", "lrc", "plain"].includes(format)) return { ok: false, reason: "invalid" };

  let source: string;
  let syncHint: LyricsSyncType;
  if (format === "ttml") {
    if (syncType === "linesync") {
      source = "unison-synced";
      syncHint = "synced";
    } else {
      // richsync (or an unspecified TTML, which is syllable-timed in this catalog)
      source = "unison-richsynced";
      syncHint = "richsync";
    }
  } else if (format === "lrc") {
    if (syncType === "richsync") {
      source = "unison-wordsynced";
      syncHint = "richsync";
    } else {
      source = "unison-synced";
      syncHint = "synced";
    }
  } else {
    source = "unison-plain";
    syncHint = "none";
  }
  if (!enabledKeys.has(source)) return { ok: false, reason: "disabled" };

  return {
    ok: true,
    candidate: {
    source,
    provider: "Unison",
    text,
    syncHint,
      language: entry.language ?? null,
      songwriters: [],
      sourceHref: "https://unison.boidu.dev/",
      cached: false,
    },
  };
}

function buildUrl(path: "/lyrics" | "/lyrics/search", query: ProviderQuery, includeLimit: boolean): string {
  const params = new URLSearchParams({ song: query.title, artist: query.artist });
  if (query.album) params.set("album", query.album);
  if (query.duration > 0) params.set("duration", String(Math.round(query.duration)));
  if (includeLimit) params.set("limit", String(SEARCH_LIMIT));
  return `${UNISON_BASE_URL}${path}?${params.toString()}`;
}

function asEnvelope(json: unknown): Envelope | null {
  if (typeof json !== "object" || json === null) return null;
  return json as Envelope;
}

function asEntry(value: unknown): UnisonEntry | null {
  if (typeof value !== "object" || value === null) return null;
  return value as UnisonEntry;
}

/**
 * Fetches Unison lyrics using metadata only — a video ID is never fabricated.
 *
 * Flow: exact `/lyrics` match first (the server's highest-scored entry); on a clean 404, fall back
 * to `/lyrics/search` and re-rank the full records locally with the same conservative
 * title/artist/duration scoring used for LRCLIB, so a fuzzy hit can never be the wrong song.
 */
export async function fetchUnison(
  query: ProviderQuery,
  enabledKeys: ReadonlySet<string>,
  signal?: AbortSignal,
  timeoutMs: number = UNISON_REQUEST_TIMEOUT_MS
): Promise<ProviderOutcome> {
  const statuses: ProviderStatus[] = [];
  try {
    const primary = await getJson(buildUrl("/lyrics", query, false), timeoutMs, signal);

    if (primary.status === 429) {
      return {
        candidates: [],
        statuses: [
          {
            provider: PROVIDER,
            status: "error",
            detail: retryAfter(primary.headers)
              ? `Rate limited; retry after ${retryAfter(primary.headers)}s`
              : "Rate limited",
          },
        ],
      };
    }

    if (primary.ok) {
      const envelope = asEnvelope(primary.json);
      const entry = asEntry(envelope?.data);
      if (envelope?.success && entry) {
        const mapped = toCandidate(entry, enabledKeys);
        if (mapped.ok) {
          return {
            candidates: [mapped.candidate],
            statuses: [
              {
                provider: PROVIDER,
                status: "hit",
                detail: `${String(entry.format ?? "").toUpperCase()} ${String(entry.syncType ?? "")}`.trim(),
              },
            ],
          };
        }
        if (mapped.reason === "disabled") {
          return {
            candidates: [],
            statuses: [{ provider: PROVIDER, status: "miss", detail: "Provider disabled" }],
          };
        }
      }
      // 200 with an unusable body is a malformed payload, not a miss.
      return {
        candidates: [],
        statuses: [{ provider: PROVIDER, status: "error", detail: "Malformed response" }],
      };
    }

    if (primary.status !== 404) {
      // 400 = bad query, 5xx = server trouble; envelope may explain why.
      const envelope = asEnvelope(primary.json);
      const detail = envelope?.error || `Request failed (${primary.status})`;
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "error", detail }] };
    }

    // Clean miss on the exact endpoint: try the ranked search endpoint before giving up.
    const search = await getJson(buildUrl("/lyrics/search", query, true), timeoutMs, signal);
    if (search.status === 429) {
      return {
        candidates: [],
        statuses: [
          {
            provider: PROVIDER,
            status: "error",
            detail: retryAfter(search.headers)
              ? `Rate limited; retry after ${retryAfter(search.headers)}s`
              : "Rate limited",
          },
        ],
      };
    }
    if (!search.ok) {
      const envelope = asEnvelope(search.json);
      return {
        candidates: [],
        statuses: [
          {
            provider: PROVIDER,
            status: search.status === 404 ? "miss" : "error",
            detail:
              search.status === 404
                ? "No matching lyrics on Unison"
                : envelope?.error || `Request failed (${search.status})`,
          },
        ],
      };
    }

    const envelope = asEnvelope(search.json);
    const records = Array.isArray(envelope?.data) ? envelope.data.map(asEntry).filter((e): e is UnisonEntry => e !== null) : [];
    let best: { entry: UnisonEntry; score: number } | null = null;
    for (const entry of records) {
      if (!entry.lyrics || !entry.format) continue;
      if (!durationWithinTolerance(query.duration, entry.duration ?? null)) continue;
      const score = matchScore(query, {
        title: entry.song ?? "",
        artist: entry.artist ?? "",
        album: entry.album ?? null,
        duration: entry.duration ?? null,
      });
      if (!best || score > best.score) best = { entry, score };
    }

    if (!best || best.score < MATCH_SCORE_THRESHOLD) {
      statuses.push({ provider: PROVIDER, status: "miss", detail: "No matching lyrics on Unison" });
      return { candidates: [], statuses };
    }

    const mapped = toCandidate(best.entry, enabledKeys);
    if (!mapped.ok) {
      // A real match whose source key the user disabled reads as a clean miss for this order;
      // an invalid payload is reported as a malformed response instead.
      statuses.push({
        provider: PROVIDER,
        status: mapped.reason === "disabled" ? "miss" : "error",
        detail: mapped.reason === "disabled" ? "Provider disabled" : "Malformed response",
      });
      return { candidates: [], statuses };
    }
    statuses.push({ provider: PROVIDER, status: "hit", detail: "Matched via search" });
    return { candidates: [mapped.candidate], statuses };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { candidates: [], statuses: [{ provider: PROVIDER, ...describeHttpError(error) }] };
  }
}

const MANUAL_SEARCH_LIMIT = 10;

/**
 * Manual search over Unison's ranked `/lyrics/search` endpoint. Song + artist are required by the
 * server for the full-record mode, so callers skip this when the user left the artist blank.
 * Every usable version is returned (not just the best one), each with its catalogue metadata.
 */
export async function searchUnison(
  query: ProviderQuery,
  enabledKeys: ReadonlySet<string>,
  signal?: AbortSignal,
  timeoutMs: number = UNISON_REQUEST_TIMEOUT_MS
): Promise<ProviderOutcome> {
  if (!query.artist.trim()) {
    return { candidates: [], statuses: [{ provider: PROVIDER, status: "skipped", detail: "Artist required for Unison search" }] };
  }
  try {
    const params = new URLSearchParams({ song: query.title, artist: query.artist, limit: String(MANUAL_SEARCH_LIMIT) });
    if (query.album) params.set("album", query.album);
    if (query.duration > 0) params.set("duration", String(Math.round(query.duration)));
    const response = await getJson(`${UNISON_BASE_URL}/lyrics/search?${params.toString()}`, timeoutMs, signal);

    if (response.status === 429) {
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "error", detail: retryAfter(response.headers) ? `Rate limited; retry after ${retryAfter(response.headers)}s` : "Rate limited" }] };
    }
    if (!response.ok) {
      if (response.status === 404) return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on Unison" }] };
      const envelope = asEnvelope(response.json);
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "error", detail: envelope?.error || `Request failed (${response.status})` }] };
    }

    const envelope = asEnvelope(response.json);
    const records = Array.isArray(envelope?.data) ? envelope.data.map(asEntry).filter((e): e is UnisonEntry => e !== null) : [];
    const candidates: LyricsCandidate[] = [];
    const seen = new Set<string>();
    for (const entry of records) {
      const mapped = toUnisonCandidate(entry, enabledKeys);
      if (!mapped.ok) continue;
      const candidate = mapped.candidate;
      const dedupeKey = `${candidate.source}:${candidate.text.length}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      candidates.push({
        ...candidate,
        matchTitle: entry.song ?? null,
        matchArtist: entry.artist ?? null,
        matchAlbum: entry.album ?? null,
        matchDuration: typeof entry.duration === "number" ? entry.duration : null,
      });
    }

    if (candidates.length === 0) {
      return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on Unison" }] };
    }
    return { candidates, statuses: [{ provider: PROVIDER, status: "hit", detail: `${candidates.length} result${candidates.length === 1 ? "" : "s"}` }] };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { candidates: [], statuses: [{ provider: PROVIDER, ...describeHttpError(error) }] };
  }
}
