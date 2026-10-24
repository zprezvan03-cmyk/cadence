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
 *   carries no key, never bypasses the check, and treats 401 as a documented limitation rather
 *   than inventing credentials. The keyless provider endpoints still widen coverage, and every
 *   successful response is cached locally.
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
  retryAfter,
  type JsonResponse,
  type ProviderOutcome,
  type ProviderQuery,
  type ProviderStatus,
} from "./http";

const PROVIDER = "better-lyrics";

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

function buildUrl(path: string, query: ProviderQuery): string {
  const params = new URLSearchParams({ s: query.title, a: query.artist });
  if (query.album) params.set("al", query.album);
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
  const candidates: LyricsCandidate[] = [];
  const problems: string[] = [];
  let sawRateLimit = false;

  for (const endpoint of ENDPOINTS) {
    if (!enabledKeys.has(endpoint.source)) continue;
    try {
      const response = await getJson(buildUrl(endpoint.path, query), timeoutMs, signal);

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
        });
        continue;
      }

      if (response.status === 404) {
        // Definitive "no lyrics" (often a server-held negative cache entry).
        continue;
      }

      if (response.status === 401) {
        // Documented keyless-access limit: only server-cached songs are available without a key.
        problems.push("Uncached song; API keys are not issued to third-party apps");
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

  const status = summarize(candidates, problems, sawRateLimit, enabledKeys);
  return { candidates, statuses: [status] };
}

/**
 * Manual search against the Better Lyrics API. It exposes no list endpoint, so the typed metadata
 * is queried directly and every enabled endpoint that answers becomes one row. A keyless 401 on
 * an uncached song stays a non-fatal problem (reported in the status list), never an exception.
 */
export async function searchBetterLyrics(
  query: ProviderQuery,
  enabledKeys: ReadonlySet<string>,
  signal?: AbortSignal,
  timeoutMs: number = BETTER_LYRICS_REQUEST_TIMEOUT_MS
): Promise<ProviderOutcome> {
  const candidates: LyricsCandidate[] = [];
  const problems: string[] = [];
  let sawRateLimit = false;

  for (const endpoint of ENDPOINTS) {
    if (!enabledKeys.has(endpoint.source)) continue;
    try {
      const response = await getJson(buildUrl(endpoint.path, query), timeoutMs, signal);
      if (!response.ok) {
        if (response.status === 404) continue;
        if (response.status === 401) {
          problems.push("Uncached song; API keys are not issued to third-party apps");
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
        continue;
      }
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
        // The API returns the lyric document only, so the row carries the searched metadata.
        matchTitle: query.title,
        matchArtist: query.artist,
        matchAlbum: query.album || null,
        matchDuration: query.duration > 0 ? Math.round(query.duration) : null,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      const classified = describeHttpError(error);
      if (classified.detail.includes("Rate limited")) sawRateLimit = true;
      problems.push(classified.detail);
    }
  }

  const status = summarize(candidates, problems, sawRateLimit, enabledKeys);
  return { candidates, statuses: [status] };
}

function summarize(
  candidates: LyricsCandidate[],
  problems: string[],
  sawRateLimit: boolean,
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
    return { provider: PROVIDER, status: "miss", detail: "No lyrics on the Better Lyrics API" };
  }
  // Rate limits and transport/keyless failures stay distinct from a genuine miss, and (in the
  // service) prevent a negative cache entry from blocking a later retry.
  const detail = sawRateLimit
    ? problems.find(part => part.includes("Rate limited")) ?? problems[0]
    : problems[0];
  return { provider: PROVIDER, status: "error", detail };
}
