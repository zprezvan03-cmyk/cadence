/**
 * Renderer store for Cadence Listening & Popularity Intelligence (`track_intelligence`).
 *
 * Hydrates persisted skip/completion counters and popularity cache rows from SQLite via the
 * bridge, applies session-safe telemetry outcomes optimistically in memory, coalesces SQLite
 * writes on a background timer, and memoizes the `LibraryShuffleIndex` so repeated shuffle and
 * AutoPlay operations run in O(1) index lookup time.
 */

import { create } from "zustand";
import { hasBridge } from "./bridge";
import type { TelemetrySessionEvent } from "../../shared/listeningTelemetry";
import {
  defaultPopularityService,
  isPopularityCacheFresh,
  type AggregatedPopularityOutcome,
} from "../../shared/popularityService";
import type { PopularityProviderConfig } from "../../shared/popularityProviders";
import {
  buildLibraryShuffleIndex,
  smartRecordingKey,
  type LibraryShuffleIndex,
  type SmartShuffleTrack,
  type TrackIntelligenceRecord,
} from "../../shared/smartShuffle";
import type { HistoryEntry } from "../../shared/types";

interface IntelligenceState {
  byRecordingKey: Map<string, TrackIntelligenceRecord>;
  version: number;
  loaded: boolean;
  loading: boolean;
  load: () => Promise<void>;
  applyTelemetryEvent: (event: TelemetrySessionEvent | null) => TrackIntelligenceRecord | null;
  upsertRecords: (records: readonly TrackIntelligenceRecord[]) => void;
  resolveTrackPopularity: (
    track: SmartShuffleTrack,
    config: PopularityProviderConfig,
    now?: number
  ) => Promise<AggregatedPopularityOutcome>;
  prefetchHorizonPopularity: (
    tracks: readonly SmartShuffleTrack[],
    config: PopularityProviderConfig,
    maxTracks?: number
  ) => void;
  getCachedIndex: (
    tracks: readonly SmartShuffleTrack[],
    historyEntries: readonly HistoryEntry[],
    now?: number
  ) => LibraryShuffleIndex;
  resetForTests: () => void;
}

const pendingPersist = new Map<string, TrackIntelligenceRecord>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(record: TrackIntelligenceRecord): void {
  pendingPersist.set(record.recordingKey, record);
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (!hasBridge() || !window.cadence?.intelligence) {
      pendingPersist.clear();
      return;
    }
    const batch = [...pendingPersist.values()];
    pendingPersist.clear();
    if (batch.length === 0) return;
    void window.cadence.intelligence.upsert(batch).catch(error => {
      console.warn("[Cadence] Failed to persist track intelligence:", error);
    });
  }, 150);
}

let cachedIndex: {
  tracksRef: readonly SmartShuffleTrack[];
  trackCount: number;
  intelVersion: number;
  historyCount: number;
  builtAt: number;
  index: LibraryShuffleIndex;
} | null = null;

