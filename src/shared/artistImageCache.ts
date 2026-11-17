/**
 * Persistent artist profile-picture cache for Cadence.
 *
 * One entry per artist *identity*, independent of any track or album, stored in a small JSON index
 * (`artist-images.json`, written through the same `cmd_write_user_json` path as the lyrics caches)
 * next to the existing artwork directory where the picture bytes themselves live under their
 * content hash. That deliberately avoids a second database: the library database keeps tracks,
 * playlists, history and intelligence, while this is reclaimable cache data with its own lifecycle.
 *
 * Rules this module enforces:
 *  - a verified picture is never replaced by a lower-confidence result (`shouldReplaceImage`);
 *  - "no picture found" is remembered for a bounded period so a large library does not re-query
 *    every provider for every artist on every launch;
 *  - the index is capped and evicts the least recently used artists;
 *  - a corrupt or hand-edited file degrades to an empty cache instead of throwing.
 */

import { isValidMusicBrainzId, type ArtistImageProviderId } from "./artistImageProviders";

export const ARTIST_IMAGE_CACHE_VERSION = 1;

/** How long a successful picture is considered fresh before a view may refresh it in the background. */
export const DEFAULT_ARTIST_IMAGE_REFRESH_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** How long a definite "no picture" answer is trusted before providers are asked again. */
export const DEFAULT_ARTIST_IMAGE_MISS_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/** Shorter retry window for transient failures (timeouts, 5xx, rate limits). */
export const DEFAULT_ARTIST_IMAGE_ERROR_TTL_MS = 6 * 60 * 60 * 1000;

export const MAX_ARTIST_IMAGE_ENTRIES = 4000;

export interface ArtistImageFileRecord {
  /** Cache key: normalized artist name (`name:<normalized>`). */
  artistKey: string;
  artistName: string;
  mbid: string | null;
  /** File name inside the artwork directory; the bytes are content-addressed. */
  fileName: string;
  provider: ArtistImageProviderId;
  /** Original remote image URL, kept for diagnostics and re-download after eviction. */
  sourceUrl: string | null;
  /** Attribution page (Commons file page, Last.fm/Deezer artist page). */
  pageUrl: string | null;
  attribution: string | null;
  license: string | null;
  licenseUrl: string | null;
  author: string | null;
  width: number;
  height: number;
  /** 0..1 confidence of the stored result, used to refuse downgrades. */
  confidence: number;
  savedAt: number;
  verifiedAt: number;
  lastAccessAt: number;
}

export interface ArtistImageMissRecord {
  artistKey: string;
  artistName: string;
  /** Stable reason (`no-image`, `all-providers-failed`, `artist-name-mismatch`, …). */
  reason: string;
  /** Provider ids already asked, in priority order. */
  attempted: string[];
  failedAt: number;
  /** Epoch ms after which a new attempt is allowed. */
  retryAfter: number;
}

interface CacheFile {
  version: number;
  artists: Record<string, ArtistImageFileRecord>;
  misses: Record<string, ArtistImageMissRecord>;
}

export interface ArtistImageCachePersistence {
  initialJson?: string | null;
  persist?: (json: string) => void | Promise<void>;
  now?: () => number;
}

export interface ArtistImageCacheStats {
  /** Cached pictures. */
  artists: number;
  /** Artists remembered as having no usable picture. */
  misses: number;
  /** Serialized index size in bytes, as written to disk. */
  bytes: number;
}

export interface ArtistImageCacheLookup {
  record: ArtistImageFileRecord;
  /** True when the picture is older than the refresh window but still perfectly displayable. */
  stale: boolean;
}

export interface StoreDecision {
  stored: boolean;
  reason: "stored" | "kept-higher-confidence" | "kept-newer" | "invalid";
}

