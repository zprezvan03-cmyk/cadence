/**
 * YouTube Music catalog provider for Cadence — the ArchiveTune-style `MusicBackend` analogue.
 *
 * One provider instance owns the InnerTube client, the anonymous guest session (visitor data),
 * an optional connected-account cookie (supplied per call, never stored here), metadata caching,
 * in-flight request deduplication and a bounded request concurrency. All parsing lives in
 * parsers.ts; all transport in innertube.ts. This module is runtime-agnostic (uses runtimeFetch),
 * so it runs identically in the desktop app (native reqwest via cmd_http_fetch) and in tests.
 *
 * Reference: ArchiveTune's MusicBackend/YouTube (rukamori/ArchiveTune @ c7f0e243, core @
 * fefeefa, GPL-3.0). Filter param strings and browse ids are YouTube interface constants.
 */

import {
  DEFAULT_SESSION,
  InnerTubeClient,
  InnerTubeError,
  type InnerTubeSession,
} from "./innertube";
import {
  parseAlbumPage,
  parseArtistContinuation,
  parseArtistPage,
  parseChartsPage,
  parseExplorePage,
  parseHomePage,
  parseLyricsResponse,
  parseMoodsAndGenres,
  parseNextResponse,
  parsePlayerResponse,
  parsePlaylistPage,
  parseSearchResponse,
  parseSuggestions,
} from "./parsers";
import type {
  YtmAlbumPage,
  YtmArtistPage,
  YtmChartsPage,
  YtmExplorePage,
  YtmHomePage,
  YtmMoodOrGenre,
  YtmPlaylistPage,
  YtmPlayerResult,
  YtmQueueResult,
  YtmSearchFilter,
  YtmSearchResults,
  YtmShelf,
  YtmStreamFormat,
  YtmSuggestions,
} from "../../shared/ytmusic";

/** Music search filter params (InnerTube `params` for /youtubei/v1/search). */
export const YTM_FILTER_PARAMS: Record<Exclude<YtmSearchFilter, "all">, string> = {
  songs: "EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D",
  videos: "EgWKAQIQAWoKEAkQChAFEAMQBA%3D%3D",
  albums: "EgWKAQIYAWoKEAkQChAFEAMQBA%3D%3D",
  artists: "EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D",
  playlists: "EgeKAQQoAEABagoQAxAEEAoQCRAF",
};

export const YTM_BROWSE_IDS = {
  home: "FEmusic_home",
  explore: "FEmusic_explore",
  charts: "FEmusic_charts",
  moodsAndGenres: "FEmusic_moods_and_genres",
  newReleaseAlbums: "FEmusic_new_releases_albums",
  newReleases: "FEmusic_new_releases",
} as const;

export class YtmProviderError extends Error {
  constructor(
    message: string,
    readonly kind: InnerTubeError["kind"] | "empty" | "blocked",
    readonly status?: number
  ) {
    super(message);
    this.name = "YtmProviderError";
  }
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const PAGE_TTL_MS = 5 * 60_000;
const SEARCH_TTL_MS = 60_000;
const MAX_CONCURRENCY = 4;

/** Tiny promise semaphore so remote paging never fans out unboundedly. */
class Limiter {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENCY) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

export interface YouTubeMusicProviderOptions {
  session?: InnerTubeSession;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class YouTubeMusicProvider {
  private readonly client: InnerTubeClient;
  private readonly limiter = new Limiter();
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly now: () => number;
  private visitorPromise: Promise<string> | null = null;

  constructor(options: YouTubeMusicProviderOptions = {}) {
    this.client = new InnerTubeClient(options.session ?? DEFAULT_SESSION, options.fetchImpl);
    this.now = options.now ?? (() => Date.now());
  }

  /** Current session snapshot (visitor data + locale; cookie is supplied per call). */
  getSession(): InnerTubeSession {
    return this.client.getSession();
  }

  setSession(patch: Partial<InnerTubeSession>): void {
    this.client.setSession(patch);
    this.visitorPromise = null;
  }

  /** Abort every in-flight catalog request (used on shutdown / account switch). */
  abortAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.inFlight.clear();
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Ensure an anonymous visitor id exists; fetch one lazily on first use. */
  private async ensureVisitorData(signal?: AbortSignal): Promise<void> {
    if (this.client.getSession().visitorData) return;
    if (!this.visitorPromise) {
      this.visitorPromise = this.client.fetchVisitorData(signal).catch(error => {
        this.visitorPromise = null;
        throw error;
      });
    }
    await this.visitorPromise;
  }

  private cached<T>(key: string, ttl: number): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) return null;
    if (entry.expiresAt < this.now()) {
      this.cache.delete(key);
      return null;
    }
    return entry.value;
  }

