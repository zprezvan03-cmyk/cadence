/**
 * Better Lyrics API provider for Cadence — the public Go backend in `better-lyrics/api`,
 * documented at https://docs.betterlyrics.org (base URL `https://api.betterlyrics.org`).
 *
 * Verified contract (OpenAPI/reference docs plus the server's `routes.go`/`handlers.go`):
 * - `GET /getLyrics?s&a&al&d` returns `{ ttml }` — syllable *or* line-timed TTML, metadata based,
 *   no video ID required. The endpoint serves both, so the parsed payload — not the endpoint, the
 *   `ttml` field name or the MIME type — decides whether the result is attributed to
 *   `blyrics-richsynced` ("Better Lyrics") or `blyrics-line` ("Better Lyrics Line").
 * - `GET /qq/getLyrics`   returns `{ lyrics, provider }` — word-timed QRC (or timed LRC).
 * - `GET /kugou/getLyrics` returns `{ lyrics, provider }` — line-synced LRC-style text.
 * - Reads need no key *for cached songs*. An uncached query answers 401 because fresh-fetch API
 *   keys are issued only to the Better Lyrics extension and are not for redistribution. Cadence
 *   carries no key, never bypasses the check, and treats 401 as a documented limitation rather
 *   than inventing credentials or negative-caching the miss.
 */

import {
  BETTER_LYRICS_API_BASE_URL,
  BETTER_LYRICS_REQUEST_TIMEOUT_MS,
} from "../../shared/upstream/better-lyrics/constants";
import type { LyricsCandidate } from "../../shared/types";
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
import { inspectLyricsPayload, type InspectedLyricsPayload } from "./syncInspection";

const PROVIDER = "better-lyrics";
const NO_LYRICS_SENTINEL = "NoLyricsSentinel";

/** The provider identity a payload resolves to: one registry source key and its display name. */
interface ProviderIdentity {
  source: string;
  providerName: string;
}

interface EndpointSpec {
  path: "/getLyrics" | "/qq/getLyrics" | "/kugou/getLyrics";
  bodyField: "ttml" | "lyrics";
  /** Every registry key this endpoint can produce; the endpoint runs if any one is enabled. */
  sources: readonly string[];
  /** Picks the identity from the *parsed* payload, never from the endpoint or the field name. */
  identify(inspected: InspectedLyricsPayload): ProviderIdentity;
}

const BETTER_LYRICS_SYLLABLE: ProviderIdentity = {
  source: "blyrics-richsynced",
  providerName: "Better Lyrics",
};
const BETTER_LYRICS_LINE: ProviderIdentity = {
  source: "blyrics-line",
  providerName: "Better Lyrics Line",
};

const ENDPOINTS: readonly EndpointSpec[] = [
  {
    path: "/getLyrics",
    bodyField: "ttml",
    sources: [BETTER_LYRICS_SYLLABLE.source, BETTER_LYRICS_LINE.source],
    // `/getLyrics` serves both granularities. Only TTML whose parsed lines are genuinely split
    // into timed syllables is Better Lyrics; everything else is Better Lyrics Line.
    identify: inspected =>
      inspected.syncType === "richsync" ? BETTER_LYRICS_SYLLABLE : BETTER_LYRICS_LINE,
  },
  {
    path: "/qq/getLyrics",
    bodyField: "lyrics",
    sources: ["blyrics-wordsynced"],
    identify: () => ({ source: "blyrics-wordsynced", providerName: "Better Lyrics (QQ)" }),
  },
  {
    path: "/kugou/getLyrics",
    bodyField: "lyrics",
    sources: ["blyrics-synced"],
    identify: () => ({ source: "blyrics-synced", providerName: "Better Lyrics (Kugou)" }),
  },
];

function buildUrl(path: string, query: ProviderQuery): string {
  const title = query.title.trim();
  const artist = query.artist.trim();
  const album = query.album.trim();
  const duration = Math.round(query.duration);
  const params = new URLSearchParams({ s: title, a: artist });
  if (album) params.set("al", album);
  if (Number.isFinite(duration) && duration > 0) params.set("d", String(duration));
  return `${BETTER_LYRICS_API_BASE_URL}${path}?${params.toString()}`;
}

type ExtractedBody =
  | { kind: "ok"; text: string }
  | { kind: "empty" }
  | { kind: "malformed" };

function extractBodyText(response: JsonResponse, field: EndpointSpec["bodyField"]): ExtractedBody {
  if (typeof response.json !== "object" || response.json === null) return { kind: "malformed" };
  const raw = (response.json as Record<string, unknown>)[field];
  if (typeof raw !== "string") return { kind: "malformed" };
  let value = raw;
  // Unwrap double-encoded `{ "ttml": "<tt..." }` payloads observed in legacy cache entries.
  if (field === "ttml" && value.trim().startsWith("{")) {
    try {
      const inner = JSON.parse(value) as { ttml?: unknown };
      if (typeof inner?.ttml === "string") value = inner.ttml;
    } catch {
      return { kind: "malformed" };
    }
  }
  const trimmed = value.trim();
  if (!trimmed) return { kind: "malformed" };
  if (trimmed === NO_LYRICS_SENTINEL) return { kind: "empty" };
  return { kind: "ok", text: value };
}

