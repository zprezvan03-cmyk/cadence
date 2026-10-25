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
 * - The response envelope is `{ success, data }`, with `data.format` of `ttml | lrc | srt | plain`
 *   and `data.syncType` of `richsync | linesync | plain`. Actual synchronization precision is
 *   verified from the payload itself so mislabeled entries are never advertised as richer than
 *   they are, while raw text passes through untouched to `@braccato/parsers`.
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
import { inspectLyricsPayload } from "./syncInspection";

const PROVIDER = "unison";
const SEARCH_LIMIT = 5;
const MAX_UNISON_DURATION_SECONDS = 7200;

type UnisonFormat = "ttml" | "lrc" | "srt" | "plain";

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

/** Maps a Unison entry to the same source-key split the extension produces, verified against payload content. */
export function toUnisonCandidate(entry: UnisonEntry, enabledKeys: ReadonlySet<string>): CandidateResult {
  return toCandidate(entry, enabledKeys);
}

function toCandidate(entry: UnisonEntry, enabledKeys: ReadonlySet<string>): CandidateResult {
  const format = entry.format as UnisonFormat | undefined;
  const text = typeof entry.lyrics === "string" ? entry.lyrics : "";
  if (!text || !format || !["ttml", "lrc", "srt", "plain"].includes(format)) {
    return { ok: false, reason: "invalid" };
  }

  const inspected = inspectLyricsPayload(text, {
    durationSeconds: typeof entry.duration === "number" ? entry.duration : undefined,
    title: entry.song ?? undefined,
    artist: entry.artist ?? undefined,
  });
  if (!inspected.usable) {
    return { ok: false, reason: "invalid" };
  }

  let source: string;
  let syncHint: LyricsSyncType;
  if (format === "ttml") {
    if (inspected.format !== "ttml") return { ok: false, reason: "invalid" };
    if (inspected.syncType === "richsync") {
      source = "unison-richsynced";
      syncHint = "richsync";
    } else {
      source = "unison-synced";
      syncHint = "synced";
    }
  } else if (format === "lrc") {
    if (inspected.format === "lrc") {
      if (inspected.syncType === "richsync") {
        source = "unison-wordsynced";
        syncHint = "richsync";
      } else {
        source = "unison-synced";
        syncHint = "synced";
      }
    } else if (inspected.format === "srt") {
      source = "unison-synced";
      syncHint = "synced";
    } else if (inspected.format === "plain") {
      // Never advertise untimed plain text as synchronized lyrics even if mislabeled `format: "lrc"`.
      source = "unison-plain";
      syncHint = "none";
    } else {
      return { ok: false, reason: "invalid" };
    }
  } else if (format === "srt") {
    if (inspected.syncType === "none") {
      source = "unison-plain";
      syncHint = "none";
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
      language: entry.language ?? inspected.language,
      songwriters: inspected.songwriters,
      sourceHref: "https://unison.boidu.dev/",
      cached: false,
    },
  };
}

