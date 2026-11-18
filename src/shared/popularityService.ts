/**
 * Popularity Intelligence Coordinator, Multi-Provider Aggregator, and Local Cache Policy.
 *
 * - Evaluates configured `PopularityProvider` instances without assuming any single provider
 *   is universal.
 * - Combines multiple provider hits via confidence-weighted fusion.
 * - Enforces local cache TTL expiration policies (30 days catalog hit, 7 days new release,
 *   14 days negative cache) and remains 100% functional offline.
 */

import {
  DEFAULT_POPULARITY_PROVIDERS,
  isUnresolvableQuery,
  type PopularityProvider,
  type PopularityProviderConfig,
  type PopularityProviderId,
  type PopularityProviderResult,
  type PopularityQuery,
  type ProviderFeasibilityReport,
} from "./popularityProviders";
import { smartRecordingKey, type TrackIntelligenceRecord } from "./smartShuffle";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** 30 days TTL for standard catalog hits. */
export const POPULARITY_HIT_TTL_MS = 30 * DAY_MS;

/** 7 days TTL for tracks released in the current or previous calendar year. */
export const POPULARITY_NEW_RELEASE_TTL_MS = 7 * DAY_MS;

/** 14 days cooldown for definitive misses across all available providers. */
export const POPULARITY_NEGATIVE_TTL_MS = 14 * DAY_MS;

/** 10 minutes in-memory retry cooldown after a transient network or rate-limit failure. */
export const TRANSIENT_ERROR_COOLDOWN_MS = 10 * MINUTE_MS;

