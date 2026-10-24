/**
 * Better Lyrics API provider for Cadence — the public Go backend in `better-lyrics/api`,
 * documented at https://docs.betterlyrics.org (base URL `https://api.betterlyrics.org`).
 *
 * Verified contract (OpenAPI/reference docs plus the server's `routes.go`/`handlers.go`):
 * - `GET /getLyrics?s&a&al&d` returns `{ ttml }` — syllable/line-timed TTML, metadata based, no
 *   video ID required.
 * - `GET /qq/getLyrics`   returns `{ lyrics, provider }` — word-timed QRC.
 * - `GET /kugou/getLyrics` returns `{ lyrics, provider }` — line-synced LRC-style text.
 * - Reads need no key *for cached songs*. An uncached query answers 401 because fresh-fetch API
 *   keys are issued only to the Better Lyrics extension and are not for redistribution. Cadence
 *   carries no key, never bypasses the check, and treats 401 as an expected keyless cache miss
 *   (retrying once without `al` when album metadata was sent, since server cache keys include
 *   album) so fallback providers and local caching proceed normally.
 *
 * Like the Unison client this is Cadence's own code against the documented public HTTP API (the
 * backend itself is GPL-3.0); the extension's authenticated Cubey/Turnstile stream is not used and
 * cannot be, since it needs a YouTube Music page origin.
 */

import {
  BETTER_LYRICS_API_BASE_URL,
  BETTER_LYRICS_REQUEST_TIMEOUT_MS,
} from "../../shared/upstream/better-lyrics/constants";
import type { LyricsCandidate, LyricsSyncType } from "../../shared/types";
import {
  describeHttpError,
  getJson,
  isAbort,
  LyricsHttpError,
  retryAfter,
  type JsonResponse,
  type ProviderOutcome,
  type ProviderQuery,
  type ProviderStatus,
} from "./http";

const PROVIDER = "better-lyrics";
const SYNTHETIC_ARTISTS = new Set(["unknown artist", "<unknown>"]);
const SYNTHETIC_ALBUMS = new Set(["unknown album", "<unknown>"]);

interface EndpointSpec {
  source: string;
  path: "/getLyrics" | "/qq/getLyrics" | "/kugou/getLyrics";
  bodyField: "ttml" | "lyrics";
  providerName: string;
  hint: (text: string) => LyricsSyncType;
}

/** Word/syllable TTML nests timed `<span>` elements inside each `<p>`; line TTML has only `<p>`. */
export function ttmlSyncHint(ttml: string): LyricsSyncType {
  return /<span[^>]*\bbegin\s*=/i.test(ttml) ? "richsync" : "synced";
}

const ENDPOINTS: readonly EndpointSpec[] = [
  {
    source: "blyrics-richsynced",
    path: "/getLyrics",
    bodyField: "ttml",
    providerName: "Better Lyrics",
    hint: ttmlSyncHint,
  },
  {
    source: "blyrics-wordsynced",
    path: "/qq/getLyrics",
    bodyField: "lyrics",
    providerName: "Better Lyrics (QQ)",
    hint: () => "richsync",
  },
  {
    source: "blyrics-synced",
    path: "/kugou/getLyrics",
    bodyField: "lyrics",
    providerName: "Better Lyrics (Kugou)",
    hint: () => "synced",
  },
];

const ENDPOINT_BY_SOURCE = new Map<string, EndpointSpec>(
  ENDPOINTS.map(endpoint => [endpoint.source, endpoint])
);

function resolveOrderedEndpoints(enabledKeys: ReadonlySet<string>): EndpointSpec[] {
  const ordered: EndpointSpec[] = [];
  const seen = new Set<string>();
  for (const key of enabledKeys) {
    if (seen.has(key)) continue;
    const endpoint = ENDPOINT_BY_SOURCE.get(key);
    if (endpoint) {
      seen.add(key);
      ordered.push(endpoint);
    }
  }
  return ordered;
}

function normalizeField(value: string | null | undefined, placeholders: ReadonlySet<string>): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  return placeholders.has(trimmed.replace(/\s+/g, " ").toLowerCase()) ? "" : trimmed;
}

function normalizeQuery(query: ProviderQuery): ProviderQuery {
  return {
    title: query.title.trim(),
    artist: normalizeField(query.artist, SYNTHETIC_ARTISTS),
    album: normalizeField(query.album, SYNTHETIC_ALBUMS),
    duration: query.duration,
  };
}

function buildUrl(path: string, query: ProviderQuery, includeAlbum = true): string {
  const params = new URLSearchParams({ s: query.title });
  if (query.artist) params.set("a", query.artist);
  if (includeAlbum && query.album) params.set("al", query.album);
  if (query.duration > 0) params.set("d", String(Math.round(query.duration)));
  return `${BETTER_LYRICS_API_BASE_URL}${path}?${params.toString()}`;
}