/** Cache key for an artist name. Names are normalized so tag casing/punctuation cannot split entries. */
export function artistImageKey(artistName: string): string {
  const normalized = artistName
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `name:${normalized}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStoredImage(value: unknown): ArtistImageFileRecord | null {
  if (!isRecord(value)) return null;
  const artistKey = text(value.artistKey);
  const artistName = text(value.artistName);
  const fileName = text(value.fileName);
  const provider = text(value.provider);
  if (!artistKey || !artistName || !fileName || !provider) return null;
  // Only a bare file name is accepted: the artwork directory is content-addressed, and a path from
  // a hand-edited index must never be able to point outside it.
  if (fileName.includes("/") || fileName.includes("\\") || fileName.includes("..")) return null;
  const mbid = text(value.mbid);
  return {
    artistKey,
    artistName,
    mbid: mbid && isValidMusicBrainzId(mbid) ? mbid : null,
    fileName,
    provider: provider as ArtistImageProviderId,
    sourceUrl: text(value.sourceUrl),
    pageUrl: text(value.pageUrl),
    attribution: text(value.attribution),
    license: text(value.license),
    licenseUrl: text(value.licenseUrl),
    author: text(value.author),
    width: Math.max(0, Math.round(finiteNumber(value.width, 0))),
    height: Math.max(0, Math.round(finiteNumber(value.height, 0))),
    confidence: Math.min(1, Math.max(0, finiteNumber(value.confidence, 0))),
    savedAt: Math.round(finiteNumber(value.savedAt, 0)),
    verifiedAt: Math.round(finiteNumber(value.verifiedAt, finiteNumber(value.savedAt, 0))),
    lastAccessAt: Math.round(finiteNumber(value.lastAccessAt, finiteNumber(value.savedAt, 0))),
  };
}

function normalizeStoredMiss(value: unknown): ArtistImageMissRecord | null {
  if (!isRecord(value)) return null;
  const artistKey = text(value.artistKey);
  const artistName = text(value.artistName);
  if (!artistKey || !artistName) return null;
  return {
    artistKey,
    artistName,
    reason: text(value.reason) ?? "unavailable",
    attempted: Array.isArray(value.attempted)
      ? value.attempted.filter((entry): entry is string => typeof entry === "string")
      : [],
    failedAt: Math.round(finiteNumber(value.failedAt, 0)),
    retryAfter: Math.round(finiteNumber(value.retryAfter, 0)),
  };
}

/**
 * Decides whether an incoming result may replace what is already cached. A verified image is only
 * replaced by a *more confident* one (or by a same-confidence refresh once it has gone stale), so a
 * manual refresh can never quietly downgrade a licensed Commons portrait to a fuzzy Last.fm match.
 */
export function shouldReplaceImage(
  existing: ArtistImageFileRecord | null,
  incoming: ArtistImageFileRecord,
  now = Date.now(),
  staleAfterMs = DEFAULT_ARTIST_IMAGE_REFRESH_AFTER_MS
): StoreDecision {
  if (!incoming.fileName || !Number.isFinite(incoming.confidence)) {
    return { stored: false, reason: "invalid" };
  }
  if (!existing) return { stored: true, reason: "stored" };
  if (incoming.confidence > existing.confidence + 1e-9) return { stored: true, reason: "stored" };
  if (incoming.confidence < existing.confidence - 1e-9) {
    return { stored: false, reason: "kept-higher-confidence" };
  }
  const stale = now - existing.verifiedAt >= staleAfterMs;
  if (stale && incoming.savedAt >= existing.savedAt) return { stored: true, reason: "stored" };
  return { stored: false, reason: "kept-newer" };
}

export class ArtistImageCacheCore {
  private artists = new Map<string, ArtistImageFileRecord>();
  private misses = new Map<string, ArtistImageMissRecord>();
  private lastSerialized = "";
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(
    private readonly persistence: ArtistImageCachePersistence = {},
    options: { maxEntries?: number } = {}
  ) {
    this.now = persistence.now ?? (() => Date.now());
    this.maxEntries = Math.max(16, options.maxEntries ?? MAX_ARTIST_IMAGE_ENTRIES);
    this.load(persistence.initialJson);
  }

  private load(raw: string | null | undefined): void {
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.version !== ARTIST_IMAGE_CACHE_VERSION) return;
      const artists = isRecord(parsed.artists) ? parsed.artists : {};
      for (const value of Object.values(artists)) {
        const record = normalizeStoredImage(value);
        if (record) this.artists.set(record.artistKey, record);
      }
      const misses = isRecord(parsed.misses) ? parsed.misses : {};
      for (const value of Object.values(misses)) {
        const record = normalizeStoredMiss(value);
        if (record) this.misses.set(record.artistKey, record);
      }
    } catch (error) {
      console.warn("[Cadence] Artist image cache is unreadable, starting empty:", error);
      this.artists.clear();
      this.misses.clear();
    }
  }

  /** Cached picture for an artist, marking the entry as recently used. */
  get(
    artistKey: string,
    options: { staleAfterMs?: number } = {}
  ): ArtistImageCacheLookup | null {
    const record = this.artists.get(artistKey);
    if (!record) return null;
    record.lastAccessAt = this.now();
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_ARTIST_IMAGE_REFRESH_AFTER_MS;
    return { record: { ...record }, stale: this.now() - record.verifiedAt >= staleAfterMs };
  }

  /** A still-valid negative answer for this artist, or null when providers should be asked again. */
  getMiss(artistKey: string): ArtistImageMissRecord | null {
    const record = this.misses.get(artistKey);
    if (!record) return null;
    if (record.retryAfter > this.now()) return { ...record };
    this.misses.delete(artistKey);
    return null;
  }

  /**
   * Stores a validated picture. Returns whether it was written and why, so callers can log a
   * downgrade refusal instead of silently keeping the old image.
   */
  put(record: ArtistImageFileRecord): StoreDecision {
    const existing = this.artists.get(record.artistKey) ?? null;
    const decision = shouldReplaceImage(existing, record, this.now());
    if (!decision.stored) return decision;
    this.artists.set(record.artistKey, { ...record, lastAccessAt: this.now() });
    this.misses.delete(record.artistKey);
    this.evictIfNeeded();
    this.save();
    return decision;
  }

  putMiss(record: ArtistImageMissRecord): void {
    this.misses.set(record.artistKey, { ...record });
    this.evictIfNeeded();
    this.save();
  }

  /** Drops one artist (manual refresh), forcing the next resolve to query providers again. */
  invalidate(artistKey: string): void {
    const removed = this.artists.delete(artistKey);
    const removedMiss = this.misses.delete(artistKey);
    if (removed || removedMiss) this.save();
  }

  clear(): { removedImages: number; removedMisses: number; removedFiles: string[] } {
    const removedFiles = [...this.artists.values()].map(record => record.fileName);
    const removedImages = this.artists.size;
    const removedMisses = this.misses.size;
    this.artists.clear();
    this.misses.clear();
    this.save();
    return { removedImages, removedMisses, removedFiles };
  }

  entries(): ArtistImageFileRecord[] {
    return [...this.artists.values()].sort((a, b) => b.lastAccessAt - a.lastAccessAt);
  }

  /**
   * Artist names in the index, split by outcome. Settings uses it to offer "refresh every picture",
   * including a retry for artists that previously had no usable picture.
   */
  indexedArtists(): { withImage: string[]; withoutImage: string[] } {
    const misses = [...this.misses.values()].filter(record => !this.artists.has(record.artistKey));
    return {
      withImage: [...this.artists.values()]
        .sort((a, b) => b.lastAccessAt - a.lastAccessAt)
        .map(record => record.artistName),
      withoutImage: misses.map(record => record.artistName),
    };
  }

  stats(): ArtistImageCacheStats {
    const json = this.serialize();
    return {
      artists: this.artists.size,
      misses: this.misses.size,
      bytes: typeof TextEncoder === "undefined" ? json.length * 2 : new TextEncoder().encode(json).length,
    };
  }

  serialize(): string {
    const file: CacheFile = {
      version: ARTIST_IMAGE_CACHE_VERSION,
      artists: Object.fromEntries(this.artists),
      misses: Object.fromEntries(this.misses),
    };
    return JSON.stringify(file);
  }

  private evictIfNeeded(): void {
    while (this.artists.size > this.maxEntries) {
      let oldestKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, record] of this.artists) {
        if (record.lastAccessAt < oldest) {
          oldest = record.lastAccessAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.artists.delete(oldestKey);
    }
    while (this.misses.size > this.maxEntries) {
      let oldestKey: string | null = null;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [key, record] of this.misses) {
        if (record.failedAt < oldest) {
          oldest = record.failedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      this.misses.delete(oldestKey);
    }
  }

  /** Writes the index, skipping byte-identical rewrites (a cache read must never hit the disk). */
  save(): void {
    if (!this.persistence.persist) return;
    const json = this.serialize();
    if (json === this.lastSerialized) return;
    this.lastSerialized = json;
    try {
      const result = this.persistence.persist(json);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(error => {
          console.error("[Cadence] Failed to persist artist image cache:", error);
        });
      }
    } catch (error) {
      console.error("[Cadence] Failed to persist artist image cache:", error);
    }
  }
}
