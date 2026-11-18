/**
 * Artist profile-picture resolution pipeline.
 *
 * The flow is deliberately fixed and provider-agnostic:
 *
 *   cache hit → (fresh) return
 *   cache miss → providers in priority order → validate bytes → cache first acceptable result
 *   all providers fail → remember a bounded "no picture" answer → fall back to the default avatar
 *
 * Everything provider-specific lives behind `ArtistImageProvider`, so a new source only has to be
 * registered; the pipeline, the cache and the UI stay untouched.
 *
 * Guarantees:
 *  - one in-flight request per artist (concurrent callers share the same promise);
 *  - bounded concurrency, so a screen full of artist cards cannot fire every request at once;
 *  - a provider that throws, times out or returns garbage never stops the remaining providers;
 *  - a validated higher-confidence picture is never replaced by a weaker one (see the cache core);
 *  - pictures that fail inspection (tracking pixels, HTML error pages, wrong content types) are
 *    rejected before anything is written to disk.
 */

import {
  ArtistImageCacheCore,
  DEFAULT_ARTIST_IMAGE_ERROR_TTL_MS,
  DEFAULT_ARTIST_IMAGE_MISS_TTL_MS,
  DEFAULT_ARTIST_IMAGE_REFRESH_AFTER_MS,
  artistImageKey,
  type ArtistImageFileRecord,
} from "./artistImageCache";
import {
  createArtistImageProviders,
  isUnresolvableArtistName,
  type ArtistImageProvider,
  type ArtistImageProviderConfig,
  type ArtistImageProviderResult,
  type ArtistImageQuery,
} from "./artistImageProviders";
import { validateArtistImageBytes } from "./imageInspection";

export interface ArtistImageFetchResponse {
  ok: boolean;
  status: number;
  contentType: string | null;
  bytes: Uint8Array;
  retryAfterSeconds?: number;
}

export type ArtistImageFetchFn = (url: string, signal?: AbortSignal) => Promise<ArtistImageFetchResponse>;

export type ArtistImageResolutionStatus = "cached" | "fetched" | "unavailable" | "disabled";

export interface ArtistImageProviderAttempt {
  provider: string;
  status: string;
  detail?: string;
}

export interface ArtistImageResolution {
  status: ArtistImageResolutionStatus;
  artistName: string;
  artistKey: string;
  /** The cached picture, when there is one. `null` means "draw the default avatar". */
  record: ArtistImageFileRecord | null;
  /** Every provider consulted, in order, with its outcome (diagnostics). */
  providers: ArtistImageProviderAttempt[];
  reason?: string;
  /** True when a cached picture was returned while a background refresh was started. */
  refreshing?: boolean;
  elapsedMs?: number;
}

export type ArtistImageDiagnosticEvent =
  | {
      type: "resolve";
      artistName: string;
      status: ArtistImageResolutionStatus;
      reason?: string;
      provider?: string;
      confidence?: number;
      elapsedMs?: number;
      providers: ArtistImageProviderAttempt[];
    }
  | { type: "cache-hit"; artistName: string; stale: boolean }
  | { type: "refused-downgrade"; artistName: string; reason: string }
  | { type: "cache-cleared"; removedImages: number; removedMisses: number }
  | { type: "provider-invalid-image"; artistName: string; provider: string; failure: string };

export interface ArtistImageServiceOptions {
  cache: ArtistImageCacheCore;
  config: ArtistImageProviderConfig;
  /** Persists validated bytes and resolves the stored file name (content-addressed by the caller). */
  saveImage: (bytes: Uint8Array, mimeType: string, extension: string) => Promise<string>;
  /** Provider instances; defaults to the configured order. */
  providers?: ArtistImageProvider[];
  fetchImage?: ArtistImageFetchFn;
  onDiagnostic?: (event: ArtistImageDiagnosticEvent) => void;
  /** Notified after the cache index changed, so a UI can re-read it. */
  onChange?: () => void;
  /** A cached picture older than this is refreshed opportunistically. */
  staleAfterMs?: number;
  missTtlMs?: number;
  errorTtlMs?: number;
  maxConcurrentRequests?: number;
  /**
   * Fetch missing pictures automatically (`settings.artistImages.autoFetch`). When false the service
   * only ever answers from the cache: cached pictures keep displaying, nothing is downloaded, and no
   * negative entry is written, so switching automatic fetching back on immediately works again.
   */
  autoFetch?: boolean;
  /** Disable the opportunistic background refresh of stale entries (tests, offline mode). */
  refreshStaleInBackground?: boolean;
  now?: () => number;
}