export const useIntelligence = create<IntelligenceState>()((set, get) => ({
  byRecordingKey: new Map(),
  version: 0,
  loaded: false,
  loading: false,

  load: async () => {
    if (get().loaded || get().loading) return;
    if (!hasBridge() || !window.cadence?.intelligence) {
      set({ loaded: true, loading: false });
      return;
    }
    set({ loading: true });
    try {
      const rows = await window.cadence.intelligence.list();
      const merged = new Map<string, TrackIntelligenceRecord>();
      for (const row of rows) {
        merged.set(row.recordingKey, row);
      }
      // Preserve any optimistic telemetry recorded while the initial load was in flight
      for (const [key, current] of get().byRecordingKey) {
        const fromDb = merged.get(key);
        if (!fromDb) {
          merged.set(key, current);
        } else {
          merged.set(key, {
            ...fromDb,
            ...current,
            skipCount: Math.max(fromDb.skipCount, current.skipCount),
            completeCount: Math.max(fromDb.completeCount, current.completeCount),
            lastSkippedAt:
              Math.max(fromDb.lastSkippedAt ?? 0, current.lastSkippedAt ?? 0) || null,
            lastCompletedAt:
              Math.max(fromDb.lastCompletedAt ?? 0, current.lastCompletedAt ?? 0) || null,
            popularity: current.popularity ?? fromDb.popularity,
            popularitySource: current.popularitySource ?? fromDb.popularitySource,
            popularityConfidence:
              current.popularityConfidence ?? fromDb.popularityConfidence,
            externalListeners: current.externalListeners ?? fromDb.externalListeners,
            externalGenres:
              current.externalGenres.length > 0
                ? current.externalGenres
                : fromDb.externalGenres,
            fetchedAt: current.fetchedAt ?? fromDb.fetchedAt,
            expiresAt: current.expiresAt ?? fromDb.expiresAt,
            updatedAt: Math.max(fromDb.updatedAt, current.updatedAt),
          });
        }
      }
      set(state => ({
        byRecordingKey: merged,
        version: state.version + 1,
        loaded: true,
        loading: false,
      }));
    } catch (error) {
      console.warn("[Cadence] Could not load track intelligence:", error);
      set({ loaded: true, loading: false });
    }
  },

  applyTelemetryEvent: event => {
    if (!event || !event.persisted) return null;
    const state = get();
    const existing = state.byRecordingKey.get(event.recordingKey);
    const now = event.timestampMs;

    const updated: TrackIntelligenceRecord = existing
      ? {
          ...existing,
          trackId: event.trackId ?? existing.trackId,
          artist: event.artist || existing.artist,
          title: event.title || existing.title,
          skipCount:
            event.outcome === "skipped" ? existing.skipCount + 1 : existing.skipCount,
          completeCount:
            event.outcome === "completed" ? existing.completeCount + 1 : existing.completeCount,
          lastSkippedAt:
            event.outcome === "skipped" ? now : existing.lastSkippedAt,
          lastCompletedAt:
            event.outcome === "completed" ? now : existing.lastCompletedAt,
          updatedAt: now,
        }
      : {
          recordingKey: event.recordingKey,
          trackId: event.trackId,
          artist: event.artist,
          title: event.title,
          popularity: null,
          popularitySource: null,
          popularityConfidence: null,
          externalListeners: null,
          externalGenres: [],
          fetchedAt: null,
          expiresAt: null,
          skipCount: event.outcome === "skipped" ? 1 : 0,
          completeCount: event.outcome === "completed" ? 1 : 0,
          lastSkippedAt: event.outcome === "skipped" ? now : null,
          lastCompletedAt: event.outcome === "completed" ? now : null,
          updatedAt: now,
        };

    const nextMap = new Map(state.byRecordingKey);
    nextMap.set(updated.recordingKey, updated);
    set({ byRecordingKey: nextMap, version: state.version + 1 });
    schedulePersist(updated);
    return updated;
  },

  upsertRecords: records => {
    if (records.length === 0) return;
    const state = get();
    const nextMap = new Map(state.byRecordingKey);
    for (const incoming of records) {
      const existing = nextMap.get(incoming.recordingKey);
      const merged: TrackIntelligenceRecord = existing
        ? {
            ...existing,
            ...incoming,
            // Never overwrite newer in-memory skip/completion counters when a background popularity fetch lands
            skipCount: Math.max(existing.skipCount, incoming.skipCount),
            completeCount: Math.max(existing.completeCount, incoming.completeCount),
            lastSkippedAt:
              Math.max(existing.lastSkippedAt ?? 0, incoming.lastSkippedAt ?? 0) || null,
            lastCompletedAt:
              Math.max(existing.lastCompletedAt ?? 0, incoming.lastCompletedAt ?? 0) || null,
          }
        : { ...incoming, externalGenres: [...(incoming.externalGenres ?? [])] };
      nextMap.set(merged.recordingKey, merged);
      schedulePersist(merged);
    }
    set({ byRecordingKey: nextMap, version: state.version + 1 });
  },

  resolveTrackPopularity: async (track, config, now = Date.now()) => {
    const recKey = smartRecordingKey(track);
    const existing = get().byRecordingKey.get(recKey);
    const outcome = await defaultPopularityService.resolve(
      {
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationSeconds: track.duration,
        year: track.year,
      },
      config,
      existing,
      { now }
    );
    if (outcome.status === "hit" || outcome.status === "not_found") {
      get().upsertRecords([outcome.record]);
    }
    return outcome;
  },

  prefetchHorizonPopularity: (tracks, config, maxTracks = 8) => {
    if (!config.enabled) return;
    const now = Date.now();
    const state = get();
    const uncached: SmartShuffleTrack[] = [];
    const seenKeys = new Set<string>();
    for (const track of tracks) {
      if (uncached.length >= maxTracks) break;
      const key = smartRecordingKey(track);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      const existing = state.byRecordingKey.get(key);
      if (!isPopularityCacheFresh(existing, now)) {
        uncached.push(track);
      }
    }
    if (uncached.length === 0) return;

    void (async () => {
      for (const track of uncached) {
        if (!config.enabled) break;
        try {
          await get().resolveTrackPopularity(track, config);
        } catch {
          /* background prefetch is strictly best-effort */
        }
      }
    })();
  },

  getCachedIndex: (tracks, historyEntries, now = Date.now()) => {
    const state = get();
    if (
      cachedIndex &&
      cachedIndex.tracksRef === tracks &&
      cachedIndex.trackCount === tracks.length &&
      cachedIndex.intelVersion === state.version &&
      cachedIndex.historyCount === historyEntries.length &&
      Math.abs(now - cachedIndex.builtAt) < 30_000
    ) {
      return cachedIndex.index;
    }
    const index = buildLibraryShuffleIndex(tracks, {
      now,
      intelligenceByKey: state.byRecordingKey,
      historyEntries,
    });
    cachedIndex = {
      tracksRef: tracks,
      trackCount: tracks.length,
      intelVersion: state.version,
      historyCount: historyEntries.length,
      builtAt: now,
      index,
    };
    return index;
  },

  resetForTests: () => {
    cachedIndex = null;
    pendingPersist.clear();
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    set({ byRecordingKey: new Map(), version: 0, loaded: false, loading: false });
  },
}));
