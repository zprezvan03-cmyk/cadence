/**
 * Popularity Provider Abstraction & Independent Provider Implementations for Cadence.
 *
 * Evaluates Last.fm, Deezer, Apple iTunes, and Google Knowledge Graph independently,
 * normalizes track/artist/duration matching, and strictly prohibits using raw Google Search
 * result counts as popularity metrics.
 */

export type PopularityProviderId = "lastfm" | "deezer" | "itunes" | "google-kg";

export type PopularityFetchFn = typeof fetch;

export interface PopularityProviderConfig {
  /** Master switch for network popularity lookups (false = 100% offline). */
  enabled: boolean;
  /** Optional Last.fm API key from `settings.scrobbling.apiKey`. */
  lastFmApiKey?: string;
  /** Optional Google Knowledge Graph API key. */
  googleKgApiKey?: string;
  /** Per-request timeout in milliseconds (default: 5000). */
  timeoutMs?: number;
  /** Custom fetch transport (defaults to runtimeFetch / globalThis.fetch). */
  fetchFn?: PopularityFetchFn;
  /** Provider priority order (defaults to ["lastfm", "deezer", "itunes", "google-kg"]). */
  providerOrder?: readonly PopularityProviderId[];
}

export interface PopularityQuery {
  trackId?: number;
  title: string;
  artist: string;
  album?: string;
  durationSeconds?: number;
  year?: number | null;
}

export interface PopularityProviderResult {
  provider: PopularityProviderId;
  status: "hit" | "miss" | "unavailable" | "error" | "rate-limited";
  /** Normalized popularity in [0, 1] when status === "hit"; null otherwise. */
  popularity: number | null;
  /** Match & signal confidence in [0, 1]. */
  confidence: number;
  /** Raw provider metric (e.g. listener count, Deezer rank) for diagnostics. */
  rawMetric: number | null;
  /** Enriched genre/style tags returned by the provider. */
  genres: string[];
  detail?: string;
  retryAfterSeconds?: number;
}

export interface ProviderFeasibilityReport {
  provider: PopularityProviderId;
  name: string;
  feasible: boolean;
  requiresCredentials: boolean;
  usesRawSearchCounts: false;
  maxConfidence: number;
  strengths: string[];
  limitations: string[];
  statusReason: string;
}