/** Small promise semaphore: caps how many provider/network operations run at the same time. */
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    // The releasing caller hands its slot straight to this waiter, so `active` never dips and two
    // "freed" slots can never be counted twice.
    await new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }
}

export class ArtistImageService {
  private readonly cache: ArtistImageCacheCore;
  private readonly config: ArtistImageProviderConfig;
  private readonly providers: ArtistImageProvider[];
  private readonly saveImage: ArtistImageServiceOptions["saveImage"];
  private readonly fetchImage: ArtistImageFetchFn;
  private readonly onDiagnostic?: (event: ArtistImageDiagnosticEvent) => void;
  private readonly onChange?: () => void;
  private readonly staleAfterMs: number;
  private readonly missTtlMs: number;
  private readonly errorTtlMs: number;
  private readonly autoFetch: boolean;
  private readonly refreshStaleInBackground: boolean;
  private readonly now: () => number;
  private readonly semaphore: Semaphore;
  private readonly inFlight = new Map<string, Promise<ArtistImageResolution>>();
  private readonly backgroundRefreshes = new Set<string>();

  constructor(options: ArtistImageServiceOptions) {
    this.cache = options.cache;
    this.config = options.config;
    this.providers = options.providers ?? createArtistImageProviders(options.config);
    this.saveImage = options.saveImage;
    this.fetchImage = options.fetchImage ?? defaultFetchImage(options.config);
    this.onDiagnostic = options.onDiagnostic;
    this.onChange = options.onChange;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_ARTIST_IMAGE_REFRESH_AFTER_MS;
    this.missTtlMs = options.missTtlMs ?? DEFAULT_ARTIST_IMAGE_MISS_TTL_MS;
    this.errorTtlMs = options.errorTtlMs ?? DEFAULT_ARTIST_IMAGE_ERROR_TTL_MS;
    this.autoFetch = options.autoFetch ?? true;
    this.refreshStaleInBackground = options.refreshStaleInBackground ?? true;
    this.now = options.now ?? (() => Date.now());
    this.semaphore = new Semaphore(Math.max(1, options.maxConcurrentRequests ?? 3));
  }

  /** Number of requests still running; used by tests and diagnostics. */
  pendingCount(): number {
    return this.inFlight.size;
  }

  /**
   * Resolves one artist picture, sharing a single request between concurrent callers (a grid of
   * cards for the same artist therefore triggers one network call, not one per card).
   */
  resolve(
    query: ArtistImageQuery,
    options: { force?: boolean; signal?: AbortSignal } = {}
  ): Promise<ArtistImageResolution> {
    const artistName = (query.name ?? "").trim();
    const key = artistImageKey(artistName);
    if (!this.config.enabled) {
      return Promise.resolve({
        status: "disabled",
        artistName,
        artistKey: key,
        record: null,
        providers: [],
        reason: "artist-images-disabled",
      });
    }
    if (!options.force) {
      const existing = this.inFlight.get(key);
      if (existing) return existing;
    }
    let task: Promise<ArtistImageResolution>;
    task = this.run(query, key, options).finally(() => {
      if (this.inFlight.get(key) === task) this.inFlight.delete(key);
    });
    this.inFlight.set(key, task);
    return task;
  }

  /**
   * Re-queries providers for one artist, ignoring both the cached picture and the negative answer.
   *
   * By default an explicit refresh also *replaces* the stored picture: that is the user saying "this
   * one is wrong", and the confidence guard would otherwise keep a high-trust-but-wrong portrait
   * forever. Pass `replaceExisting: false` to keep the guard (a background staleness refresh does
   * exactly that, and simply walks the normal `resolve` path).
   */
  async refresh(
    query: ArtistImageQuery,
    options: { signal?: AbortSignal; replaceExisting?: boolean } = {}
  ): Promise<ArtistImageResolution> {
    if (options.replaceExisting ?? true) {
      this.cache.invalidate(artistImageKey((query.name ?? "").trim()));
      this.onChange?.();
    }
    return this.resolve(query, { signal: options.signal, force: true });
  }

  /** Cached picture without any network access (for instant first paint). */
  cached(artistName: string): ArtistImageResolution {
    const key = artistImageKey((artistName ?? "").trim());
    const hit = this.cache.get(key, { staleAfterMs: this.staleAfterMs });
    return {
      status: hit ? "cached" : "unavailable",
      artistName: (artistName ?? "").trim(),
      artistKey: key,
      record: hit?.record ?? null,
      providers: [],
      ...(hit ? {} : { reason: "not-cached" }),
    };
  }

