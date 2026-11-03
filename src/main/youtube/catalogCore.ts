/**
 * Official, account-free YouTube Data API v3 catalog core.
 *
 * Cadence ships no shared Google credential: every request below uses the API key the user
 * entered in Settings. This module deliberately exposes only documented public endpoints and
 * models their results honestly as YouTube videos, channels and playlists. It does not call
 * InnerTube, does not send cookies/OAuth headers, and never tries to discover stream URLs.
 *
 * The cache is in memory only. That keeps Phase A out of the SQLite database, avoids storing
 * non-authorized API data beyond short-lived response reuse, and makes a key/region change a
 * clean cache boundary. Artwork remains a remote URL; no audiovisual content is downloaded.
 */

import { CLIENT_NAME, ConcurrencyLimiter, runtimeFetch } from "../lyrics/http";
import { normalizeYouTubeArtist } from "../../shared/youtube";
import { isYouTubeMusicAlbumPlaylistId, youtubeMediaItem } from "../../shared/media";
import type {
  CatalogPage,
  MediaAvailability,
  MediaItem,
  YouTubeCatalogError,
  YouTubeCatalogErrorKind,
  YouTubeCatalogPageRequest,
  YouTubeCatalogResult,
  YouTubeCatalogSearchOrder,
  YouTubeCatalogSearchRequest,
  YouTubeCatalogSettings,
  YouTubeCatalogStatus,
  YouTubeChannelDetail,
  YouTubeChannelItem,
  YouTubePlaylistDetail,
  YouTubePlaylistSummary,
} from "../../shared/types";

export const YOUTUBE_DATA_API_BASE = "https://www.googleapis.com/youtube/v3";
export const YOUTUBE_MUSIC_CATEGORY_ID = "10";

export const YOUTUBE_CATALOG_CACHE_TTLS = {
  searchMs: 15 * 60_1000,
  videoMs: 24 * 60 * 60_1000,
  detailMs: 24 * 60 * 60_1000,
  trendingMs: 6 * 60 * 60_1000,
} as const;

const SEARCH_CACHE_MAX = 40;
const VIDEO_CACHE_MAX = 300;
const DETAIL_CACHE_MAX = 120;
const REQUEST_TIMEOUT_MS = 15_000;

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const REGION_PATTERN = /^[A-Z]{2}$/;

type JsonRecord = Record<string, unknown>;

export interface YouTubeCatalogCoreOptions {
  getSettings: () => YouTubeCatalogSettings;
  fetchFn?: typeof fetch;
  now?: () => number;
  localeRegion?: () => string;
}

class CatalogFailure extends Error {
  constructor(
    readonly kind: YouTubeCatalogErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "CatalogFailure";
  }
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries: number) {}

  get(key: string, now: number): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh insertion order for a tiny LRU without retaining decoded artwork or responses.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return structuredClone(entry.value);
  }

  set(key: string, value: T, expiresAt: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value: structuredClone(value), expiresAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }

  clear(): number {
    const size = this.entries.size;
    this.entries.clear();
    return size;
  }

  prune(now: number): number {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    return this.entries.size;
  }
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : null;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeYouTubeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) {
      const code = Number.parseInt(lower.slice(2), 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    if (lower.startsWith("#")) {
      const code = Number.parseInt(lower.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
    return NAMED_ENTITIES[lower] ?? entity;
  });
}

/** Decode the small entity set YouTube returns in otherwise plain-text metadata. */
export function decodeYouTubeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return decodeYouTubeEntities(value).replace(/\s+/g, " ").trim();
}

function descriptionText(value: unknown): string {
  if (typeof value !== "string") return "";
  // Descriptions keep paragraph breaks, unlike titles; still decode entities and bound the size
  // so an unusually long channel/playlist description cannot dominate memory or layout.
  return decodeYouTubeEntities(value.replace(/\r\n?/g, "\n"))
    .split("\n")
    .map(line => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 8_000);
}

/** Parse YouTube's ISO-8601 duration (`PT3M31S`, `P1DT2H3M`, …) into seconds. */
export function parseYouTubeDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value.trim());
  if (!match) return null;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const total = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  return total > 0 && Number.isFinite(total) ? total : null;
}