export interface PopularityProvider {
  readonly id: PopularityProviderId;
  readonly name: string;
  evaluateFeasibility(config: PopularityProviderConfig): ProviderFeasibilityReport;
  isAvailable(config: PopularityProviderConfig): boolean;
  lookup(
    query: PopularityQuery,
    config: PopularityProviderConfig,
    signal?: AbortSignal
  ): Promise<PopularityProviderResult>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normalizes an artist or title string for cross-catalog fuzzy comparison. */
export function normalizeCatalogText(raw: string): string {
  return (raw ?? "")
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/\s*\((?:feat\.?|ft\.?|featuring|remaster(?:ed)?|deluxe|bonus|explicit|clean|single|album\s+version)[^)]*\)/gi, "")
    .replace(/\s*\[(?:feat\.?|ft\.?|featuring|remaster(?:ed)?|deluxe|bonus|explicit|clean)[^\]]*\]/gi, "")
    .replace(/\s*-\s*(?:\d{4}\s+)?remaster(?:ed)?.*$/gi, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Returns true if a track's title or artist is missing or generic ("Track 01", "Unknown", "Intro"). */
export function isUnresolvableQuery(query: PopularityQuery): boolean {
  const title = normalizeCatalogText(query.title);
  const artist = normalizeCatalogText(query.artist);
  if (!title || !artist) return true;
  if (
    artist === "unknown" ||
    artist === "unknown artist" ||
    artist === "various artists" ||
    title === "unknown" ||
    title === "unknown title" ||
    title === "untitled" ||
    title === "intro" ||
    title === "outro" ||
    title === "interlude"
  ) {
    return true;
  }
  if (/^(?:track|audio|song|piste|faixa)\s*\d+$/i.test(title)) {
    return true;
  }
  return false;
}

/**
 * Computes normalized token overlap similarity in [0, 1] between two catalog strings.
 */
export function catalogTextSimilarity(a: string, b: string): number {
  const normA = normalizeCatalogText(a);
  const normB = normalizeCatalogText(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1.0;
  if (normA.includes(normB) || normB.includes(normA)) {
    const ratio = Math.min(normA.length, normB.length) / Math.max(normA.length, normB.length);
    return clamp(0.75 + 0.25 * ratio, 0.75, 0.95);
  }
  const tokensA = new Set(normA.split(" ").filter(Boolean));
  const tokensB = new Set(normB.split(" ").filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection += 1;
  }
  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Evaluates candidate match quality in [0, 1] combining artist similarity, title similarity,
 * and optional duration proximity. Returns 0 if the candidate does not credibly match.
 */
export function scoreCatalogMatch(
  query: PopularityQuery,
  candidate: { title: string; artist: string; durationSeconds?: number | null }
): number {
  const titleSim = catalogTextSimilarity(query.title, candidate.title);
  const artistSim = catalogTextSimilarity(query.artist, candidate.artist);
  if (titleSim < 0.55 || artistSim < 0.5) return 0;

  let durationFactor = 0.9;
  if (
    query.durationSeconds &&
    query.durationSeconds > 0 &&
    candidate.durationSeconds &&
    candidate.durationSeconds > 0
  ) {
    const diff = Math.abs(query.durationSeconds - candidate.durationSeconds);
    if (diff <= 3) durationFactor = 1.0;
    else if (diff <= 8) durationFactor = 0.92;
    else if (diff <= 15) durationFactor = 0.75;
    else return 0; // Reject radio edits / wrong versions differing by > 15s
  }

  return clamp((0.55 * titleSim + 0.45 * artistSim) * durationFactor, 0, 1);
}

async function fetchJsonWithTimeout(
  url: string,
  config: PopularityProviderConfig,
  signal?: AbortSignal
): Promise<{
  ok: boolean;
  status: number;
  retryAfterSeconds?: number;
  json: unknown;
}> {
  const fetchFn = config.fetchFn ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
  const timeoutMs = clamp(config.timeoutMs ?? 5000, 500, 30_000);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  const response = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: combinedSignal,
  });

  let retryAfterSeconds: number | undefined;
  const retryHeader = response.headers?.get?.("Retry-After");
  if (retryHeader) {
    const parsed = Number(retryHeader);
    if (Number.isFinite(parsed) && parsed > 0) retryAfterSeconds = Math.ceil(parsed);
  }

  const text = await response.text();
  const json = text.trim() ? JSON.parse(text) : null;
  return {
    ok: response.ok,
    status: response.status,
    retryAfterSeconds,
    json,
  };
}

/* ------------------------------------------------------------------ 1. Last.fm Provider */

export class LastFmPopularityProvider implements PopularityProvider {
  readonly id = "lastfm" as const;
  readonly name = "Last.fm";

  evaluateFeasibility(config: PopularityProviderConfig): ProviderFeasibilityReport {
    const hasKey = Boolean(config.lastFmApiKey?.trim());
    return {
      provider: this.id,
      name: this.name,
      feasible: hasKey,
      requiresCredentials: true,
      usesRawSearchCounts: false,
      maxConfidence: 0.92,
      strengths: [
        "Provides cumulative global listener counts and total scrobbles across 20+ years.",
        "Strong coverage across rock, indie, electronic, metal, pop, and anime/doujin.",
        "Includes community-curated top genre tags (track.getTopTags / toptags).",
      ],
      limitations: [
        "Requires the user's Last.fm API key in Settings -> Playback -> Scrobbling.",
        "Does not return track duration consistently for strict edition disambiguation.",
      ],
      statusReason: hasKey
        ? "Ready (using configured Last.fm API key)"
        : "Unavailable (no Last.fm API key configured)",
    };
  }

  isAvailable(config: PopularityProviderConfig): boolean {
    return Boolean(config.enabled && config.lastFmApiKey?.trim());
  }

  async lookup(
    query: PopularityQuery,
    config: PopularityProviderConfig,
    signal?: AbortSignal
  ): Promise<PopularityProviderResult> {
    const apiKey = config.lastFmApiKey?.trim();
    if (!apiKey) {
      return {
        provider: this.id,
        status: "unavailable",
        popularity: null,
        confidence: 0,
        rawMetric: null,
        genres: [],
        detail: "No Last.fm API key configured",
      };
    }

    const params = new URLSearchParams({
      method: "track.getInfo",
      api_key: apiKey,
      artist: query.artist,
      track: query.title,
      autocorrect: "1",
      format: "json",
    });
    const url = `https://ws.audioscrobbler.com/2.0/?${params.toString()}`;

    try {
      const res = await fetchJsonWithTimeout(url, config, signal);
      if (res.status === 429) {
        return {
          provider: this.id,
          status: "rate-limited",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
          retryAfterSeconds: res.retryAfterSeconds ?? 30,
          detail: "Last.fm rate limit reached",
        };
      }

      const body = (res.json ?? {}) as Record<string, unknown>;
      if (typeof body.error === "number") {
        // Error 6 = "Track not found"
        if (body.error === 6) {
          return {
            provider: this.id,
            status: "miss",
            popularity: null,
            confidence: 0,
            rawMetric: null,
            genres: [],
          };
        }
        return {
          provider: this.id,
          status: "error",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
          detail: typeof body.message === "string" ? body.message : `Last.fm error ${body.error}`,
        };
      }

      const trackObj = body.track as Record<string, unknown> | undefined;
      if (!trackObj) {
        return {
          provider: this.id,
          status: "miss",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
        };
      }

      const matchedTitle = typeof trackObj.name === "string" ? trackObj.name : query.title;
      const artistObj = trackObj.artist as Record<string, unknown> | undefined;
      const matchedArtist =
        typeof artistObj?.name === "string" ? artistObj.name : query.artist;
      const durationMs = Number(trackObj.duration ?? 0);
      const durationSeconds = durationMs > 0 ? durationMs / 1000 : null;

      const matchScore = scoreCatalogMatch(query, {
        title: matchedTitle,
        artist: matchedArtist,
        durationSeconds,
      });
      if (matchScore === 0) {
        return {
          provider: this.id,
          status: "miss",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
          detail: "Last.fm track did not match artist/title/duration criteria",
        };
      }

      const listeners = Math.max(0, Number(trackObj.listeners ?? 0));
      const playcount = Math.max(0, Number(trackObj.playcount ?? 0));
      const effectiveMetric = listeners > 0 ? listeners : Math.floor(playcount / 8);

      // Extract top genre tags
      const genres: string[] = [];
      const toptags = trackObj.toptags as { tag?: unknown } | undefined;
      const tagList = Array.isArray(toptags?.tag) ? toptags.tag : [];
      for (const item of tagList.slice(0, 6)) {
        const name = (item as { name?: unknown })?.name;
        if (typeof name === "string" && name.trim()) {
          genres.push(name.trim());
        }
      }

      if (effectiveMetric <= 0) {
        return {
          provider: this.id,
          status: "miss",
          popularity: null,
          confidence: 0,
          rawMetric: 0,
          genres,
        };
      }

      // Log10 scale: ~30 listeners -> 0.05, 10,000 -> 0.50, 300,000 -> 0.80, 3,000,000+ -> 1.0
      const popularity = clamp((Math.log10(effectiveMetric + 1) - 1.5) / 5.0, 0.05, 1.0);
      const confidence = clamp(0.92 * matchScore, 0.4, 0.92);

      return {
        provider: this.id,
        status: "hit",
        popularity,
        confidence,
        rawMetric: effectiveMetric,
        genres,
      };
    } catch (error) {
      return {
        provider: this.id,
        status: "error",
        popularity: null,
        confidence: 0,
        rawMetric: null,
        genres: [],
        detail: (error as Error)?.message ?? "Last.fm lookup failed",
      };
    }
  }
}

/* ------------------------------------------------------------------ 2. Deezer Provider */

export class DeezerPopularityProvider implements PopularityProvider {
  readonly id = "deezer" as const;
  readonly name = "Deezer Catalog";

  evaluateFeasibility(config: PopularityProviderConfig): ProviderFeasibilityReport {
    return {
      provider: this.id,
      name: this.name,
      feasible: config.enabled,
      requiresCredentials: false,
      usesRawSearchCounts: false,
      maxConfidence: 0.78,
      strengths: [
        "Keyless public API returning an explicit popularity rank (0..1,000,000) and exact track duration.",
        "Allows strict duration verification (+/- 8s) to reject mismatched remixes or radio edits.",
      ],
      limitations: [
        "Not universal: incomplete catalog coverage for self-released indie, Bandcamp, or regional Japanese/anime tracks.",
        "Confidence is capped at 0.78 so missing or regional entries never dominate or penalize tracks.",
      ],
      statusReason: config.enabled
        ? "Ready (keyless public catalog endpoint)"
        : "Disabled by settings",
    };
  }

  isAvailable(config: PopularityProviderConfig): boolean {
    return Boolean(config.enabled);
  }

  async lookup(
    query: PopularityQuery,
    config: PopularityProviderConfig,
    signal?: AbortSignal
  ): Promise<PopularityProviderResult> {
    const cleanArtist = query.artist.replace(/"/g, " ").trim();
    const cleanTitle = query.title.replace(/"/g, " ").trim();
    const searchQ = `artist:"${cleanArtist}" track:"${cleanTitle}"`;
    const url = `https://api.deezer.com/search/track?q=${encodeURIComponent(searchQ)}&limit=10`;

    try {
      const res = await fetchJsonWithTimeout(url, config, signal);
      if (res.status === 429) {
        return {
          provider: this.id,
          status: "rate-limited",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
          retryAfterSeconds: res.retryAfterSeconds ?? 15,
        };
      }
      if (!res.ok) {
        return {
          provider: this.id,
          status: "error",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
          detail: `HTTP ${res.status}`,
        };
      }

      const body = (res.json ?? {}) as { data?: unknown[]; error?: { message?: string; code?: number } };
      if (body.error) {
        return {
          provider: this.id,
          status: body.error.code === 4 ? "rate-limited" : "error",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
          detail: body.error.message ?? "Deezer API error",
        };
      }

      const candidates = Array.isArray(body.data) ? body.data : [];
      if (candidates.length === 0) {
        return {
          provider: this.id,
          status: "miss",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
        };
      }

      let bestMatchScore = 0;
      let bestRank = 0;

      for (const raw of candidates) {
        const item = raw as Record<string, unknown>;
        const title = typeof item.title === "string" ? item.title : "";
        const artistObj = item.artist as Record<string, unknown> | undefined;
        const artist = typeof artistObj?.name === "string" ? artistObj.name : "";
        const duration = typeof item.duration === "number" ? item.duration : null;
        const rank = typeof item.rank === "number" ? item.rank : 0;

        const mScore = scoreCatalogMatch(query, {
          title,
          artist,
          durationSeconds: duration,
        });
        if (mScore > bestMatchScore || (mScore >= bestMatchScore - 0.03 && mScore > 0 && rank > bestRank)) {
          bestMatchScore = Math.max(bestMatchScore, mScore);
          bestRank = Math.max(bestRank, rank);
        }
      }

      if (bestMatchScore === 0 || bestRank <= 0) {
        return {
          provider: this.id,
          status: "miss",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
        };
      }

      // Log10 normalization of Deezer rank (100 -> 0.05, 10,000 -> 0.50, 300,000 -> 0.87, 1,000,000 -> 1.0)
      const popularity = clamp((Math.log10(Math.max(100, bestRank)) - 2.0) / 4.0, 0.05, 1.0);
      const confidence = clamp(0.78 * bestMatchScore, 0.35, 0.78);

      return {
        provider: this.id,
        status: "hit",
        popularity,
        confidence,
        rawMetric: bestRank,
        genres: [],
      };
    } catch (error) {
      return {
        provider: this.id,
        status: "error",
        popularity: null,
        confidence: 0,
        rawMetric: null,
        genres: [],
        detail: (error as Error)?.message ?? "Deezer lookup failed",
      };
    }
  }
}

/* ------------------------------------------------------------------ 3. Apple iTunes Provider */

export class ItunesPopularityProvider implements PopularityProvider {
  readonly id = "itunes" as const;
  readonly name = "Apple iTunes Catalog";

  evaluateFeasibility(config: PopularityProviderConfig): ProviderFeasibilityReport {
    return {
      provider: this.id,
      name: this.name,
      feasible: config.enabled,
      requiresCredentials: false,
      usesRawSearchCounts: false,
      maxConfidence: 0.55,
      strengths: [
        "Keyless public catalog API with broad international and Asian/soundtrack coverage.",
        "Reliably returns primaryGenreName for missing-genre enrichment plus trackTimeMillis for duration verification.",
      ],
      limitations: [
        "Does not expose raw stream counts; estimates prominence from catalog relevance rank and multi-release presence.",
        "Confidence is conservatively capped at 0.55 so it corroborates rather than overrides direct listener metrics.",
      ],
      statusReason: config.enabled
        ? "Ready (keyless public catalog endpoint)"
        : "Disabled by settings",
    };
  }

  isAvailable(config: PopularityProviderConfig): boolean {
    return Boolean(config.enabled);
  }

  async lookup(
    query: PopularityQuery,
    config: PopularityProviderConfig,
    signal?: AbortSignal
  ): Promise<PopularityProviderResult> {
    const term = `${query.artist} ${query.title}`.trim();
    const url = `https://itunes.apple.com/search?media=music&entity=song&limit=15&term=${encodeURIComponent(term)}`;

    try {
      const res = await fetchJsonWithTimeout(url, config, signal);
      if (res.status === 429 || res.status === 403) {
        return {
          provider: this.id,
          status: "rate-limited",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
          retryAfterSeconds: res.retryAfterSeconds ?? 30,
        };
      }
      if (!res.ok) {
        return {
          provider: this.id,
          status: "error",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
          detail: `HTTP ${res.status}`,
        };
      }

      const body = (res.json ?? {}) as { results?: unknown[] };
      const results = Array.isArray(body.results) ? body.results : [];
      if (results.length === 0) {
        return {
          provider: this.id,
          status: "miss",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
        };
      }

      let bestMatchScore = 0;
      let bestIndex = -1;
      let matchingEditions = 0;
      const genres = new Set<string>();

      results.forEach((raw, idx) => {
        const item = raw as Record<string, unknown>;
        const title = typeof item.trackName === "string" ? item.trackName : "";
        const artist = typeof item.artistName === "string" ? item.artistName : "";
        const durationMs = typeof item.trackTimeMillis === "number" ? item.trackTimeMillis : 0;
        const durationSeconds = durationMs > 0 ? durationMs / 1000 : null;

        const mScore = scoreCatalogMatch(query, { title, artist, durationSeconds });
        if (mScore > 0) {
          matchingEditions += 1;
          const genre = typeof item.primaryGenreName === "string" ? item.primaryGenreName.trim() : "";
          if (genre && genre.toLowerCase() !== "music") {
            genres.add(genre);
          }
          if (mScore > bestMatchScore) {
            bestMatchScore = mScore;
            bestIndex = idx;
          }
        }
      });

      if (bestMatchScore === 0 || bestIndex < 0) {
        return {
          provider: this.id,
          status: "miss",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
        };
      }

      // Prominence heuristic from rank position in Apple's relevance order + multi-edition appearances
      const rankScore = Math.max(0.35, 0.80 - bestIndex * 0.04);
      const editionBonus = Math.min(0.18, (matchingEditions - 1) * 0.05);
      const popularity = clamp(rankScore + editionBonus, 0.30, 0.92);
      const confidence = clamp(0.55 * bestMatchScore, 0.25, 0.55);

      return {
        provider: this.id,
        status: "hit",
        popularity,
        confidence,
        rawMetric: matchingEditions,
        genres: [...genres],
      };
    } catch (error) {
      return {
        provider: this.id,
        status: "error",
        popularity: null,
        confidence: 0,
        rawMetric: null,
        genres: [],
        detail: (error as Error)?.message ?? "iTunes lookup failed",
      };
    }
  }
}

/* ------------------------------------------------------------------ 4. Google Knowledge Graph Provider & Google Search Evaluation */

/**
 * Independent technical & legal evaluation of Google Search vs. Google Knowledge Graph for
 * estimating music popularity.
 *
 * Raw Google Search result counts (`searchInformation.totalResults`) are explicitly rejected:
 * 1. Lexical Confounding: Common words in song titles ("Love", "One", "Home", "Time") yield
 *    billions of unrelated web hits regardless of whether the recording is popular.
 * 2. Scraping Prohibitions: Automated scraping of google.com/search HTML triggers CAPTCHAs and
 *    HTTP 429 blocks.
 * 3. Only structured entity resolution (`MusicRecording` via Google Knowledge Graph `resultScore`)
 *    is permitted when an API key is configured, and raw hit-count payloads are rejected.
 */
export function evaluateGoogleSearchFeasibility(config: PopularityProviderConfig): {
  rawSearchCountsAllowed: false;
  rawSearchRejectionReason: string;
  knowledgeGraphFeasible: boolean;
} {
  return {
    rawSearchCountsAllowed: false,
    rawSearchRejectionReason:
      "Raw Google Search result counts measure lexical word frequency across the web rather than musical popularity, and scraping Google Search violates ToS and triggers CAPTCHA blocks.",
    knowledgeGraphFeasible: Boolean(config.enabled && config.googleKgApiKey?.trim()),
  };
}

export class GoogleKnowledgeGraphPopularityProvider implements PopularityProvider {
  readonly id = "google-kg" as const;
  readonly name = "Google Knowledge Graph";

  evaluateFeasibility(config: PopularityProviderConfig): ProviderFeasibilityReport {
    const hasKey = Boolean(config.googleKgApiKey?.trim());
    return {
      provider: this.id,
      name: this.name,
      feasible: Boolean(config.enabled && hasKey),
      requiresCredentials: true,
      usesRawSearchCounts: false,
      maxConfidence: 0.50,
      strengths: [
        "Resolves disambiguated Schema.org MusicRecording entities with structured resultScore salience.",
        "Never uses raw web page hit counts.",
      ],
      limitations: [
        "Requires a Google Cloud Knowledge Graph Search API key.",
        "Entity salience reflects encyclopedia/web prominence rather than current streaming velocity.",
      ],
      statusReason: hasKey
        ? "Ready (using Google Knowledge Graph API key)"
        : "Unavailable (no Google Knowledge Graph API key configured)",
    };
  }

  isAvailable(config: PopularityProviderConfig): boolean {
    return Boolean(config.enabled && config.googleKgApiKey?.trim());
  }

  async lookup(
    query: PopularityQuery,
    config: PopularityProviderConfig,
    signal?: AbortSignal
  ): Promise<PopularityProviderResult> {
    const apiKey = config.googleKgApiKey?.trim();
    if (!apiKey) {
      return {
        provider: this.id,
        status: "unavailable",
        popularity: null,
        confidence: 0,
        rawMetric: null,
        genres: [],
        detail: "No Google Knowledge Graph API key configured",
      };
    }

    const params = new URLSearchParams({
      query: `${query.title} ${query.artist}`,
      types: "MusicRecording",
      limit: "5",
      key: apiKey,
    });
    const url = `https://kgsearch.googleapis.com/v1/entities:search?${params.toString()}`;

    try {
      const res = await fetchJsonWithTimeout(url, config, signal);
      if (res.status === 429) {
        return {
          provider: this.id,
          status: "rate-limited",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
          retryAfterSeconds: res.retryAfterSeconds ?? 60,
        };
      }
      if (!res.ok) {
        return {
          provider: this.id,
          status: "error",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
          detail: `HTTP ${res.status}`,
        };
      }

      const body = (res.json ?? {}) as Record<string, unknown>;
      // Safety guard: reject any raw Custom Search payload that only carries totalResults
      if ("searchInformation" in body && !("itemListElement" in body)) {
        return {
          provider: this.id,
          status: "error",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
          detail: "Refusing to use raw Google Search totalResults count as popularity",
        };
      }

      const elements = Array.isArray(body.itemListElement) ? body.itemListElement : [];
      if (elements.length === 0) {
        return {
          provider: this.id,
          status: "miss",
          popularity: null,
          confidence: 0,
          rawMetric: null,
          genres: [],
        };
      }

      const normArtist = normalizeCatalogText(query.artist);
      for (const raw of elements) {
        const wrapper = raw as { result?: Record<string, unknown>; resultScore?: number };
        const entity = wrapper.result;
        const resultScore = typeof wrapper.resultScore === "number" ? wrapper.resultScore : 0;
        if (!entity || resultScore <= 0) continue;

        const types = Array.isArray(entity["@type"])
          ? (entity["@type"] as unknown[]).map(String)
          : [String(entity["@type"] ?? "")];
        if (!types.includes("MusicRecording")) continue;

        const name = typeof entity.name === "string" ? entity.name : "";
        const description = typeof entity.description === "string" ? entity.description : "";
        const detailed =
          typeof (entity.detailedDescription as { articleBody?: string } | undefined)?.articleBody ===
          "string"
            ? (entity.detailedDescription as { articleBody: string }).articleBody
            : "";

        const titleSim = catalogTextSimilarity(query.title, name);
        const contextText = normalizeCatalogText(`${description} ${detailed}`);
        const artistMentioned = normArtist.length > 0 && contextText.includes(normArtist);

        if (titleSim >= 0.65 && artistMentioned) {
          const popularity = clamp(Math.log10(Math.max(1, resultScore)) / 3.5, 0.1, 0.95);
          return {
            provider: this.id,
            status: "hit",
            popularity,
            confidence: clamp(0.50 * titleSim, 0.25, 0.50),
            rawMetric: Math.round(resultScore),
            genres: [],
          };
        }
      }

      return {
        provider: this.id,
        status: "miss",
        popularity: null,
        confidence: 0,
        rawMetric: null,
        genres: [],
      };
    } catch (error) {
      return {
        provider: this.id,
        status: "error",
        popularity: null,
        confidence: 0,
        rawMetric: null,
        genres: [],
        detail: (error as Error)?.message ?? "Google Knowledge Graph lookup failed",
      };
    }
  }
}

export const DEFAULT_POPULARITY_PROVIDERS: ReadonlyArray<PopularityProvider> = [
  new LastFmPopularityProvider(),
  new DeezerPopularityProvider(),
  new ItunesPopularityProvider(),
  new GoogleKnowledgeGraphPopularityProvider(),
];