function validateEndpointPayload(
  endpoint: EndpointSpec,
  inspected: InspectedLyricsPayload
): "ok" | "miss" | "malformed" {
  if (endpoint.path === "/getLyrics") {
    if (inspected.format !== "ttml") return "malformed";
    return inspected.usable ? "ok" : "miss";
  }
  // Both `/qq/getLyrics` and `/kugou/getLyrics` represent synchronized lyrics slots: never
  // advertise untimed plain text as word-synced or line-synced.
  if (inspected.format === "plain") return "malformed";
  if (!inspected.usable) return "miss";
  return inspected.syncType !== "none" ? "ok" : "malformed";
}

function errorBody(response: JsonResponse): { error?: string; message?: string } | null {
  if (typeof response.json !== "object" || response.json === null) return null;
  return response.json as { error?: string; message?: string };
}

async function queryBetterLyricsEndpoints(
  query: ProviderQuery,
  enabledKeys: ReadonlySet<string>,
  attachMatchMetadata: boolean,
  signal?: AbortSignal,
  timeoutMs: number = BETTER_LYRICS_REQUEST_TIMEOUT_MS
): Promise<ProviderOutcome> {
  const enabled = ENDPOINTS.some(endpoint => endpoint.sources.some(key => enabledKeys.has(key)));
  if (!enabled) {
    return { candidates: [], statuses: [{ provider: PROVIDER, status: "skipped", detail: "Provider disabled" }] };
  }
  if (!query.title.trim() && !query.artist.trim()) {
    return { candidates: [], statuses: [{ provider: PROVIDER, status: "skipped", detail: "Song or artist required" }] };
  }

  const candidates: LyricsCandidate[] = [];
  const problems: string[] = [];
  /** Identities the payload resolved to whose registry slot the user has disabled. */
  const disabledHits: string[] = [];
  let sawRateLimit = false;
  let maxRetryAfter: number | undefined;

  for (const endpoint of ENDPOINTS) {
    // An endpoint is queried when *any* identity it can produce is enabled; the payload then
    // decides which one, and a result for a disabled slot is dropped below.
    if (!endpoint.sources.some(key => enabledKeys.has(key))) continue;
    try {
      const response = await getJson(buildUrl(endpoint.path, query), timeoutMs, signal);

      if (response.ok) {
        const extracted = extractBodyText(response, endpoint.bodyField);
        if (extracted.kind === "empty") continue;
        if (extracted.kind === "malformed") {
          problems.push(`${endpoint.path}: malformed response`);
          continue;
        }
        const inspected = inspectLyricsPayload(extracted.text, {
          durationSeconds: query.duration,
          title: query.title,
          artist: query.artist,
        });
        const validity = validateEndpointPayload(endpoint, inspected);
        if (validity === "miss") continue;
        if (validity === "malformed") {
          problems.push(`${endpoint.path}: malformed response`);
          continue;
        }
        // Identity is derived per response, inside the loop: a fallback to a later endpoint can
        // never inherit the identity of an earlier one.
        const identity = endpoint.identify(inspected);
        if (!enabledKeys.has(identity.source)) {
          disabledHits.push(identity.providerName);
          continue;
        }
        const candidate: LyricsCandidate = {
          source: identity.source,
          provider: identity.providerName,
          text: extracted.text,
          syncHint: inspected.syncType,
          language: inspected.language,
          songwriters: inspected.songwriters,
          sourceHref: "https://betterlyrics.org",
          cached: false,
        };
        if (attachMatchMetadata) {
          candidate.matchTitle = query.title;
          candidate.matchArtist = query.artist;
          candidate.matchAlbum = query.album || null;
          candidate.matchDuration = query.duration > 0 ? Math.round(query.duration) : null;
        }
        candidates.push(candidate);
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
        if (wait !== undefined) maxRetryAfter = Math.max(maxRetryAfter ?? 0, wait);
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
      if (classified.detail.includes("Rate limited")) {
        sawRateLimit = true;
        if (classified.retryAfterSeconds !== undefined) {
          maxRetryAfter = Math.max(maxRetryAfter ?? 0, classified.retryAfterSeconds);
        }
      }
      problems.push(classified.detail);
    }
  }

  const status = summarize(candidates, problems, disabledHits, sawRateLimit, maxRetryAfter);
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
  return queryBetterLyricsEndpoints(query, enabledKeys, false, signal, timeoutMs);
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
  return queryBetterLyricsEndpoints(query, enabledKeys, true, signal, timeoutMs);
}

function summarize(
  candidates: LyricsCandidate[],
  problems: string[],
  disabledHits: string[],
  sawRateLimit: boolean,
  retryAfterSeconds?: number
): ProviderStatus {
  if (candidates.length > 0) {
    return {
      provider: PROVIDER,
      status: "hit",
      detail: candidates.map(candidate => candidate.provider).join(", "),
    };
  }
  if (problems.length === 0) {
    // Lyrics existed but belonged to a provider slot the user removed/disabled: say so instead of
    // pretending the API had nothing, and never re-label them as an enabled sibling provider.
    const detail = disabledHits.length
      ? `${[...new Set(disabledHits)].join(", ")} disabled for this track`
      : "No lyrics on the Better Lyrics API";
    return { provider: PROVIDER, status: "miss", detail };
  }
  // Rate limits and transport/keyless failures stay distinct from a genuine miss, and (in the
  // service) prevent a negative cache entry from blocking a later retry.
  const detail = sawRateLimit
    ? problems.find(part => part.includes("Rate limited")) ?? problems[0]
    : problems[0];
  return {
    provider: PROVIDER,
    status: "error",
    detail,
    ...(sawRateLimit && retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}