export interface AggregatedPopularityOutcome {
  recordingKey: string;
  status: "cached" | "hit" | "not_found" | "offline" | "transient_error" | "skipped_generic";
  record: TrackIntelligenceRecord;
  providerResults: PopularityProviderResult[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Checks whether a cached `TrackIntelligenceRecord` has a fresh, non-expired popularity entry.
 */
export function isPopularityCacheFresh(
  record: TrackIntelligenceRecord | undefined | null,
  now = Date.now()
): boolean {
  if (!record) return false;
  if (record.fetchedAt === null || record.expiresAt === null) return false;
  if (!record.popularitySource) return false;
  return now < record.expiresAt;
}

/**
 * Computes the expiration timestamp for a resolved popularity lookup.
 */
export function computePopularityExpiry(
  isPositiveHit: boolean,
  trackYear: number | null | undefined,
  now = Date.now()
): number {
  if (!isPositiveHit) {
    return now + POPULARITY_NEGATIVE_TTL_MS;
  }
  const currentYear = new Date(now).getUTCFullYear();
  if (typeof trackYear === "number" && trackYear >= currentYear) {
    return now + POPULARITY_NEW_RELEASE_TTL_MS;
  }
  return now + POPULARITY_HIT_TTL_MS;
}

/**
 * Combines results from one or more providers using confidence-weighted fusion.
 * Deduplicates genre tags across all responding providers.
 */
export function fuseProviderResults(
  results: readonly PopularityProviderResult[]
): {
  hit: boolean;
  popularity: number | null;
  confidence: number;
  primarySource: string | null;
  rawMetric: number | null;
  genres: string[];
  allDefinitiveMiss: boolean;
} {
  const hits = results.filter(
    r =>
      r.status === "hit" &&
      typeof r.popularity === "number" &&
      Number.isFinite(r.popularity) &&
      r.confidence > 0
  );

  const genreSet = new Set<string>();
  for (const r of results) {
    for (const g of r.genres ?? []) {
      const trimmed = g.trim();
      if (trimmed) genreSet.add(trimmed);
    }
  }

  if (hits.length === 0) {
    const anyAvailableAttempted = results.some(
      r => r.status === "miss" || r.status === "error" || r.status === "rate-limited"
    );
    const anyTransientFailure = results.some(
      r => r.status === "error" || r.status === "rate-limited"
    );
    return {
      hit: false,
      popularity: null,
      confidence: 0,
      primarySource: null,
      rawMetric: null,
      genres: [...genreSet],
      allDefinitiveMiss: anyAvailableAttempted && !anyTransientFailure,
    };
  }

  let weightedSum = 0;
  let weightTotal = 0;
  let complementProduct = 1.0;
  let bestHit = hits[0];

  for (const h of hits) {
    const pop = clamp(h.popularity ?? 0.5, 0, 1);
    const conf = clamp(h.confidence, 0.05, 0.98);
    weightedSum += conf * pop;
    weightTotal += conf;
    complementProduct *= 1.0 - conf;
    if (conf > bestHit.confidence) {
      bestHit = h;
    }
  }

  const combinedPopularity = clamp(weightedSum / weightTotal, 0.05, 1.0);
  const combinedConfidence = clamp(1.0 - complementProduct, 0.1, 0.98);
  const sourceLabel =
    hits.length === 1 ? bestHit.provider : hits.map(h => h.provider).join("+");

  return {
    hit: true,
    popularity: combinedPopularity,
    confidence: combinedConfidence,
    primarySource: sourceLabel,
    rawMetric: bestHit.rawMetric,
    genres: [...genreSet],
    allDefinitiveMiss: false,
  };
}

export class PopularityService {
  private readonly providersById: Map<PopularityProviderId, PopularityProvider>;
  private readonly transientFailureUntil = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<AggregatedPopularityOutcome>>();

  constructor(
    providers: readonly PopularityProvider[] = DEFAULT_POPULARITY_PROVIDERS
  ) {
    this.providersById = new Map(providers.map(p => [p.id, p]));
  }

  /** Returns independent feasibility reports for every registered popularity provider. */
  evaluateAllProviders(config: PopularityProviderConfig): ProviderFeasibilityReport[] {
    return [...this.providersById.values()].map(p => p.evaluateFeasibility(config));
  }

  /**
   * Resolves popularity for a track query, consulting `existingRecord` first and only
   * performing network requests when the cache is missing or expired.
   */
  async resolve(
    query: PopularityQuery,
    config: PopularityProviderConfig,
    existingRecord?: TrackIntelligenceRecord | null,
    options: { now?: number; forceRefresh?: boolean; signal?: AbortSignal } = {}
  ): Promise<AggregatedPopularityOutcome> {
    const now = options.now ?? Date.now();
    const recordingKey =
      existingRecord?.recordingKey ??
      smartRecordingKey({
        id: query.trackId,
        title: query.title,
        artist: query.artist,
        duration: query.durationSeconds,
      });

    const baseRecord: TrackIntelligenceRecord = existingRecord
      ? { ...existingRecord, externalGenres: [...(existingRecord.externalGenres ?? [])] }
      : {
          recordingKey,
          trackId: query.trackId ?? null,
          artist: query.artist,
          title: query.title,
          popularity: null,
          popularitySource: null,
          popularityConfidence: null,
          externalListeners: null,
          externalGenres: [],
          fetchedAt: null,
          expiresAt: null,
          skipCount: 0,
          completeCount: 0,
          lastSkippedAt: null,
          lastCompletedAt: null,
          updatedAt: now,
        };

    // 1. Return fresh cached result immediately
    if (!options.forceRefresh && isPopularityCacheFresh(existingRecord, now)) {
      return {
        recordingKey,
        status: "cached",
        record: baseRecord,
        providerResults: [],
      };
    }

    // 2. Skip network for untagged / generic queries ("Track 01", "Unknown Artist", "Intro")
    if (isUnresolvableQuery(query)) {
      return {
        recordingKey,
        status: "skipped_generic",
        record: baseRecord,
        providerResults: [],
      };
    }

    // 3. Offline / disabled check
    const isOffline =
      !config.enabled ||
      (typeof navigator !== "undefined" && "onLine" in navigator && navigator.onLine === false);
    if (isOffline) {
      return {
        recordingKey,
        status: "offline",
        record: baseRecord,
        providerResults: [],
      };
    }

    // 4. Transient error cooldown check
    const cooldownUntil = this.transientFailureUntil.get(recordingKey) ?? 0;
    if (!options.forceRefresh && now < cooldownUntil) {
      return {
        recordingKey,
        status: "transient_error",
        record: baseRecord,
        providerResults: [],
      };
    }

    // Share in-flight resolution for the same recordingKey
    const existingFlight = this.inFlight.get(recordingKey);
    if (existingFlight && !options.forceRefresh) {
      return existingFlight;
    }

    const task = this.executeLookup(query, config, baseRecord, recordingKey, now, options.signal);
    this.inFlight.set(recordingKey, task);
    try {
      return await task;
    } finally {
      if (this.inFlight.get(recordingKey) === task) {
        this.inFlight.delete(recordingKey);
      }
    }
  }

  private async executeLookup(
    query: PopularityQuery,
    config: PopularityProviderConfig,
    baseRecord: TrackIntelligenceRecord,
    recordingKey: string,
    now: number,
    signal?: AbortSignal
  ): Promise<AggregatedPopularityOutcome> {
    const order = config.providerOrder ?? ["lastfm", "deezer", "itunes", "google-kg"];
    const providerResults: PopularityProviderResult[] = [];

    for (const providerId of order) {
      if (signal?.aborted) break;
      const provider = this.providersById.get(providerId);
      if (!provider || !provider.isAvailable(config)) continue;

      const result = await provider.lookup(query, config, signal);
      providerResults.push(result);

      // Stop early once we have a high-confidence hit (>= 0.72) AND at least one genre tag
      // (or if we already have two corroborating hits)
      const currentFusion = fuseProviderResults(providerResults);
      const hasAnyGenres =
        currentFusion.genres.length > 0 || baseRecord.externalGenres.length > 0;
      if (currentFusion.hit && currentFusion.confidence >= 0.72 && hasAnyGenres) {
        break;
      }
      const hitCount = providerResults.filter(r => r.status === "hit").length;
      if (hitCount >= 2) {
        break;
      }
    }

    const fused = fuseProviderResults(providerResults);

    if (fused.hit) {
      this.transientFailureUntil.delete(recordingKey);
      const mergedGenres = [
        ...new Set([...baseRecord.externalGenres, ...fused.genres]),
      ].slice(0, 8);
      const updated: TrackIntelligenceRecord = {
        ...baseRecord,
        popularity: fused.popularity,
        popularitySource: fused.primarySource,
        popularityConfidence: fused.confidence,
        externalListeners: fused.rawMetric,
        externalGenres: mergedGenres,
        fetchedAt: now,
        expiresAt: computePopularityExpiry(true, query.year, now),
        updatedAt: now,
      };
      return {
        recordingKey,
        status: "hit",
        record: updated,
        providerResults,
      };
    }

    if (fused.allDefinitiveMiss) {
      this.transientFailureUntil.delete(recordingKey);
      const negativeRecord: TrackIntelligenceRecord = {
        ...baseRecord,
        popularity: null,
        popularitySource: "not_found",
        popularityConfidence: 0,
        externalListeners: null,
        fetchedAt: now,
        expiresAt: computePopularityExpiry(false, query.year, now),
        updatedAt: now,
      };
      return {
        recordingKey,
        status: "not_found",
        record: negativeRecord,
        providerResults,
      };
    }

    // Transient network / rate-limit failure: record in-memory cooldown, do not poison SQLite cache
    const maxRetrySec = providerResults.reduce(
      (max, r) => Math.max(max, r.retryAfterSeconds ?? 0),
      0
    );
    const backoffMs =
      maxRetrySec > 0 ? maxRetrySec * 1000 : TRANSIENT_ERROR_COOLDOWN_MS;
    this.transientFailureUntil.set(recordingKey, now + backoffMs);

    return {
      recordingKey,
      status: "transient_error",
      record: baseRecord,
      providerResults,
    };
  }

  clearTransientCooldowns(): void {
    this.transientFailureUntil.clear();
  }
}

export const defaultPopularityService = new PopularityService();