  clearCache(): { removedImages: number; removedMisses: number; removedFiles: string[] } {
    const result = this.cache.clear();
    this.onDiagnostic?.({
      type: "cache-cleared",
      removedImages: result.removedImages,
      removedMisses: result.removedMisses,
    });
    this.onChange?.();
    return result;
  }

  private async run(
    query: ArtistImageQuery,
    key: string,
    options: { force?: boolean }
  ): Promise<ArtistImageResolution> {
    const startedAt = this.now();
    const artistName = (query.name ?? "").trim();

    if (isUnresolvableArtistName(artistName)) {
      return {
        status: "unavailable",
        artistName,
        artistKey: key,
        record: null,
        providers: [],
        reason: "unresolvable-artist-name",
        elapsedMs: this.now() - startedAt,
      };
    }

    if (!options.force) {
      const hit = this.cache.get(key, { staleAfterMs: this.staleAfterMs });
      if (hit) {
        this.onDiagnostic?.({ type: "cache-hit", artistName, stale: hit.stale });
        if (hit.stale && this.refreshStaleInBackground && this.autoFetch) {
          // Fire and forget: the stale picture is already usable, this only keeps it current.
          this.scheduleBackgroundRefresh(query, key);
          return {
            status: "cached",
            artistName,
            artistKey: key,
            record: hit.record,
            providers: [],
            refreshing: true,
            elapsedMs: this.now() - startedAt,
          };
        }
        return {
          status: "cached",
          artistName,
          artistKey: key,
          record: hit.record,
          providers: [],
          elapsedMs: this.now() - startedAt,
        };
      }
      const miss = this.cache.getMiss(key);
      if (miss) {
        return {
          status: "unavailable",
          artistName,
          artistKey: key,
          record: null,
          providers: miss.attempted.map(provider => ({ provider, status: "cached-miss" })),
          reason: miss.reason,
          elapsedMs: this.now() - startedAt,
        };
      }
    }

    if (!this.autoFetch && !options.force) {
      // Serving only what is cached already. This is not a "no picture exists" answer, so nothing is
      // recorded: a manual refresh (force) or re-enabling automatic fetching queries providers again.
      return {
        status: "unavailable",
        artistName,
        artistKey: key,
        record: null,
        providers: [],
        reason: "auto-fetch-disabled",
        elapsedMs: this.now() - startedAt,
      };
    }

    return this.runProviders(query, key, artistName);
  }

  /** One opportunistic refresh per artist, never more, and never after the cache was cleared. */
  private scheduleBackgroundRefresh(query: ArtistImageQuery, key: string): void {
    if (this.backgroundRefreshes.has(key)) return;
    this.backgroundRefreshes.add(key);
    void this.runProviders(query, key, (query.name ?? "").trim())
      .catch(() => undefined)
      .finally(() => this.backgroundRefreshes.delete(key));
  }

  private async runProviders(
    query: ArtistImageQuery,
    key: string,
    artistName: string
  ): Promise<ArtistImageResolution> {
    const startedAt = this.now();
    const attempts: ArtistImageProviderAttempt[] = [];
    let transientFailure = false;

    for (const provider of this.providers) {
      if (!provider.isAvailable(this.config)) {
        attempts.push({ provider: provider.id, status: "skipped", detail: "not-configured" });
        continue;
      }
      let result: ArtistImageProviderResult;
      await this.semaphore.acquire();
      try {
        result = await provider.lookup(query, this.config);
      } catch (error) {
        result = {
          provider: provider.id,
          status: "error",
          candidate: null,
          detail: (error as Error)?.message || "provider-threw",
        };
      } finally {
        this.semaphore.release();
      }
      attempts.push({ provider: provider.id, status: result.status, detail: result.detail });
      if (result.status === "error" || result.status === "rate-limited") transientFailure = true;

      const candidate = result.candidate;
      if (result.status !== "hit" || !candidate) continue;

      const materialized = await this.materialize(candidate, artistName);
      if (!materialized.ok) {
        attempts[attempts.length - 1] = {
          provider: provider.id,
          status: "invalid-image",
          detail: materialized.failure,
        };
        transientFailure = true;
        continue;
      }

      const existing = this.cache.get(key, { staleAfterMs: this.staleAfterMs });
      const decision = this.cache.put(materialized.record);
      if (!decision.stored) {
        this.onDiagnostic?.({
          type: "refused-downgrade",
          artistName,
          reason: decision.reason,
        });
        // Never replace a verified picture with a weaker one, but an existing valid entry still
        // answers this request.
        const kept = existing?.record ?? null;
        this.onChange?.();
        return {
          status: kept ? "cached" : "unavailable",
          artistName,
          artistKey: key,
          record: kept,
          providers: attempts,
          reason: decision.reason,
          elapsedMs: this.now() - startedAt,
        };
      }

      this.onChange?.();
      this.onDiagnostic?.({
        type: "resolve",
        artistName,
        status: "fetched",
        provider: provider.id,
        confidence: materialized.record.confidence,
        providers: attempts,
        elapsedMs: this.now() - startedAt,
      });
      return {
        status: "fetched",
        artistName,
        artistKey: key,
        record: materialized.record,
        providers: attempts,
        elapsedMs: this.now() - startedAt,
      };
    }

    const reason = transientFailure ? "providers-unavailable" : "no-image-found";
    this.cache.putMiss({
      artistKey: key,
      artistName,
      reason,
      attempted: attempts.map(attempt => attempt.provider),
      failedAt: this.now(),
      retryAfter: this.now() + (transientFailure ? this.errorTtlMs : this.missTtlMs),
    });
    this.onChange?.();
    this.onDiagnostic?.({
      type: "resolve",
      artistName,
      status: "unavailable",
      reason,
      providers: attempts,
      elapsedMs: this.now() - startedAt,
    });
    return {
      status: "unavailable",
      artistName,
      artistKey: key,
      record: null,
      providers: attempts,
      reason,
      elapsedMs: this.now() - startedAt,
    };
  }