  /**
   * Run an endpoint call with dedup (identical in-flight calls share one promise), caching for
   * read-only GET-like operations, concurrency limiting and per-key cancellation.
   */
  private async call<T>(
    key: string,
    ttl: number,
    task: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const cached = this.cached<T>(key, ttl);
    if (cached !== null) return cached;
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(key, controller);
    const promise = this.limiter
      .run(async () => {
        await this.ensureVisitorData(controller.signal);
        const value = await task(controller.signal);
        // Anonymous sessions sometimes hand out visitor data in the response itself.
        this.client.setSession({ visitorData: this.client.getSession().visitorData });
        return value;
      })
      .then(value => {
        this.cache.set(key, { value, expiresAt: this.now() + ttl });
        return value;
      })
      .catch(error => {
        if (error instanceof InnerTubeError && error.kind !== "aborted") this.cache.delete(key);
        throw toProviderError(error);
      })
      .finally(() => {
        this.inFlight.delete(key);
        this.controllers.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  /** Cancel one logical operation (search box typing, page navigation). */
  cancel(keyPrefix: string): void {
    for (const [key, controller] of this.controllers) {
      if (key.startsWith(keyPrefix)) controller.abort();
    }
  }

  /* ------------------------------------------------------------- catalog */

  async home(continuation?: string | null): Promise<YtmHomePage> {
    if (continuation) {
      return this.call(`home:cont:${continuation}`, PAGE_TTL_MS, signal =>
        this.client.browse({ continuation }, signal).then(r => parseHomePage(r, true))
      );
    }
    return this.call("home", PAGE_TTL_MS, signal =>
      this.client.browse({ browseId: YTM_BROWSE_IDS.home }, signal).then(r => parseHomePage(r))
    );
  }

  async homeParams(params: string): Promise<YtmHomePage> {
    return this.call(`home:params:${params}`, PAGE_TTL_MS, signal =>
      this.client.browse({ browseId: YTM_BROWSE_IDS.home, params }, signal).then(r => parseHomePage(r))
    );
  }

  async search(query: string, filter: YtmSearchFilter = "all", continuation?: string | null): Promise<YtmSearchResults> {
    const trimmed = query.trim();
    if (!trimmed) throw new YtmProviderError("Empty search query", "empty");
    const params = filter === "all" ? null : YTM_FILTER_PARAMS[filter];
    const key = continuation ? `search:cont:${continuation}` : `search:${filter}:${trimmed}`;
    return this.call(key, continuation ? PAGE_TTL_MS : SEARCH_TTL_MS, signal =>
      this.client.search(trimmed, params, continuation ?? null, signal).then(r => parseSearchResponse(r, filter))
    );
  }

  async suggestions(input: string): Promise<YtmSuggestions> {
    const trimmed = input.trim();
    if (!trimmed) return { queries: [], items: [] };
    // Suggestions are deliberately uncached-but-deduped: they must feel instant and fresh.
    return this.call(`sugg:${trimmed}`, 15_000, signal =>
      this.client.searchSuggestions(trimmed, signal).then(r => parseSuggestions(r))
    );
  }

  async artist(browseId: string): Promise<YtmArtistPage> {
    return this.call(`artist:${browseId}`, PAGE_TTL_MS, signal =>
      this.client.browse({ browseId }, signal).then(r => parseArtistPage(r, browseId))
    );
  }

  async artistContinuation(continuation: string): Promise<{ shelves: YtmShelf[]; continuation: string | null }> {
    return this.call(`artist:cont:${continuation}`, PAGE_TTL_MS, signal =>
      this.client.browse({ continuation }, signal).then(r => parseArtistContinuation(r))
    );
  }

  async album(browseId: string): Promise<YtmAlbumPage> {
    return this.call(`album:${browseId}`, PAGE_TTL_MS, signal =>
      this.client.browse({ browseId }, signal).then(r => parseAlbumPage(r, browseId))
    );
  }

  async playlist(playlistId: string, continuation?: string | null): Promise<YtmPlaylistPage> {
    const key = continuation ? `playlist:cont:${continuation}` : `playlist:${playlistId}`;
    return this.call(key, PAGE_TTL_MS, signal =>
      this.client
        .browse(continuation ? { continuation } : { browseId: `VL${playlistId}` }, signal)
        .then(r => parsePlaylistPage(r, playlistId))
    );
  }

  async charts(continuation?: string | null): Promise<YtmChartsPage> {
    if (continuation) {
      return this.call(`charts:cont:${continuation}`, PAGE_TTL_MS, signal =>
        this.client.browse({ continuation }, signal).then(r => parseChartsPage(r, true))
      );
    }
    return this.call("charts", PAGE_TTL_MS, signal =>
      this.client.browse({ browseId: YTM_BROWSE_IDS.charts }, signal).then(r => parseChartsPage(r))
    );
  }

  async explore(): Promise<YtmExplorePage> {
    return this.call("explore", PAGE_TTL_MS, signal =>
      this.client.browse({ browseId: YTM_BROWSE_IDS.explore }, signal).then(r => parseExplorePage(r))
    );
  }

  async moodsAndGenres(): Promise<YtmMoodOrGenre[]> {
    return this.call("moods", PAGE_TTL_MS, signal =>
      this.client.browse({ browseId: YTM_BROWSE_IDS.moodsAndGenres }, signal).then(r => parseMoodsAndGenres(r))
    );
  }

  async newReleases(): Promise<YtmChartsPage> {
    return this.call("new-releases", PAGE_TTL_MS, signal =>
      this.client
        .browse({ browseId: YTM_BROWSE_IDS.newReleaseAlbums }, signal)
        .then(r => parseChartsPage(r))
    );
  }

  async browseShelves(browseId: string, params?: string | null): Promise<YtmChartsPage> {
    return this.call(`browse:${browseId}:${params ?? ""}`, PAGE_TTL_MS, signal =>
      this.client.browse({ browseId, params }, signal).then(r => parseChartsPage(r))
    );
  }

  /* ------------------------------------------------------------- next / queue / lyrics */

  async next(videoId: string, playlistId?: string | null): Promise<YtmQueueResult> {
    return this.call(`next:${videoId}:${playlistId ?? ""}`, SEARCH_TTL_MS, signal =>
      this.client.next({ videoId, playlistId }, signal).then(r => parseNextResponse(r))
    );
  }

  /** Official YouTube Music lyrics for a track, via next → lyrics browse endpoint. */
  async lyrics(videoId: string): Promise<string | null> {
    const key = `lyrics:${videoId}`;
    return this.call(key, PAGE_TTL_MS, async signal => {
      const next = await this.client.next({ videoId }, signal);
      const parsed = parseNextResponse(next);
      if (!parsed.lyricsBrowseId) return null;
      const response = await this.client.browse(
        { browseId: parsed.lyricsBrowseId, params: parsed.lyricsParams },
        signal
      );
      return parseLyricsResponse(response);
    });
  }

  /* ------------------------------------------------------------- playback resolution */

  async player(videoId: string, playlistId?: string | null): Promise<YtmPlayerResult> {
    // Player responses are per-video and short-lived; never cache them beyond the call.
    return this.limiter.run(async () => {
      const controller = new AbortController();
      try {
        await this.ensureVisitorData(controller.signal);
        const response = await this.client.player(videoId, playlistId, controller.signal);
        return parsePlayerResponse(response, videoId);
      } catch (error) {
        throw toProviderError(error);
      }
    });
  }

  /**
   * Resolve the best directly-playable audio stream. Throws a descriptive YtmProviderError when
   * the only formats are ciphered (Cadence never deciphers signatures) or playback is blocked.
   */
  async resolveStream(videoId: string, playlistId?: string | null): Promise<YtmStreamFormat> {
    const result = await this.player(videoId, playlistId);
    if (result.status !== "OK") {
      throw new YtmProviderError(
        result.reason ?? `Playback unavailable (${result.status})`,
        result.status === "LOGIN_REQUIRED" ? "blocked" : "empty"
      );
    }
    const direct = result.audioFormats.find(format => format.url !== null);
    if (direct?.url) return direct;
    if (result.requiresDeciphering || result.audioFormats.length > 0) {
      throw new YtmProviderError(
        "This track's streams are signature-ciphered; Cadence does not decipher them by policy.",
        "blocked"
      );
    }
    throw new YtmProviderError("No playable audio stream was returned for this track.", "empty");
  }
}

function toProviderError(error: unknown): YtmProviderError {
  if (error instanceof YtmProviderError) return error;
  if (error instanceof InnerTubeError) {
    const message =
      error.kind === "aborted"
        ? "Request cancelled"
        : error.kind === "timeout"
          ? "YouTube Music request timed out"
          : error.kind === "http"
            ? error.message
            : `Could not reach YouTube Music (${error.message})`;
    return new YtmProviderError(message, error.kind, error.status);
  }
  return new YtmProviderError(error instanceof Error ? error.message : String(error), "network");
}

/** Shared default provider for the renderer; tests construct their own with a stub fetch. */
let sharedProvider: YouTubeMusicProvider | null = null;

export function getYouTubeMusicProvider(): YouTubeMusicProvider {
  if (!sharedProvider) sharedProvider = new YouTubeMusicProvider();
  return sharedProvider;
}

export function setYouTubeMusicProvider(provider: YouTubeMusicProvider | null): void {
  sharedProvider?.abortAll();
  sharedProvider = provider;
}