function bodyText(response: JsonResponse, field: EndpointSpec["bodyField"]): string | null {
  if (typeof response.json !== "object" || response.json === null) return null;
  const value = (response.json as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function errorBody(response: JsonResponse): { error?: string; message?: string } | null {
  if (typeof response.json !== "object" || response.json === null) return null;
  return response.json as { error?: string; message?: string };
}

async function runEndpoints(
  rawQuery: ProviderQuery,
  enabledKeys: ReadonlySet<string>,
  includeMatchMetadata: boolean,
  signal?: AbortSignal,
  timeoutMs: number = BETTER_LYRICS_REQUEST_TIMEOUT_MS
): Promise<ProviderOutcome> {
  const activeEndpoints = resolveOrderedEndpoints(enabledKeys);
  if (activeEndpoints.length === 0) {
    return { candidates: [], statuses: [{ provider: PROVIDER, status: "skipped", detail: "Provider disabled" }] };
  }

  const query = normalizeQuery(rawQuery);
  if (!query.title && !query.artist) {
    return { candidates: [], statuses: [{ provider: PROVIDER, status: "miss", detail: "No lyrics on the Better Lyrics API" }] };
  }

  const candidates: LyricsCandidate[] = [];
  const problems: string[] = [];
  let sawRateLimit = false;
  let sawUncachedMiss = false;

  for (const endpoint of activeEndpoints) {
    if (signal?.aborted) throw new LyricsHttpError("Request aborted", "aborted");
    try {
      let usedAlbum = query.album;
      let response = await getJson(buildUrl(endpoint.path, query, true), timeoutMs, signal);

      if (response.status === 401 && query.album) {
        if (signal?.aborted) throw new LyricsHttpError("Request aborted", "aborted");
        // Server cache keys include `al`; retry once without album before treating 401 as uncached.
        usedAlbum = "";
        response = await getJson(buildUrl(endpoint.path, query, false), timeoutMs, signal);
      }

      if (response.ok) {
        const text = bodyText(response, endpoint.bodyField);
        if (!text) {
          problems.push(`${endpoint.path}: malformed response`);
          continue;
        }
        candidates.push({
          source: endpoint.source,
          provider: endpoint.providerName,
          text,
          syncHint: endpoint.hint(text),
          language: null,
          songwriters: [],
          sourceHref: "https://betterlyrics.org",
          cached: false,
          ...(includeMatchMetadata
            ? {
                // The API returns the lyric document only, so the row carries the searched metadata.
                matchTitle: query.title,
                matchArtist: query.artist || null,
                matchAlbum: usedAlbum || null,
                matchDuration: query.duration > 0 ? Math.round(query.duration) : null,
              }
            : {}),
        });
        continue;
      }

      if (response.status === 404) {
        // Definitive "no lyrics" (often a server-held negative cache entry).
        continue;
      }

      if (response.status === 401) {
        // Expected keyless cache miss: only server-cached songs are available without a key.
        sawUncachedMiss = true;
        continue;
      }

      if (response.status === 429) {
        sawRateLimit = true;
        const wait = retryAfter(response.headers);
        problems.push(wait ? `Rate limited; retry after ${wait}s` : "Rate limited");
        continue;
      }

      if (response.status >= 500) {
        problems.push(`Server error (${response.status})`);
        continue;
      }

      const body = errorBody(response);
      problems.push(body?.error || `Request failed (${response.status})`);
    } catch (error) {
      if (isAbort(error)) throw error;
      const classified = describeHttpError(error);
      if (classified.detail.includes("Rate limited")) sawRateLimit = true;
      problems.push(classified.detail);
    }
  }

  const status = summarize(candidates, problems, sawRateLimit, sawUncachedMiss, enabledKeys);
  return { candidates, statuses: [status] };
}

/**
 * Queries only the endpoints behind enabled source keys, sequentially so one IP never fires three
 * parallel requests at the same rate limiter. A failure on one endpoint never blocks the others.
 */
export async function fetchBetterLyrics(
  query: ProviderQuery,
  enabledKeys: ReadonlySet<string>,
  signal?: AbortSignal,
  timeoutMs: number = BETTER_LYRICS_REQUEST_TIMEOUT_MS
): Promise<ProviderOutcome> {
  return runEndpoints(query, enabledKeys, false, signal, timeoutMs);
}

/**
 * Manual search against the Better Lyrics API. It exposes no list endpoint, so the typed metadata
 * is queried directly and every enabled endpoint that answers becomes one row. A keyless 401 on
 * an uncached song is treated as a normal cache miss rather than a provider error.
 */
export async function searchBetterLyrics(
  query: ProviderQuery,
  enabledKeys: ReadonlySet<string>,
  signal?: AbortSignal,
  timeoutMs: number = BETTER_LYRICS_REQUEST_TIMEOUT_MS
): Promise<ProviderOutcome> {
  return runEndpoints(query, enabledKeys, true, signal, timeoutMs);
}

function summarize(
  candidates: LyricsCandidate[],
  problems: string[],
  sawRateLimit: boolean,
  sawUncachedMiss: boolean,
  enabledKeys: ReadonlySet<string>
): ProviderStatus {
  if (candidates.length > 0) {
    return {
      provider: PROVIDER,
      status: "hit",
      detail: candidates.map(candidate => candidate.provider).join(", "),
    };
  }
  const enabled = ENDPOINTS.some(endpoint => enabledKeys.has(endpoint.source));
  if (!enabled) return { provider: PROVIDER, status: "skipped", detail: "Provider disabled" };
  if (problems.length === 0) {
    return {
      provider: PROVIDER,
      status: "miss",
      detail: sawUncachedMiss
        ? "No cached lyrics on the Better Lyrics API"
        : "No lyrics on the Better Lyrics API",
    };
  }
  // Rate limits and transport/server failures stay distinct from a genuine miss, and (in the
  // service) prevent a negative cache entry from blocking a later retry.
  const detail = sawRateLimit
    ? problems.find(part => part.includes("Rate limited")) ?? problems[0]
    : problems[0];
  return { provider: PROVIDER, status: "error", detail };
}