  /** Downloads a candidate URL, validates the payload and stores it under its content hash. */
  private async materialize(
    candidate: NonNullable<ArtistImageProviderResult["candidate"]>,
    artistName: string
  ): Promise<{ ok: true; record: ArtistImageFileRecord } | { ok: false; failure: string }> {
    let response: ArtistImageFetchResponse;
    try {
      await this.semaphore.acquire();
      try {
        response = await this.fetchImage(candidate.imageUrl);
      } finally {
        this.semaphore.release();
      }
    } catch (error) {
      this.onDiagnostic?.({
        type: "provider-invalid-image",
        artistName,
        provider: candidate.provider,
        failure: (error as Error)?.message || "download-failed",
      });
      return { ok: false, failure: "download-failed" };
    }
    if (!response.ok) return { ok: false, failure: `http-${response.status}` };
    // A declared type that is plainly not an image (an HTML error page, a JSON error body) is
    // rejected even when the payload happens to start with image bytes; `application/octet-stream`
    // and a missing header are both accepted, since CDNs commonly serve images that way.
    const declared = (response.contentType ?? "").split(";")[0].trim().toLowerCase();
    const declaredIsUsable =
      !declared || declared.startsWith("image/") || declared === "application/octet-stream" || declared === "binary/octet-stream";
    if (!declaredIsUsable) {
      this.onDiagnostic?.({
        type: "provider-invalid-image",
        artistName,
        provider: candidate.provider,
        failure: "non-image-content-type",
      });
      return { ok: false, failure: "non-image-content-type" };
    }

    const validation = validateArtistImageBytes(response.bytes);
    if (!validation.ok || !validation.image) {
      const failure = validation.failure ?? "invalid-image";
      this.onDiagnostic?.({
        type: "provider-invalid-image",
        artistName,
        provider: candidate.provider,
        failure,
      });
      return { ok: false, failure };
    }

    const image = validation.image;
    let fileName: string;
    try {
      fileName = await this.saveImage(response.bytes, image.mimeType, image.extension);
    } catch (error) {
      return { ok: false, failure: (error as Error)?.message || "save-failed" };
    }

    return {
      ok: true,
      record: {
        artistKey: artistImageKey(artistName),
        artistName,
        mbid: candidate.mbid,
        fileName,
        provider: candidate.provider,
        sourceUrl: candidate.imageUrl,
        pageUrl: candidate.pageUrl,
        attribution: candidate.attribution,
        license: candidate.license,
        licenseUrl: candidate.licenseUrl,
        author: candidate.author,
        width: image.width,
        height: image.height,
        confidence: candidate.confidence,
        savedAt: this.now(),
        verifiedAt: this.now(),
        lastAccessAt: this.now(),
      },
    };
  }
}

/** Default transport: plain GET with a bounded timeout, returning raw bytes. */
function defaultFetchImage(config: ArtistImageProviderConfig): ArtistImageFetchFn {
  return async (url, signal) => {
    const fetchFn = config.fetchFn ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));
    const timeout = AbortSignal.timeout(Math.max(1000, config.timeoutMs));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "image/*", "User-Agent": config.userAgent },
      signal: combined,
    });
    const buffer = await response.arrayBuffer();
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers?.get?.("Content-Type") ?? null,
      bytes: new Uint8Array(buffer),
    };
  };
}