function thumbnailUrl(
  value: unknown,
  preference: readonly string[] = ["medium", "high", "standard", "maxres", "default"]
): string | null {
  const thumbnails = asRecord(value);
  if (!thumbnails) return null;
  for (const key of preference) {
    const url = stringValue(asRecord(thumbnails[key])?.url);
    if (url && /^https:\/\//i.test(url)) return url;
  }
  return null;
}

function validVideoId(value: unknown): string | null {
  return typeof value === "string" && VIDEO_ID_PATTERN.test(value) ? value : null;
}

function validChannelId(value: unknown): string | null {
  return typeof value === "string" && CHANNEL_ID_PATTERN.test(value) ? value : null;
}

function validPlaylistId(value: unknown): string | null {
  return typeof value === "string" && PLAYLIST_ID_PATTERN.test(value) ? value : null;
}

function clampMaxResults(value: number | undefined, fallback: number): number {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.min(50, Math.max(1, Math.floor(number))) : fallback;
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

function normalizeSearchOrder(
  value: YouTubeCatalogSearchOrder | undefined
): YouTubeCatalogSearchOrder {
  return value === "date" || value === "viewCount" || value === "rating" || value === "title"
    ? value
    : "relevance";
}

function hashSettingsIdentity(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function pageInfo(root: JsonRecord): { nextPageToken: string | null; totalResults: number | null } {
  const info = asRecord(root.pageInfo);
  return {
    nextPageToken: stringValue(root.nextPageToken),
    totalResults: numberValue(info?.totalResults),
  };
}

function listItems(root: JsonRecord): unknown[] {
  if (root.items === undefined) return [];
  if (!Array.isArray(root.items)) {
    throw new CatalogFailure("malformed", "YouTube returned a catalog response Cadence could not read.");
  }
  return root.items;
}

function availabilityFromVideo(snippet: JsonRecord | null, status: JsonRecord | null): MediaAvailability {
  const privacy = stringValue(status?.privacyStatus)?.toLowerCase();
  if (privacy && privacy !== "public") return "unavailable";
  if (status?.embeddable === false) return "not-embeddable";
  const live = stringValue(snippet?.liveBroadcastContent)?.toLowerCase();
  if (live === "live" || live === "upcoming") return "live";
  return status?.embeddable === true ? "ready" : "unknown";
}

/** Map one `videos.list` resource to Cadence's honest generic-YouTube media item. */
export function mapYouTubeVideoResource(value: unknown, fetchedAt = Date.now()): MediaItem | null {
  const resource = asRecord(value);
  const videoId = validVideoId(resource?.id);
  if (!resource || !videoId) return null;
  const snippet = asRecord(resource.snippet);
  const contentDetails = asRecord(resource.contentDetails);
  const status = asRecord(resource.status);
  const channelTitle = decodeYouTubeText(snippet?.channelTitle) || null;
  const artistLabel = normalizeYouTubeArtist(channelTitle) ?? channelTitle ?? "Unknown channel";

  return youtubeMediaItem({
    videoId,
    sourceKind: "youtube",
    title: decodeYouTubeText(snippet?.title) || "Untitled YouTube video",
    artistLabel,
    channelId: validChannelId(snippet?.channelId),
    channelTitle,
    durationSeconds: parseYouTubeDuration(contentDetails?.duration),
    artworkUrl: thumbnailUrl(snippet?.thumbnails),
    publishedAt: stringValue(snippet?.publishedAt),
    availability: availabilityFromVideo(snippet, status),
    fetchedAt,
  });
}

function mapChannelResource(value: unknown, fetchedAt: number): YouTubeChannelItem | null {
  const resource = asRecord(value);
  const id = validChannelId(resource?.id);
  if (!resource || !id) return null;
  const snippet = asRecord(resource.snippet);
  const contentDetails = asRecord(resource.contentDetails);
  const relatedPlaylists = asRecord(contentDetails?.relatedPlaylists);
  const statistics = asRecord(resource.statistics);
  return {
    id,
    title: decodeYouTubeText(snippet?.title) || "Untitled YouTube channel",
    handle: decodeYouTubeText(snippet?.customUrl) || null,
    description: descriptionText(snippet?.description),
    artworkUrl: thumbnailUrl(snippet?.thumbnails, ["high", "medium", "default"]),
    canonicalUrl: `https://www.youtube.com/channel/${id}`,
    uploadsPlaylistId: validPlaylistId(relatedPlaylists?.uploads),
    subscriberCount:
      statistics?.hiddenSubscriberCount === true ? null : numberValue(statistics?.subscriberCount),
    videoCount: numberValue(statistics?.videoCount),
    viewCount: numberValue(statistics?.viewCount),
    fetchedAt,
  };
}

function mapPlaylistResource(value: unknown, fetchedAt: number): YouTubePlaylistSummary | null {
  const resource = asRecord(value);
  const id = validPlaylistId(resource?.id);
  if (!resource || !id) return null;
  const snippet = asRecord(resource.snippet);
  const contentDetails = asRecord(resource.contentDetails);
  const channelTitle = decodeYouTubeText(snippet?.channelTitle) || null;
  const isAlbumCollection = isYouTubeMusicAlbumPlaylistId(id);
  return {
    id,
    title: decodeYouTubeText(snippet?.title) || "Untitled YouTube playlist",
    description: descriptionText(snippet?.description),
    channelId: validChannelId(snippet?.channelId),
    channelTitle,
    artistLabel: normalizeYouTubeArtist(channelTitle) ?? channelTitle,
    artworkUrl: thumbnailUrl(snippet?.thumbnails, ["high", "medium", "standard", "default"]),
    itemCount: numberValue(contentDetails?.itemCount),
    canonicalUrl: isAlbumCollection
      ? `https://music.youtube.com/playlist?list=${id}`
      : `https://www.youtube.com/playlist?list=${id}`,
    publishedAt: stringValue(snippet?.publishedAt),
    isAlbumCollection,
    fetchedAt,
  };
}

function fallbackPlaylistVideo(
  videoId: string,
  snippet: JsonRecord | null,
  fetchedAt: number
): MediaItem {
  const channelTitle = decodeYouTubeText(snippet?.videoOwnerChannelTitle ?? snippet?.channelTitle) || null;
  return youtubeMediaItem({
    videoId,
    title: decodeYouTubeText(snippet?.title) || "Unavailable YouTube video",
    artistLabel: normalizeYouTubeArtist(channelTitle) ?? channelTitle ?? "Unknown channel",
    channelId: validChannelId(snippet?.videoOwnerChannelId ?? snippet?.channelId),
    channelTitle,
    artworkUrl: thumbnailUrl(snippet?.thumbnails),
    publishedAt: stringValue(snippet?.publishedAt),
    availability: "unavailable",
    fetchedAt,
  });
}

export class YouTubeCatalogCore {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly limiter = new ConcurrencyLimiter(2);
  private readonly searchCache = new TtlCache<unknown>(SEARCH_CACHE_MAX);
  private readonly videoCache = new TtlCache<MediaItem>(VIDEO_CACHE_MAX);
  private readonly detailCache = new TtlCache<unknown>(DETAIL_CACHE_MAX);
  private settingsFingerprint = "";

  constructor(private readonly options: YouTubeCatalogCoreOptions) {
    this.fetchFn = options.fetchFn ?? ((...args) => runtimeFetch(...args));
    this.now = options.now ?? (() => Date.now());
  }

  status(): YouTubeCatalogStatus {
    const { settings, region } = this.settingsSnapshot(true);
    const now = this.now();
    return {
      enabled: settings.enabled,
      configured: settings.enabled && Boolean(settings.apiKey.trim()),
      region,
      cacheEntries:
        this.searchCache.prune(now) + this.videoCache.prune(now) + this.detailCache.prune(now),
    };
  }

  clearCache(): { cleared: number } {
    return {
      cleared: this.searchCache.clear() + this.videoCache.clear() + this.detailCache.clear(),
    };
  }

  async searchMusicVideos(
    request: YouTubeCatalogSearchRequest,
    signal?: AbortSignal
  ): Promise<YouTubeCatalogResult<CatalogPage<MediaItem>>> {
    return this.asResult(signal, async () => {
      const query = normalizeQuery(request.query);
      this.requireQuery(query);
      const maxResults = clampMaxResults(request.maxResults, 50);
      const order = normalizeSearchOrder(request.order);
      const { region } = this.requireSettings();
      const cacheKey = `search:video:${region}:${order}:${maxResults}:${request.pageToken ?? ""}:${query.toLowerCase()}`;
      const cached = this.searchCache.get(cacheKey, this.now()) as CatalogPage<MediaItem> | undefined;
      if (cached) return { ...cached, cached: true };

      const root = await this.requestJson(
        "search",
        {
          part: "snippet",
          type: "video",
          q: query,
          maxResults,
          order,
          videoCategoryId: YOUTUBE_MUSIC_CATEGORY_ID,
          videoEmbeddable: "true",
          regionCode: region,
          pageToken: request.pageToken ?? undefined,
        },
        signal
      );
      const ids = listItems(root)
        .map(item => validVideoId(asRecord(asRecord(item)?.id)?.videoId))
        .filter((id): id is string => Boolean(id));
      const fetchedAt = this.now();
      const items = await this.fetchVideos(ids, signal);
      const page: CatalogPage<MediaItem> = {
        items,
        ...pageInfo(root),
        cached: false,
        fetchedAt,
      };
      this.searchCache.set(cacheKey, page, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.searchMs);
      return page;
    });
  }

  async searchChannels(
    request: YouTubeCatalogSearchRequest,
    signal?: AbortSignal
  ): Promise<YouTubeCatalogResult<CatalogPage<YouTubeChannelItem>>> {
    return this.asResult(signal, async () => {
      const query = normalizeQuery(request.query);
      this.requireQuery(query);
      const maxResults = clampMaxResults(request.maxResults, 50);
      const order = normalizeSearchOrder(request.order);
      const { region } = this.requireSettings();
      const cacheKey = `search:channel:${region}:${order}:${maxResults}:${request.pageToken ?? ""}:${query.toLowerCase()}`;
      const cached = this.searchCache.get(cacheKey, this.now()) as
        | CatalogPage<YouTubeChannelItem>
        | undefined;
      if (cached) return { ...cached, cached: true };

      const root = await this.requestJson(
        "search",
        {
          part: "snippet",
          type: "channel",
          q: query,
          maxResults,
          order,
          regionCode: region,
          pageToken: request.pageToken ?? undefined,
        },
        signal
      );
      const rawItems = listItems(root);
      const ids = rawItems
        .map(item => validChannelId(asRecord(asRecord(item)?.id)?.channelId))
        .filter((id): id is string => Boolean(id));
      const fetchedAt = this.now();
      let byId = new Map<string, YouTubeChannelItem>();
      if (ids.length > 0) {
        const channelsRoot = await this.requestJson(
          "channels",
          { part: "snippet,contentDetails,statistics", id: ids.join(","), maxResults: ids.length },
          signal
        );
        byId = new Map(
          listItems(channelsRoot)
            .map(item => mapChannelResource(item, fetchedAt))
            .filter((item): item is YouTubeChannelItem => Boolean(item))
            .map(item => [item.id, item])
        );
      }
      const fallbackById = new Map<string, YouTubeChannelItem>();
      for (const raw of rawItems) {
        const record = asRecord(raw);
        const id = validChannelId(asRecord(record?.id)?.channelId);
        if (!id) continue;
        const snippet = asRecord(record?.snippet);
        fallbackById.set(id, {
          id,
          title: decodeYouTubeText(snippet?.title ?? snippet?.channelTitle) || "Untitled YouTube channel",
          handle: decodeYouTubeText(snippet?.customUrl) || null,
          description: descriptionText(snippet?.description),
          artworkUrl: thumbnailUrl(snippet?.thumbnails, ["high", "medium", "default"]),
          canonicalUrl: `https://www.youtube.com/channel/${id}`,
          uploadsPlaylistId: null,
          fetchedAt,
        });
      }
      const page: CatalogPage<YouTubeChannelItem> = {
        items: ids
          .map(id => byId.get(id) ?? fallbackById.get(id))
          .filter((item): item is YouTubeChannelItem => Boolean(item)),
        ...pageInfo(root),
        cached: false,
        fetchedAt,
      };
      this.searchCache.set(cacheKey, page, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.searchMs);
      return page;
    });
  }

  async searchPlaylists(
    request: YouTubeCatalogSearchRequest,
    signal?: AbortSignal
  ): Promise<YouTubeCatalogResult<CatalogPage<YouTubePlaylistSummary>>> {
    return this.asResult(signal, async () => {
      const query = normalizeQuery(request.query);
      this.requireQuery(query);
      const maxResults = clampMaxResults(request.maxResults, 50);
      const order = normalizeSearchOrder(request.order);
      const { region } = this.requireSettings();
      const cacheKey = `search:playlist:${region}:${order}:${maxResults}:${request.pageToken ?? ""}:${query.toLowerCase()}`;
      const cached = this.searchCache.get(cacheKey, this.now()) as
        | CatalogPage<YouTubePlaylistSummary>
        | undefined;
      if (cached) return { ...cached, cached: true };

      const root = await this.requestJson(
        "search",
        {
          part: "snippet",
          type: "playlist",
          q: query,
          maxResults,
          order,
          regionCode: region,
          pageToken: request.pageToken ?? undefined,
        },
        signal
      );
      const rawItems = listItems(root);
      const ids = rawItems
        .map(item => validPlaylistId(asRecord(asRecord(item)?.id)?.playlistId))
        .filter((id): id is string => Boolean(id));
      const fetchedAt = this.now();
      let byId = new Map<string, YouTubePlaylistSummary>();
      if (ids.length > 0) {
        const playlistsRoot = await this.requestJson(
          "playlists",
          { part: "snippet,contentDetails,status", id: ids.join(","), maxResults: ids.length },
          signal
        );
        byId = new Map(
          listItems(playlistsRoot)
            .map(item => mapPlaylistResource(item, fetchedAt))
            .filter((item): item is YouTubePlaylistSummary => Boolean(item))
            .map(item => [item.id, item])
        );
      }
      const fallbackById = new Map<string, YouTubePlaylistSummary>();
      for (const raw of rawItems) {
        const record = asRecord(raw);
        const id = validPlaylistId(asRecord(record?.id)?.playlistId);
        if (!id) continue;
        const snippet = asRecord(record?.snippet);
        const channelTitle = decodeYouTubeText(snippet?.channelTitle) || null;
        const isAlbumCollection = isYouTubeMusicAlbumPlaylistId(id);
        fallbackById.set(id, {
          id,
          title: decodeYouTubeText(snippet?.title) || "Untitled YouTube playlist",
          description: descriptionText(snippet?.description),
          channelId: validChannelId(snippet?.channelId),
          channelTitle,
          artistLabel: normalizeYouTubeArtist(channelTitle) ?? channelTitle,
          artworkUrl: thumbnailUrl(snippet?.thumbnails, ["high", "medium", "default"]),
          itemCount: null,
          canonicalUrl: isAlbumCollection
            ? `https://music.youtube.com/playlist?list=${id}`
            : `https://www.youtube.com/playlist?list=${id}`,
          publishedAt: stringValue(snippet?.publishedAt),
          isAlbumCollection,
          fetchedAt,
        });
      }
      const page: CatalogPage<YouTubePlaylistSummary> = {
        items: ids
          .map(id => byId.get(id) ?? fallbackById.get(id))
          .filter((item): item is YouTubePlaylistSummary => Boolean(item)),
        ...pageInfo(root),
        cached: false,
        fetchedAt,
      };
      this.searchCache.set(cacheKey, page, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.searchMs);
      return page;
    });
  }

  /**
   * Finds verified YouTube Music album collections within ordinary playlist search results.
   * The Data API has no album endpoint, so this method scans at most three playlist-search
   * pages per user action and only accepts the explicit `OLAK5uy…` album-playlist namespace.
   * The returned token points at the first unscanned raw search page.
   */
  async searchAlbumCollections(
    request: YouTubeCatalogSearchRequest,
    signal?: AbortSignal
  ): Promise<YouTubeCatalogResult<CatalogPage<YouTubePlaylistSummary>>> {
    const maxResults = clampMaxResults(request.maxResults, 50);
    const items: YouTubePlaylistSummary[] = [];
    let pageToken = request.pageToken ?? null;
    let fetchedAt = this.now();
    let cached = true;

    for (let scannedPages = 0; scannedPages < 3 && items.length < maxResults; scannedPages += 1) {
      const result = await this.searchPlaylists(
        {
          query: request.query,
          pageToken,
          maxResults: 50,
          order: normalizeSearchOrder(request.order),
        },
        signal
      );
      if (!result.ok) return result;
      fetchedAt = result.data.fetchedAt;
      cached = cached && result.data.cached;
      items.push(
        ...result.data.items.filter(
          item => item.isAlbumCollection || isYouTubeMusicAlbumPlaylistId(item.id)
        )
      );
      pageToken = result.data.nextPageToken;
      if (!pageToken) break;
    }

    return {
      ok: true,
      data: {
        items: items.slice(0, maxResults),
        nextPageToken: pageToken,
        totalResults: null,
        cached,
        fetchedAt,
      },
    };
  }

  async trending(
    request: YouTubeCatalogPageRequest = {},
    signal?: AbortSignal
  ): Promise<YouTubeCatalogResult<CatalogPage<MediaItem>>> {
    return this.asResult(signal, async () => {
      const maxResults = clampMaxResults(request.maxResults, 50);
      const { region } = this.requireSettings();
      const cacheKey = `trending:${region}:${maxResults}:${request.pageToken ?? ""}`;
      const cached = this.detailCache.get(cacheKey, this.now()) as CatalogPage<MediaItem> | undefined;
      if (cached) return { ...cached, cached: true };

      const root = await this.requestJson(
        "videos",
        {
          part: "snippet,contentDetails,status",
          chart: "mostPopular",
          regionCode: region,
          videoCategoryId: YOUTUBE_MUSIC_CATEGORY_ID,
          maxResults,
          pageToken: request.pageToken ?? undefined,
        },
        signal
      );
      const fetchedAt = this.now();
      const items = listItems(root)
        .map(item => mapYouTubeVideoResource(item, fetchedAt))
        .filter((item): item is MediaItem => Boolean(item));
      for (const item of items) {
        if (item.source.kind !== "local") {
          this.videoCache.set(item.source.remoteId, item, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.videoMs);
        }
      }
      const page: CatalogPage<MediaItem> = {
        items,
        ...pageInfo(root),
        cached: false,
        fetchedAt,
      };
      this.detailCache.set(cacheKey, page, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.trendingMs);
      return page;
    });
  }

  /**
   * Recent embeddable Music-category uploads. This intentionally uses `search.list`, whose
   * separate 100-calls/day project bucket makes it an explicit user-loaded discovery shelf,
   * not a background home refresh.
   */
  async newReleases(
    request: YouTubeCatalogPageRequest = {},
    signal?: AbortSignal
  ): Promise<YouTubeCatalogResult<CatalogPage<MediaItem>>> {
    return this.asResult(signal, async () => {
      const maxResults = clampMaxResults(request.maxResults, 50);
      const { region } = this.requireSettings();
      const cacheKey = `new-releases:${region}:${maxResults}:${request.pageToken ?? ""}`;
      const cached = this.searchCache.get(cacheKey, this.now()) as CatalogPage<MediaItem> | undefined;
      if (cached) return { ...cached, cached: true };

      const publishedAfter = new Date(this.now() - 30 * 24 * 60 * 60_1000).toISOString();
      const root = await this.requestJson(
        "search",
        {
          part: "snippet",
          type: "video",
          maxResults,
          order: "date",
          videoCategoryId: YOUTUBE_MUSIC_CATEGORY_ID,
          videoEmbeddable: "true",
          publishedAfter,
          regionCode: region,
          pageToken: request.pageToken ?? undefined,
        },
        signal
      );
      const ids = listItems(root)
        .map(item => validVideoId(asRecord(asRecord(item)?.id)?.videoId))
        .filter((id): id is string => Boolean(id));
      const fetchedAt = this.now();
      const page: CatalogPage<MediaItem> = {
        items: await this.fetchVideos(ids, signal),
        ...pageInfo(root),
        cached: false,
        fetchedAt,
      };
      this.searchCache.set(cacheKey, page, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.searchMs);
      return page;
    });
  }

  async getChannel(
    request: { channelId: string },
    signal?: AbortSignal
  ): Promise<YouTubeCatalogResult<YouTubeChannelDetail>> {
    return this.asResult(signal, async () => {
      const channelId = validChannelId(request.channelId.trim());
      if (!channelId) {
        throw new CatalogFailure("malformed", "That YouTube channel link does not contain a valid channel ID.");
      }
      this.requireSettings();
      const cacheKey = `channel:${channelId}`;
      const cached = this.detailCache.get(cacheKey, this.now()) as YouTubeChannelDetail | undefined;
      if (cached) return { ...cached, cached: true, uploads: { ...cached.uploads, cached: true } };

      const fetchedAt = this.now();
      const root = await this.requestJson(
        "channels",
        { part: "snippet,contentDetails,statistics", id: channelId, maxResults: 1 },
        signal
      );
      const channel = listItems(root)
        .map(item => mapChannelResource(item, fetchedAt))
        .find((item): item is YouTubeChannelItem => Boolean(item));
      if (!channel) {
        throw new CatalogFailure("not-found", "That public YouTube channel could not be found.", 404);
      }

      const playlistsRoot = await this.requestJson(
        "playlists",
        { part: "snippet,contentDetails,status", channelId, maxResults: 50 },
        signal
      );
      const playlists = listItems(playlistsRoot)
        .map(item => mapPlaylistResource(item, fetchedAt))
        .filter((item): item is YouTubePlaylistSummary => Boolean(item));

      const uploads = channel.uploadsPlaylistId
        ? await this.fetchPlaylistItems(channel.uploadsPlaylistId, null, 50, signal)
        : ({
            items: [],
            nextPageToken: null,
            totalResults: 0,
            cached: false,
            fetchedAt,
          } satisfies CatalogPage<MediaItem>);

      const detail: YouTubeChannelDetail = {
        channel,
        playlists,
        playlistsNextPageToken: pageInfo(playlistsRoot).nextPageToken,
        uploads,
        cached: false,
        fetchedAt,
      };
      this.detailCache.set(cacheKey, detail, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.detailMs);
      return detail;
    });
  }

  async getChannelPlaylists(
    request: { channelId: string; pageToken?: string | null; maxResults?: number },
    signal?: AbortSignal
  ): Promise<YouTubeCatalogResult<CatalogPage<YouTubePlaylistSummary>>> {
    return this.asResult(signal, async () => {
      const channelId = validChannelId(request.channelId.trim());
      if (!channelId) {
        throw new CatalogFailure("malformed", "That YouTube channel link does not contain a valid channel ID.");
      }
      this.requireSettings();
      const maxResults = clampMaxResults(request.maxResults, 50);
      const cacheKey = `channel-playlists:${channelId}:${maxResults}:${request.pageToken ?? ""}`;
      const cached = this.detailCache.get(cacheKey, this.now()) as
        | CatalogPage<YouTubePlaylistSummary>
        | undefined;
      if (cached) return { ...cached, cached: true };

      const root = await this.requestJson(
        "playlists",
        {
          part: "snippet,contentDetails,status",
          channelId,
          maxResults,
          pageToken: request.pageToken ?? undefined,
        },
        signal
      );
      const fetchedAt = this.now();
      const page: CatalogPage<YouTubePlaylistSummary> = {
        items: listItems(root)
          .map(item => mapPlaylistResource(item, fetchedAt))
          .filter((item): item is YouTubePlaylistSummary => Boolean(item)),
        ...pageInfo(root),
        cached: false,
        fetchedAt,
      };
      this.detailCache.set(cacheKey, page, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.detailMs);
      return page;
    });
  }

  async getChannelVideos(
    request: {
      channelId: string;
      pageToken?: string | null;
      maxResults?: number;
      order?: YouTubeCatalogSearchOrder;
    },
    signal?: AbortSignal
  ): Promise<YouTubeCatalogResult<CatalogPage<MediaItem>>> {
    return this.asResult(signal, async () => {
      const channelId = validChannelId(request.channelId.trim());
      if (!channelId) {
        throw new CatalogFailure("malformed", "That YouTube channel link does not contain a valid channel ID.");
      }
      this.requireSettings();
      const maxResults = clampMaxResults(request.maxResults, 50);
      const order = normalizeSearchOrder(request.order);

      // Latest uploads use the channel's documented uploads playlist: complete, ordered and
      // only one quota unit per page. Popular/rating/title ordering has no playlist equivalent,
      // so those explicit modes use channel-scoped search and inherit its search-call quota.
      if (order === "date" || order === "relevance") {
        const uploadsCacheKey = `channel-uploads-playlist:${channelId}`;
        let uploadsPlaylistId = this.detailCache.get(uploadsCacheKey, this.now()) as
          | string
          | undefined;
        if (!uploadsPlaylistId) {
          const root = await this.requestJson(
            "channels",
            { part: "contentDetails", id: channelId, maxResults: 1 },
            signal
          );
          const channel = listItems(root)
            .map(item => mapChannelResource(item, this.now()))
            .find((item): item is YouTubeChannelItem => Boolean(item));
          uploadsPlaylistId = channel?.uploadsPlaylistId ?? undefined;
          if (!uploadsPlaylistId) {
            throw new CatalogFailure("not-found", "That public YouTube channel has no uploads playlist.", 404);
          }
          this.detailCache.set(
            uploadsCacheKey,
            uploadsPlaylistId,
            this.now() + YOUTUBE_CATALOG_CACHE_TTLS.detailMs
          );
        }
        return this.fetchPlaylistItems(
          uploadsPlaylistId,
          request.pageToken ?? null,
          maxResults,
          signal
        );
      }

      const cacheKey = `channel-videos:${channelId}:${order}:${maxResults}:${request.pageToken ?? ""}`;
      const cached = this.searchCache.get(cacheKey, this.now()) as CatalogPage<MediaItem> | undefined;
      if (cached) return { ...cached, cached: true };
      const root = await this.requestJson(
        "search",
        {
          part: "snippet",
          channelId,
          type: "video",
          maxResults,
          order,
          videoEmbeddable: "true",
          pageToken: request.pageToken ?? undefined,
        },
        signal
      );
      const ids = listItems(root)
        .map(item => validVideoId(asRecord(asRecord(item)?.id)?.videoId))
        .filter((id): id is string => Boolean(id));
      const fetchedAt = this.now();
      const page: CatalogPage<MediaItem> = {
        items: await this.fetchVideos(ids, signal),
        ...pageInfo(root),
        cached: false,
        fetchedAt,
      };
      this.searchCache.set(cacheKey, page, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.searchMs);
      return page;
    });
  }

  async getPlaylist(
    request: { playlistId: string },
    signal?: AbortSignal
  ): Promise<YouTubeCatalogResult<YouTubePlaylistDetail>> {
    return this.asResult(signal, async () => {
      const playlistId = validPlaylistId(request.playlistId.trim());
      if (!playlistId) {
        throw new CatalogFailure("malformed", "That YouTube playlist link does not contain a valid playlist ID.");
      }
      this.requireSettings();
      const cacheKey = `playlist:${playlistId}`;
      const cached = this.detailCache.get(cacheKey, this.now()) as YouTubePlaylistDetail | undefined;
      if (cached) return { ...cached, cached: true };

      const fetchedAt = this.now();
      const root = await this.requestJson(
        "playlists",
        { part: "snippet,contentDetails,status", id: playlistId, maxResults: 1 },
        signal
      );
      const playlist = listItems(root)
        .map(item => mapPlaylistResource(item, fetchedAt))
        .find((item): item is YouTubePlaylistSummary => Boolean(item));
      if (!playlist) {
        throw new CatalogFailure(
          "not-found",
          "That public YouTube playlist could not be found. Private playlists require an account and are not supported.",
          404
        );
      }
      const detail: YouTubePlaylistDetail = { playlist, cached: false, fetchedAt };
      this.detailCache.set(cacheKey, detail, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.detailMs);
      return detail;
    });
  }

  async getPlaylistItems(
    request: { playlistId: string; pageToken?: string | null; maxResults?: number },
    signal?: AbortSignal
  ): Promise<YouTubeCatalogResult<CatalogPage<MediaItem>>> {
    return this.asResult(signal, async () => {
      const playlistId = validPlaylistId(request.playlistId.trim());
      if (!playlistId) {
        throw new CatalogFailure("malformed", "That YouTube playlist link does not contain a valid playlist ID.");
      }
      this.requireSettings();
      return this.fetchPlaylistItems(
        playlistId,
        request.pageToken ?? null,
        clampMaxResults(request.maxResults, 50),
        signal
      );
    });
  }

  private async fetchPlaylistItems(
    playlistId: string,
    pageToken: string | null,
    maxResults: number,
    signal?: AbortSignal
  ): Promise<CatalogPage<MediaItem>> {
    const cacheKey = `playlist-items:${playlistId}:${maxResults}:${pageToken ?? ""}`;
    const cached = this.detailCache.get(cacheKey, this.now()) as CatalogPage<MediaItem> | undefined;
    if (cached) return { ...cached, cached: true };

    const root = await this.requestJson(
      "playlistItems",
      {
        part: "snippet,contentDetails,status",
        playlistId,
        maxResults,
        pageToken: pageToken ?? undefined,
      },
      signal
    );
    const fetchedAt = this.now();
    const entries: { videoId: string; snippet: JsonRecord | null }[] = [];
    for (const raw of listItems(root)) {
      const record = asRecord(raw);
      const snippet = asRecord(record?.snippet);
      const resourceId = asRecord(snippet?.resourceId);
      const contentDetails = asRecord(record?.contentDetails);
      const videoId = validVideoId(resourceId?.videoId ?? contentDetails?.videoId);
      if (videoId) entries.push({ videoId, snippet });
    }
    const videos = await this.fetchVideos(
      entries.map(entry => entry.videoId),
      signal
    );
    const byId = new Map(
      videos
        .filter(item => item.source.kind !== "local")
        .map(item => [(item.source as Extract<MediaItem["source"], { remoteId: string }>).remoteId, item])
    );
    let items = entries.map(
      entry => byId.get(entry.videoId) ?? fallbackPlaylistVideo(entry.videoId, entry.snippet, fetchedAt)
    );
    if (isYouTubeMusicAlbumPlaylistId(playlistId)) {
      const playlistResult = await this.getPlaylist({ playlistId }, signal);
      const albumTitle = playlistResult.ok ? playlistResult.data.playlist.title : null;
      items = items.map(item => {
        if (item.source.kind === "local") return item;
        const remoteId = item.source.remoteId;
        return {
          ...item,
          source: {
            kind: "youtube-music" as const,
            remoteId,
            canonicalUrl: `https://music.youtube.com/watch?v=${encodeURIComponent(remoteId)}`,
          },
          albumLabel: albumTitle ?? item.albumLabel,
        };
      });
    }
    const page: CatalogPage<MediaItem> = {
      items,
      ...pageInfo(root),
      cached: false,
      fetchedAt,
    };
    this.detailCache.set(cacheKey, page, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.detailMs);
    return page;
  }

  private async fetchVideos(videoIds: readonly string[], signal?: AbortSignal): Promise<MediaItem[]> {
    const uniqueIds = [...new Set(videoIds.filter(id => VIDEO_ID_PATTERN.test(id)))];
    if (uniqueIds.length === 0) return [];
    const now = this.now();
    const byId = new Map<string, MediaItem>();
    const missing: string[] = [];
    for (const id of uniqueIds) {
      const cached = this.videoCache.get(id, now);
      if (cached) byId.set(id, cached);
      else missing.push(id);
    }

    for (let offset = 0; offset < missing.length; offset += 50) {
      const chunk = missing.slice(offset, offset + 50);
      const root = await this.requestJson(
        "videos",
        { part: "snippet,contentDetails,status", id: chunk.join(","), maxResults: chunk.length },
        signal
      );
      const fetchedAt = this.now();
      for (const raw of listItems(root)) {
        const item = mapYouTubeVideoResource(raw, fetchedAt);
        if (!item || item.source.kind === "local") continue;
        byId.set(item.source.remoteId, item);
        this.videoCache.set(item.source.remoteId, item, fetchedAt + YOUTUBE_CATALOG_CACHE_TTLS.videoMs);
      }
    }

    return videoIds
      .map(id => byId.get(id))
      .filter((item): item is MediaItem => Boolean(item));
  }

  private requireQuery(query: string): void {
    if (query.length < 2) {
      throw new CatalogFailure("malformed", "Enter at least two characters to search YouTube.");
    }
    if (query.length > 200) {
      throw new CatalogFailure("malformed", "That YouTube search is too long.");
    }
  }

  private settingsSnapshot(clearOnIdentityChange = true): {
    settings: YouTubeCatalogSettings;
    region: string;
  } {
    const settings = this.options.getSettings();
    const fingerprint = hashSettingsIdentity(
      `${settings.enabled ? "1" : "0"}\u0000${settings.region}\u0000${settings.apiKey}`
    );
    if (fingerprint !== this.settingsFingerprint) {
      this.settingsFingerprint = fingerprint;
      if (clearOnIdentityChange) this.clearCache();
    }
    const configuredRegion = settings.region.trim().toUpperCase();
    if (REGION_PATTERN.test(configuredRegion)) return { settings, region: configuredRegion };

    let localeRegion = "";
    try {
      localeRegion = this.options.localeRegion?.() ?? Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      localeRegion = "";
    }
    const match = /[-_]([A-Za-z]{2})(?:[-_]|$)/.exec(localeRegion);
    return { settings, region: match ? match[1].toUpperCase() : "US" };
  }

  private requireSettings(): { settings: YouTubeCatalogSettings; region: string } {
    const snapshot = this.settingsSnapshot(true);
    if (!snapshot.settings.enabled) {
      throw new CatalogFailure(
        "disabled",
        "The YouTube catalog is off. Turn it on in Settings → Library."
      );
    }
    if (!snapshot.settings.apiKey.trim()) {
      throw new CatalogFailure(
        "missing-key",
        "Add your YouTube Data API v3 key in Settings → Library to use the public catalog."
      );
    }
    return snapshot;
  }

  private async requestJson(
    endpoint: string,
    params: Record<string, string | number | undefined>,
    signal?: AbortSignal
  ): Promise<JsonRecord> {
    const { settings } = this.requireSettings();
    if (signal?.aborted) throw new CatalogFailure("aborted", "The YouTube catalog request was cancelled.");

    const url = new URL(`${YOUTUBE_DATA_API_BASE}/${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    url.searchParams.set("key", settings.apiKey.trim());

    return this.limiter.run(async () => {
      if (signal?.aborted) {
        throw new CatalogFailure("aborted", "The YouTube catalog request was cancelled.");
      }
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.fetchFn(url.toString(), {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": CLIENT_NAME,
          },
          signal: combined,
        });
      } catch (error) {
        if (signal?.aborted) {
          throw new CatalogFailure("aborted", "The YouTube catalog request was cancelled.");
        }
        if (timeout.aborted || (error as Error)?.name === "TimeoutError") {
          throw new CatalogFailure("timeout", "YouTube took too long to answer. Please try again.");
        }
        throw new CatalogFailure(
          "offline",
          "Cadence could not reach the YouTube Data API. Check the connection and try again."
        );
      }

      const text = await response.text().catch(() => "");
      let json: unknown = null;
      if (text.trim()) {
        try {
          json = JSON.parse(text);
        } catch {
          if (response.ok) {
            throw new CatalogFailure(
              "malformed",
              "YouTube returned a catalog response Cadence could not read.",
              response.status
            );
          }
        }
      }
      if (!response.ok) throw this.mapHttpFailure(response.status, json, settings.apiKey);
      const root = asRecord(json);
      if (!root) {
        throw new CatalogFailure(
          "malformed",
          "YouTube returned a catalog response Cadence could not read.",
          response.status
        );
      }
      return root;
    });
  }

  private mapHttpFailure(status: number, json: unknown, apiKey: string): CatalogFailure {
    const root = asRecord(json);
    const error = asRecord(root?.error);
    const first = asRecord(asArray(error?.errors)[0]);
    const reason = stringValue(first?.reason) ?? "";
    const errorStatus = stringValue(error?.status) ?? "";
    const rawMessage = stringValue(error?.message) ?? stringValue(first?.message) ?? "";
    const searchable = `${reason} ${errorStatus} ${rawMessage}`.toLowerCase();
    const safeMessage = rawMessage
      ? rawMessage.split(apiKey).join("[API key]").replace(/https?:\/\/\S+/g, "[URL]").slice(0, 240)
      : "";

    if (
      searchable.includes("keyinvalid") ||
      searchable.includes("api_key_invalid") ||
      searchable.includes("api key not valid") ||
      searchable.includes("invalid api key")
    ) {
      return new CatalogFailure(
        "invalid-key",
        "Google rejected that API key. Check it in Settings → Library.",
        status
      );
    }
    if (
      searchable.includes("accessnotconfigured") ||
      searchable.includes("has not been used") ||
      searchable.includes("is disabled") ||
      searchable.includes("api not enabled")
    ) {
      return new CatalogFailure(
        "api-not-enabled",
        "Enable YouTube Data API v3 for the Google Cloud project that owns this key.",
        status
      );
    }
    if (searchable.includes("quota") || searchable.includes("dailylimit")) {
      return new CatalogFailure(
        "quota-exceeded",
        "This API key has reached its YouTube Data API quota. Local music is unaffected.",
        status
      );
    }
    if (status === 429 || searchable.includes("ratelimit") || searchable.includes("userratelimit")) {
      return new CatalogFailure(
        "rate-limited",
        "YouTube is rate-limiting this API key. Wait a moment and try again.",
        status
      );
    }
    if (status === 404) {
      return new CatalogFailure("not-found", "That public YouTube item could not be found.", status);
    }
    if (status === 401 || status === 403) {
      return new CatalogFailure(
        "forbidden",
        safeMessage || "Google refused that YouTube Data API request for this key.",
        status
      );
    }
    if (status >= 500) {
      return new CatalogFailure(
        "server",
        "YouTube's catalog service returned a server error. Please try again later.",
        status
      );
    }
    if (status === 400) {
      return new CatalogFailure(
        "malformed",
        safeMessage || "YouTube rejected that catalog request.",
        status
      );
    }
    return new CatalogFailure(
      "unavailable",
      safeMessage || `YouTube's catalog request failed with HTTP ${status}.`,
      status
    );
  }

  private async asResult<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>
  ): Promise<YouTubeCatalogResult<T>> {
    try {
      return { ok: true, data: await operation() };
    } catch (error) {
      if (error instanceof CatalogFailure) {
        const failure: YouTubeCatalogError = {
          kind: error.kind,
          message: error.message,
          status: error.status,
        };
        return { ok: false, error: failure };
      }
      if (signal?.aborted || (error as Error)?.name === "AbortError") {
        return {
          ok: false,
          error: { kind: "aborted", message: "The YouTube catalog request was cancelled." },
        };
      }
      return {
        ok: false,
        error: {
          kind: "unavailable",
          message: "The YouTube catalog is unavailable right now. Local music is unaffected.",
        },
      };
    }
  }
}