function buildUrl(
  path: "/lyrics" | "/lyrics/search",
  query: ProviderQuery,
  limit?: number
): string {
  const title = query.title.trim();
  const artist = query.artist.trim();
  const album = query.album.trim();
  const duration = Math.round(query.duration);
  const params = new URLSearchParams({ song: title, artist });
  if (album) params.set("album", album);
  if (Number.isFinite(duration) && duration >= 1 && duration <= MAX_UNISON_DURATION_SECONDS) {
    params.set("duration", String(duration));
  }
  if (limit !== undefined) params.set("limit", String(limit));
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

function rateLimitOutcome(headers: Headers): ProviderOutcome {
  const wait = retryAfter(headers);
  return {
    candidates: [],
    statuses: [
      {
        provider: PROVIDER,
        status: "error",
        detail: wait ? `Rate limited; retry after ${wait}s` : "Rate limited",
        ...(wait !== undefined ? { retryAfterSeconds: wait } : {}),
      },
    ],
  };
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
  if (!query.title.trim() || !query.artist.trim()) {
    return {
      candidates: [],
      statuses: [{ provider: PROVIDER, status: "skipped", detail: "Song and artist required for Unison" }],
    };
  }

  const statuses: ProviderStatus[] = [];
  try {
    const primary = await getJson(buildUrl("/lyrics", query), timeoutMs, signal);

    if (primary.status === 429) {
      return rateLimitOutcome(primary.headers);
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
                detail: `${String(entry.format ?? "").toUpperCase()} ${mapped.candidate.syncHint}`.trim(),
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
    const search = await getJson(buildUrl("/lyrics/search", query, SEARCH_LIMIT), timeoutMs, signal);
    if (search.status === 429) {
      return rateLimitOutcome(search.headers);
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
    if (!envelope || envelope.success !== true || !Array.isArray(envelope.data)) {
      return {
        candidates: [],
        statuses: [{ provider: PROVIDER, status: "error", detail: "Malformed response" }],
      };
    }

    const records = envelope.data.map(asEntry).filter((e): e is UnisonEntry => e !== null);
    const matched: { entry: UnisonEntry; score: number }[] = [];
    for (const entry of records) {
      if (!entry.lyrics || !entry.format) continue;
      if (!durationWithinTolerance(query.duration, entry.duration ?? null)) continue;
      const score = matchScore(query, {
        title: entry.song ?? "",
        artist: entry.artist ?? "",
        album: entry.album ?? null,
        duration: entry.duration ?? null,
      });
      if (score >= MATCH_SCORE_THRESHOLD) matched.push({ entry, score });
    }

    if (matched.length === 0) {
      statuses.push({ provider: PROVIDER, status: "miss", detail: "No matching lyrics on Unison" });
      return { candidates: [], statuses };
    }

    matched.sort((a, b) => b.score - a.score);
    let sawDisabled = false;
    for (const item of matched) {
      const mapped = toCandidate(item.entry, enabledKeys);
      if (mapped.ok) {
        statuses.push({ provider: PROVIDER, status: "hit", detail: "Matched via search" });
        return { candidates: [mapped.candidate], statuses };
      }
      if (mapped.reason === "disabled") sawDisabled = true;
    }

    statuses.push({
      provider: PROVIDER,
      status: sawDisabled ? "miss" : "error",
      detail: sawDisabled ? "Provider disabled" : "Malformed response",
    });
    return { candidates: [], statuses };
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
    return {
      candidates: [],
      statuses: [{ provider: PROVIDER, status: "skipped", detail: "Artist required for Unison search" }],
    };
  }
  try {
    const response = await getJson(
      buildUrl("/lyrics/search", query, MANUAL_SEARCH_LIMIT),
      timeoutMs,
      signal
    );

    if (response.status === 429) {
      return rateLimitOutcome(response.headers);
    }
    if (!response.ok) {
      if (response.status === 404) {
        return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No matching lyrics on Unison" }] };
      }
      const envelope = asEnvelope(response.json);
      return {
        candidates: [],
        statuses: [{ provider: PROVIDER, status: "error", detail: envelope?.error || `Request failed (${response.status})` }],
      };
    }

    const envelope = asEnvelope(response.json);
    if (!envelope || envelope.success !== true || !Array.isArray(envelope.data)) {
      return {
        candidates: [],
        statuses: [{ provider: PROVIDER, status: "error", detail: "Malformed response" }],
      };
    }

    const records = envelope.data.map(asEntry).filter((e): e is UnisonEntry => e !== null);
    const candidates: LyricsCandidate[] = [];
    const seen = new Set<string>();
    for (const entry of records) {
      const mapped = toUnisonCandidate(entry, enabledKeys);
      if (!mapped.ok) continue;
      const candidate = mapped.candidate;
      const dedupeKey = `${candidate.source}:${candidate.text}`;
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
    return {
      candidates,
      statuses: [{ provider: PROVIDER, status: "hit", detail: `${candidates.length} result${candidates.length === 1 ? "" : "s"}` }],
    };
  } catch (error) {
    if (isAbort(error)) throw error;
    return { candidates: [], statuses: [{ provider: PROVIDER, ...describeHttpError(error) }] };
  }
}
