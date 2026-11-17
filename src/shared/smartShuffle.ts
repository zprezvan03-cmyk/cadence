/**
 * Cadence Smart Shuffle & AutoPlay Core Engine.
 *
 * Combines multi-cluster genre compatibility, user listening preference (favorites, play
 * frequency, Bayesian skip/completion ratio, artist affinity, rediscovery), confidence-weighted
 * global popularity, recency cooldowns, and artist/album spacing into a temperature-scaled
 * weighted random sampler.
 *
 * Designed for both small queues and 20,000+ track local libraries using flat typed-array
 * indexing and a two-tier horizon architecture.
 */

import {
  buildLibraryGenreVectors,
  computeGenreCompatibilityFast,
  NUM_GENRE_CLUSTERS,
  normalizeGenreVectorInPlace,
  parseGenreProfile,
  precomputeStepGenreProjection,
  scoreProjectedGenreCompatibility,
  updateGenreSessionState,
} from "./genreCluster";
import type { HistoryEntry } from "./types";

export type ShuffleRng = () => number;

export type QueueOriginKind = "context" | "manual" | "autoplay";

export interface SmartShuffleTrack {
  id: number;
  title: string;
  artist: string;
  albumArtist?: string;
  album: string;
  genre: string;
  duration: number;
  favorite: boolean;
  addedAt: number;
  lastPlayedAt: number | null;
  playCount: number;
  path?: string;
  year?: number | null;
  playable?: boolean;
}

export interface TrackIntelligenceRecord {
  recordingKey: string;
  trackId: number | null;
  artist: string;
  title: string;
  popularity: number | null;
  popularitySource: string | null;
  popularityConfidence: number | null;
  externalListeners: number | null;
  externalGenres: string[];
  fetchedAt: number | null;
  expiresAt: number | null;
  skipCount: number;
  completeCount: number;
  lastSkippedAt: number | null;
  lastCompletedAt: number | null;
  updatedAt: number;
}

export interface SmartShuffleWeights {
  userPreference: number;
  genreCompatibility: number;
  diversity: number;
  popularity: number;
  timeOfDay: number;
}

export const DEFAULT_SMART_SHUFFLE_WEIGHTS: Readonly<SmartShuffleWeights> = {
  userPreference: 0.35,
  genreCompatibility: 0.28,
  diversity: 0.20,
  popularity: 0.12,
  timeOfDay: 0.05,
};

export interface CandidateScoreBreakdown {
  total: number;
  recencyGate: number;
  userPreference: number;
  genreCompatibility: number;
  effectivePopularity: number;
  diversity: number;
  timeOfDay: number;
}

export interface LibraryShuffleIndex {
  readonly trackCount: number;
  readonly trackIds: Int32Array;
  readonly idToIndex: Map<number, number>;
  readonly genreVectors: Float32Array;
  readonly unknownGenreFlags: Uint8Array;
  readonly artistIds: Int32Array;
  readonly albumIds: Int32Array;
  readonly recordingIds: Int32Array;
  readonly basePreference: Float32Array;
  readonly effectivePopularity: Float32Array;
  readonly playCooldown: Float32Array;
  readonly daypartVectors: Float32Array;
  readonly daypartHasSignal: Uint8Array;
  readonly uniqueArtistCount: number;
  readonly uniqueAlbumCount: number;
  readonly uniqueRecordingCount: number;
}

export interface SmartShuffleQueueSlot {
  queueIndex: number;
  trackId: number | null;
  origin?: QueueOriginKind;
}

export interface BuildSmartShuffleOptions {
  rng?: ShuffleRng;
  now?: number;
  weights?: Partial<SmartShuffleWeights>;
  intelligenceByKey?: ReadonlyMap<string, TrackIntelligenceRecord>;
  historyEntries?: readonly HistoryEntry[];
  /** Prebuilt library index when available; built automatically if omitted. */
  libraryIndex?: LibraryShuffleIndex;
  /** Number of upcoming tracks scored with the full dynamic context model (default: 250). */
  activeHorizon?: number;
  /** Candidate shortlist size evaluated per step in the active horizon (default: 64). */
  shortlistSize?: number;
  /** Sampling temperature exponent (default: 2.2). Higher = greedier, lower = more uniform. */
  temperatureExponent?: number;
  /** Recent track IDs already played in the session to seed continuity and avoid repeats. */
  recentPlayedTrackIds?: readonly number[];
  /** Optional current playback order so manual/autoplay segments preserve their exact relative order. */
  existingOrder?: readonly number[];
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Fast, Unicode-safe recording identity key used to deduplicate identical songs across albums
 * or file formats, and to key `track_intelligence` rows in SQLite.
 */
export function smartRecordingKey(input: {
  id?: number;
  title: string;
  artist: string;
  duration?: number;
}): string {
  const cleanPart = (raw: string): string => {
    let s = (raw ?? "").toLowerCase();
    if (s.includes("(")) {
      s = s.replace(/\s*\((?:feat\.?|ft\.?|featuring)\s+[^)]+\)/gi, "");
    }
    if (s.includes("[")) {
      s = s.replace(/\s*\[(?:feat\.?|ft\.?|featuring)\s+[^\]]+\]/gi, "");
    }
    return s
      .replace(/[^\p{L}\p{N}\s()[\]]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  };

  const artist = cleanPart(input.artist);
  const title = cleanPart(input.title);
  if (
    !artist ||
    !title ||
    artist === "unknown artist" ||
    title === "unknown title" ||
    /^(?:track\s*\d+|untitled|audio\s*\d+)$/i.test(title)
  ) {
    return `track:${input.id ?? 0}:${artist}|${title}`;
  }
  const durationBucket =
    typeof input.duration === "number" && Number.isFinite(input.duration) && input.duration > 0
      ? Math.round(input.duration / 3) * 3
      : 0;
  return `${artist}|${title}|${durationBucket}`;
}

/** Maps an hour of day (0..23) to one of 4 dayparts: 0=Morning, 1=Afternoon, 2=Evening, 3=Night. */
export function daypartForTimestamp(timestampMs: number): 0 | 1 | 2 | 3 {
  const hour = new Date(timestampMs).getHours();
  if (hour >= 5 && hour < 11) return 0;
  if (hour >= 11 && hour < 17) return 1;
  if (hour >= 17 && hour < 23) return 2;
  return 3;
}

/**
 * Bayesian-smoothed completion ratio in (0, 1).
 * Unplayed tracks start at 2/3 (~0.67). Completions push it toward 1.0; early skips push it toward 0.05.
 */
export function computeCompletionRatio(completeCount: number, skipCount: number): number {
  const c = Math.max(0, completeCount);
  const s = Math.max(0, skipCount);
  return (c + 2) / (c + s + 3);
}

/**
 * Confidence-weighted popularity shrinkage toward the neutral prior 0.50, attenuated by personal
 * skip behavior so a globally popular track that the user repeatedly skips is never boosted.
 */
export function computeEffectivePopularity(
  popularity: number | null | undefined,
  confidence: number | null | undefined,
  completionRatio: number
): number {
  const rawPop =
    typeof popularity === "number" && Number.isFinite(popularity) ? clamp(popularity, 0, 1) : 0.5;
  const conf =
    typeof confidence === "number" && Number.isFinite(confidence)
      ? clamp(confidence, 0, 1)
      : popularity !== null && popularity !== undefined
        ? 0.7
        : 0.0;

  const shrunk = conf * rawPop + (1 - conf) * 0.5;
  // If the user frequently skips this track (completionRatio < 0.5), attenuate global popularity
  const personalAttenuation = completionRatio < 0.5 ? clamp(completionRatio / 0.5, 0.15, 1.0) : 1.0;
  return clamp(shrunk * personalAttenuation, 0.05, 1.0);
}

/**
 * Builds a compact, typed-array-backed index for a library of tracks.
 * Runs in O(N) time and ~1.8 MB memory for 20,000 tracks.
 */
export function buildLibraryShuffleIndex(
  tracks: readonly SmartShuffleTrack[],
  options: {
    now?: number;
    intelligenceByKey?: ReadonlyMap<string, TrackIntelligenceRecord>;
    historyEntries?: readonly HistoryEntry[];
  } = {}
): LibraryShuffleIndex {
  const n = tracks.length;
  const now = options.now ?? Date.now();
  const intelligenceByKey = options.intelligenceByKey;
  const historyEntries = options.historyEntries ?? [];

  const trackIds = new Int32Array(n);
  const idToIndex = new Map<number, number>();
  const artistIds = new Int32Array(n);
  const albumIds = new Int32Array(n);
  const recordingIds = new Int32Array(n);
  const basePreference = new Float32Array(n);
  const effectivePopularity = new Float32Array(n);
  const playCooldown = new Float32Array(n);

  const artistIntern = new Map<string, number>();
  const albumIntern = new Map<string, number>();
  const recordingIntern = new Map<string, number>();

  const recordingKeys = new Array<string>(n);
  const intelRecords = new Array<TrackIntelligenceRecord | undefined>(n);
  const netPlaysArray = new Float32Array(n);
  const artistPlayTotals = new Map<number, number>();
  const artistFavCounts = new Map<number, number>();

  // Collect recent history counts (last 14 days) per trackId
  const recentHistoryCount = new Map<number, number>();
  const recentCutoff = now - 14 * DAY_MS;
  for (let i = 0; i < historyEntries.length; i++) {
    const entry = historyEntries[i];
    if (entry.source.kind === "local" && entry.playedAt >= recentCutoff) {
      recentHistoryCount.set(
        entry.source.trackId,
        (recentHistoryCount.get(entry.source.trackId) ?? 0) + 1
      );
    }
  }

  for (let i = 0; i < n; i++) {
    const track = tracks[i];
    trackIds[i] = track.id;
    idToIndex.set(track.id, i);

    const artistKey = (track.artist || track.albumArtist || "unknown artist")
      .trim()
      .toLocaleLowerCase();
    let artistId = artistIntern.get(artistKey);
    if (artistId === undefined) {
      artistId = artistIntern.size;
      artistIntern.set(artistKey, artistId);
    }
    artistIds[i] = artistId;

    const albumArtistKey = (track.albumArtist || track.artist || "unknown artist")
      .trim()
      .toLocaleLowerCase();
    const albumNameKey = (track.album || "unknown album").trim().toLocaleLowerCase();
    const albumKey = `${albumArtistKey}\u0000${albumNameKey}`;
    let albumId = albumIntern.get(albumKey);
    if (albumId === undefined) {
      albumId = albumIntern.size;
      albumIntern.set(albumKey, albumId);
    }
    albumIds[i] = albumId;

    const recKey = smartRecordingKey(track);
    recordingKeys[i] = recKey;
    let recId = recordingIntern.get(recKey);
    if (recId === undefined) {
      recId = recordingIntern.size;
      recordingIntern.set(recKey, recId);
    }
    recordingIds[i] = recId;

    const intel = intelligenceByKey?.get(recKey);
    intelRecords[i] = intel;

    const skips = intel?.skipCount ?? 0;
    const completes = intel?.completeCount ?? 0;
    const recentPlays = recentHistoryCount.get(track.id) ?? 0;
    // Discount raw playCount by skips so premature play-start increments from skipped sessions
    // never inflate a track's effective play frequency.
    const netPlays = Math.max(
      0,
      Math.max(0, track.playCount - Math.floor(skips * 0.85)) +
        completes * 0.6 +
        recentPlays * 0.75
    );
    netPlaysArray[i] = netPlays;

    artistPlayTotals.set(artistId, (artistPlayTotals.get(artistId) ?? 0) + netPlays);
    if (track.favorite) {
      artistFavCounts.set(artistId, (artistFavCounts.get(artistId) ?? 0) + 1);
    }
  }

  // Build multi-cluster genre vectors with album/artist/path fallback inference
  const genreInputs = tracks.map((track, idx) => ({
    id: track.id,
    genre: track.genre,
    artist: track.artist,
    albumArtist: track.albumArtist,
    album: track.album,
    path: track.path,
    externalGenres: intelRecords[idx]?.externalGenres ?? null,
  }));
  const { vectors: genreVectors, unknownFlags: unknownGenreFlags } =
    buildLibraryGenreVectors(genreInputs);

  // Compute 95th percentile net play count and max artist affinity for normalization
  let p95PlayCount = 5;
  if (n > 0) {
    const sortedPlays = Float32Array.from(netPlaysArray).sort();
    const p95Index = Math.min(n - 1, Math.floor(n * 0.95));
    p95PlayCount = Math.max(5, sortedPlays[p95Index]);
  }
  const logPlayDenom = Math.log1p(p95PlayCount);

  let maxArtistScore = 3;
  for (const [aId, plays] of artistPlayTotals) {
    const favs = artistFavCounts.get(aId) ?? 0;
    const score = plays + favs * 4;
    if (score > maxArtistScore) maxArtistScore = score;
  }
  const logArtistDenom = Math.log1p(maxArtistScore);

  // Compute per-track static preference, effective popularity, and recency cooldown
  for (let i = 0; i < n; i++) {
    const track = tracks[i];
    const intel = intelRecords[i];
    const skips = intel?.skipCount ?? 0;
    const completes = intel?.completeCount ?? 0;
    const completionRatio = computeCompletionRatio(completes, skips);

    const favBonus = track.favorite ? 0.30 : 0.0;
    const freqScore = clamp(Math.log1p(netPlaysArray[i]) / logPlayDenom, 0, 1);

    const aId = artistIds[i];
    const artistRaw = (artistPlayTotals.get(aId) ?? 0) + (artistFavCounts.get(aId) ?? 0) * 4;
    const artistAffinity = clamp(Math.log1p(artistRaw) / logArtistDenom, 0, 1);

    const lastPlayed = Math.max(track.lastPlayedAt ?? 0, intel?.lastCompletedAt ?? 0);
    const daysSincePlay = lastPlayed > 0 ? (now - lastPlayed) / DAY_MS : Number.POSITIVE_INFINITY;

    let rediscoveryOrExploration = 0;
    if (lastPlayed <= 0 && track.playCount <= 0) {
      // Subtle exploration nudge for unplayed tracks so they surface periodically
      rediscoveryOrExploration = 0.05;
    } else if ((track.favorite || netPlaysArray[i] >= 3) && daysSincePlay >= 30) {
      rediscoveryOrExploration = clamp(0.08 + 0.07 * Math.min(1, (daysSincePlay - 30) / 60), 0, 0.15);
    }

    let recentSkipPenalty = 0;
    if (intel?.lastSkippedAt && intel.lastSkippedAt > 0 && now >= intel.lastSkippedAt) {
      const hoursSinceSkip = (now - intel.lastSkippedAt) / HOUR_MS;
      if (hoursSinceSkip < 24) {
        recentSkipPenalty = 0.25 * Math.exp(-hoursSinceSkip / 6.0);
      }
    }
    if (skips >= 3 && completes === 0) {
      recentSkipPenalty += Math.min(0.25, (skips - 2) * 0.06);
    }

    const pref = clamp(
      favBonus +
        0.25 * freqScore +
        0.25 * completionRatio +
        0.12 * artistAffinity +
        rediscoveryOrExploration -
        recentSkipPenalty,
      0.05,
      1.0
    );
    basePreference[i] = pref;

    effectivePopularity[i] = computeEffectivePopularity(
      intel?.popularity,
      intel?.popularityConfidence,
      completionRatio
    );

    // Soft exponential cooldown based on hours since last play + multiplicative skip suppression
    let cooldown = 1.0;
    if (lastPlayed > 0 && now >= lastPlayed) {
      const hoursSincePlay = (now - lastPlayed) / HOUR_MS;
      cooldown = clamp(1.0 - 0.85 * Math.exp(-hoursSincePlay / 6.0), 0.15, 1.0);
    }
    if (intel?.lastSkippedAt && intel.lastSkippedAt > 0 && now >= intel.lastSkippedAt) {
      const hoursSinceSkip = (now - intel.lastSkippedAt) / HOUR_MS;
      const skipCooldown = clamp(1.0 - 0.80 * Math.exp(-hoursSinceSkip / 12.0), 0.20, 1.0);
      cooldown = Math.min(cooldown, skipCooldown);
    }
    if (completionRatio < 0.5) {
      cooldown *= clamp(completionRatio / 0.5, 0.25, 1.0);
    }
    playCooldown[i] = clamp(cooldown, 0.08, 1.0);
  }

  // Compute daypart genre vectors (4 dayparts x 14 clusters) from listening history
  const daypartVectors = new Float32Array(4 * NUM_GENRE_CLUSTERS);
  const daypartHasSignal = new Uint8Array(4);
  for (let i = 0; i < historyEntries.length; i++) {
    const entry = historyEntries[i];
    if (entry.source.kind !== "local" || !Number.isFinite(entry.playedAt)) continue;
    const idx = idToIndex.get(entry.source.trackId);
    if (idx === undefined || unknownGenreFlags[idx] === 1) continue;
    const dp = daypartForTimestamp(entry.playedAt);
    const dpOffset = dp * NUM_GENRE_CLUSTERS;
    const vecOffset = idx * NUM_GENRE_CLUSTERS;
    for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) {
      daypartVectors[dpOffset + c] += genreVectors[vecOffset + c];
    }
    daypartHasSignal[dp] = 1;
  }
  for (let dp = 0; dp < 4; dp++) {
    if (daypartHasSignal[dp] === 1) {
      const slice = daypartVectors.subarray(
        dp * NUM_GENRE_CLUSTERS,
        (dp + 1) * NUM_GENRE_CLUSTERS
      );
      if (!normalizeGenreVectorInPlace(slice)) {
        daypartHasSignal[dp] = 0;
      }
    }
  }

  return {
    trackCount: n,
    trackIds,
    idToIndex,
    genreVectors,
    unknownGenreFlags,
    artistIds,
    albumIds,
    recordingIds,
    basePreference,
    effectivePopularity,
    playCooldown,
    daypartVectors,
    daypartHasSignal,
    uniqueArtistCount: artistIntern.size,
    uniqueAlbumCount: albumIntern.size,
    uniqueRecordingCount: recordingIntern.size,
  };
}

/**
 * Evaluates the full multi-factor score breakdown for a candidate track index `candIdx`
 * given the current session state. Exported for unit testing and diagnostics.
 */
export function evaluateCandidateBreakdown(
  index: LibraryShuffleIndex,
  candIdx: number,
  session: {
    step: number;
    sessionGenreVector: Float32Array;
    exposureStreaks: Float32Array;
    sessionHasGenre: boolean;
    lastArtistStep: Map<number, number>;
    lastAlbumStep: Map<number, number>;
    lastRecordingStep: Map<number, number>;
    poolArtistCount: number;
    poolAlbumCount: number;
    poolRecordingCount: number;
    currentDaypart: 0 | 1 | 2 | 3;
    weights: SmartShuffleWeights;
    stepProjection?: Float32Array;
    saturatedMask?: Uint8Array;
    freshMask?: Uint8Array;
  }
): CandidateScoreBreakdown {
  const {
    step,
    sessionGenreVector,
    exposureStreaks,
    sessionHasGenre,
    lastArtistStep,
    lastAlbumStep,
    lastRecordingStep,
    poolArtistCount,
    poolAlbumCount,
    poolRecordingCount,
    currentDaypart,
    weights,
    stepProjection,
    saturatedMask,
    freshMask,
  } = session;

  const recId = index.recordingIds[candIdx];
  const prevRecStep = lastRecordingStep.get(recId);
  const recExclusionWindow = Math.min(25, Math.max(1, Math.floor(poolRecordingCount / 2)));

  let recencyGate = index.playCooldown[candIdx];
  if (prevRecStep !== undefined) {
    const dist = step - prevRecStep;
    if (dist <= recExclusionWindow && poolRecordingCount > 1) {
      recencyGate *= 0.02;
    } else {
      recencyGate *= clamp(dist / (recExclusionWindow + 6), 0.15, 1.0);
    }
  }

  const genreCompatibility =
    stepProjection && saturatedMask && freshMask
      ? scoreProjectedGenreCompatibility(
          stepProjection,
          saturatedMask,
          freshMask,
          sessionHasGenre,
          index.genreVectors,
          candIdx * NUM_GENRE_CLUSTERS,
          index.unknownGenreFlags[candIdx] === 1
        )
      : computeGenreCompatibilityFast(
          sessionGenreVector,
          exposureStreaks,
          sessionHasGenre,
          index.genreVectors,
          candIdx * NUM_GENRE_CLUSTERS,
          index.unknownGenreFlags[candIdx] === 1
        );

  // Artist & Album spacing diversity
  let artistSpacing = 1.0;
  if (poolArtistCount > 1) {
    const prevArtistStep = lastArtistStep.get(index.artistIds[candIdx]);
    if (prevArtistStep !== undefined) {
      const dArtist = step - prevArtistStep;
      const relaxFactor = poolArtistCount <= 3 ? 0.55 : 0.0;
      if (dArtist <= 1) artistSpacing = Math.max(relaxFactor, 0.10);
      else if (dArtist === 2) artistSpacing = Math.max(relaxFactor, 0.45);
      else if (dArtist === 3) artistSpacing = Math.max(relaxFactor, 0.80);
    }
  }

  let albumSpacing = 1.0;
  if (poolAlbumCount > 1) {
    const prevAlbumStep = lastAlbumStep.get(index.albumIds[candIdx]);
    if (prevAlbumStep !== undefined) {
      const dAlbum = step - prevAlbumStep;
      const relaxFactor = poolAlbumCount <= 2 ? 0.65 : 0.0;
      if (dAlbum <= 1) albumSpacing = Math.max(relaxFactor, 0.20);
      else if (dAlbum === 2) albumSpacing = Math.max(relaxFactor, 0.55);
    }
  }

  const diversity = 0.70 * artistSpacing + 0.30 * albumSpacing;

  // Time-of-day alignment
  let timeOfDay = 0.5;
  if (
    index.daypartHasSignal[currentDaypart] === 1 &&
    index.unknownGenreFlags[candIdx] === 0
  ) {
    let dot = 0;
    const dpOffset = currentDaypart * NUM_GENRE_CLUSTERS;
    const vecOffset = candIdx * NUM_GENRE_CLUSTERS;
    for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) {
      dot += index.daypartVectors[dpOffset + c] * index.genreVectors[vecOffset + c];
    }
    timeOfDay = clamp(0.35 + 0.65 * dot, 0.2, 1.0);
  }

  const userPreference = index.basePreference[candIdx];
  const effectivePopularity = index.effectivePopularity[candIdx];

  const rawWeighted =
    weights.userPreference * userPreference +
    weights.genreCompatibility * genreCompatibility +
    weights.diversity * diversity +
    weights.popularity * effectivePopularity +
    weights.timeOfDay * timeOfDay;

  // Apply strong multiplicative penalty when the same artist or album just played so even
  // a favorite song does not play back-to-back with the same artist when alternatives exist.
  const spacingGate = artistSpacing < 0.5 ? 0.35 + 0.65 * artistSpacing : 1.0;
  const total = clamp(recencyGate * spacingGate * rawWeighted, 0.005, 1.0);

  return {
    total,
    recencyGate,
    userPreference,
    genreCompatibility,
    effectivePopularity,
    diversity,
    timeOfDay,
  };
}

/**
 * Temperature-scaled weighted random sampling over a candidate buffer of size `count`.
 * Returns the selected position `0 .. count - 1` inside the shortlist.
 */
export function sampleWeightedShortlist(
  weights: Float32Array,
  count: number,
  rng: ShuffleRng
): number {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += weights[i];
  }
  if (sum <= 0) {
    return Math.floor(rng() * count);
  }
  let target = rng() * sum;
  for (let i = 0; i < count - 1; i++) {
    target -= weights[i];
    if (target <= 0) return i;
  }
  return count - 1;
}

/**
 * Orders a queue using Cadence's Smart Shuffle algorithm while strictly enforcing the
 * Queue Partition Invariant:
 *   [ Current Track ] -> [ Manual Entries ] -> [ Smart-Shuffled Context Entries ] -> [ AutoPlay Entries ]
 *
 * Uses a Two-Tier Horizon architecture:
 * - Tier 1 (first `activeHorizon` context tracks): Full dynamic context scoring over a
 *   shortlist of `shortlistSize` candidates per step with O(1) swap-and-pop removal.
 * - Tier 2 (remaining tail tracks on large 20,000+ track libraries): Efraimidis-Spirakis
 *   weighted reservoir keys with artist de-clumping in O(N log N) time.
 */
export function buildSmartShuffleOrder(
  slots: readonly SmartShuffleQueueSlot[],
  currentQueueIndex: number,
  tracks: readonly SmartShuffleTrack[],
  options: BuildSmartShuffleOptions = {}
): number[] {
  const length = slots.length;
  if (length === 0) return [];
  if (length === 1) return [0];

  const rng = options.rng ?? Math.random;
  const now = options.now ?? Date.now();
  const activeHorizon = Math.max(16, options.activeHorizon ?? 250);
  const shortlistSize = Math.max(8, options.shortlistSize ?? 64);
  const gamma = clamp(options.temperatureExponent ?? 2.2, 0.5, 5.0);
  const weights: SmartShuffleWeights = {
    ...DEFAULT_SMART_SHUFFLE_WEIGHTS,
    ...options.weights,
  };

  const index =
    options.libraryIndex ??
    buildLibraryShuffleIndex(tracks, {
      now,
      intelligenceByKey: options.intelligenceByKey,
      historyEntries: options.historyEntries,
    });

  const safeCurrent = clamp(currentQueueIndex, 0, length - 1);

  // Partition all non-current slots by origin priority: manual -> context -> autoplay
  const manualSlots: number[] = [];
  const contextSlots: number[] = [];
  const autoplaySlots: number[] = [];

  const iterationOrder =
    options.existingOrder && options.existingOrder.length === length
      ? options.existingOrder
      : Array.from({ length }, (_, i) => i);

  for (const i of iterationOrder) {
    if (i === safeCurrent || i < 0 || i >= length) continue;
    const origin = slots[i].origin ?? "context";
    if (origin === "manual") {
      manualSlots.push(i);
    } else if (origin === "autoplay") {
      autoplaySlots.push(i);
    } else {
      contextSlots.push(i);
    }
  }

  if (contextSlots.length <= 1) {
    return [safeCurrent, ...manualSlots, ...contextSlots, ...autoplaySlots];
  }

  // Initialize session state from recentPlayedTrackIds + current track + manual prefix
  const sessionGenreVector = new Float32Array(NUM_GENRE_CLUSTERS);
  const exposureStreaks = new Float32Array(NUM_GENRE_CLUSTERS);
  let sessionHasGenre = false;
  let step = 0;

  const lastArtistStep = new Map<number, number>();
  const lastAlbumStep = new Map<number, number>();
  const lastRecordingStep = new Map<number, number>();

  const observeTrackIndex = (libIdx: number | undefined) => {
    if (libIdx === undefined) return;
    sessionHasGenre = updateGenreSessionState(
      sessionGenreVector,
      exposureStreaks,
      sessionHasGenre,
      index.genreVectors,
      libIdx * NUM_GENRE_CLUSTERS,
      index.unknownGenreFlags[libIdx] === 1
    );
    lastArtistStep.set(index.artistIds[libIdx], step);
    lastAlbumStep.set(index.albumIds[libIdx], step);
    lastRecordingStep.set(index.recordingIds[libIdx], step);
    step += 1;
  };

  if (options.recentPlayedTrackIds) {
    for (const tid of options.recentPlayedTrackIds) {
      observeTrackIndex(index.idToIndex.get(tid));
    }
  }

  const currentTrackId = slots[safeCurrent]?.trackId;
  if (currentTrackId !== null && currentTrackId !== undefined) {
    observeTrackIndex(index.idToIndex.get(currentTrackId));
  }
  for (const mSlot of manualSlots) {
    const tid = slots[mSlot]?.trackId;
    if (tid !== null && tid !== undefined) {
      observeTrackIndex(index.idToIndex.get(tid));
    }
  }

  // Build flat candidate pool for contextSlots
  const contextCount = contextSlots.length;
  const poolQueueIndices = new Int32Array(contextCount);
  const poolLibIndices = new Int32Array(contextCount);

  let poolArtistCount = index.uniqueArtistCount;
  let poolAlbumCount = index.uniqueAlbumCount;
  let poolRecordingCount = index.uniqueRecordingCount;

  if (contextCount < index.trackCount * 0.5) {
    const poolArtistSet = new Set<number>();
    const poolAlbumSet = new Set<number>();
    const poolRecordingSet = new Set<number>();
    for (let i = 0; i < contextCount; i++) {
      const qIdx = contextSlots[i];
      poolQueueIndices[i] = qIdx;
      const tid = slots[qIdx].trackId;
      const libIdx = tid !== null && tid !== undefined ? (index.idToIndex.get(tid) ?? -1) : -1;
      poolLibIndices[i] = libIdx;
      if (libIdx >= 0) {
        poolArtistSet.add(index.artistIds[libIdx]);
        poolAlbumSet.add(index.albumIds[libIdx]);
        poolRecordingSet.add(index.recordingIds[libIdx]);
      }
    }
    poolArtistCount = Math.max(1, poolArtistSet.size);
    poolAlbumCount = Math.max(1, poolAlbumSet.size);
    poolRecordingCount = Math.max(1, poolRecordingSet.size);
  } else {
    for (let i = 0; i < contextCount; i++) {
      const qIdx = contextSlots[i];
      poolQueueIndices[i] = qIdx;
      const tid = slots[qIdx].trackId;
      poolLibIndices[i] = tid !== null && tid !== undefined ? (index.idToIndex.get(tid) ?? -1) : -1;
    }
  }
  const currentDaypart = daypartForTimestamp(now);

  const orderedContext: number[] = [];
  let remaining = contextCount;
  const horizonLimit = Math.min(remaining, activeHorizon);

  const shortlistPoolPositions = new Int32Array(shortlistSize);
  const shortlistWeights = new Float32Array(shortlistSize);
  const stepProjection = new Float32Array(NUM_GENRE_CLUSTERS);
  const saturatedMask = new Uint8Array(NUM_GENRE_CLUSTERS);
  const freshMask = new Uint8Array(NUM_GENRE_CLUSTERS);

  const sessionCtx = {
    step,
    sessionGenreVector,
    exposureStreaks,
    sessionHasGenre,
    lastArtistStep,
    lastAlbumStep,
    lastRecordingStep,
    poolArtistCount,
    poolAlbumCount,
    poolRecordingCount,
    currentDaypart,
    weights,
    stepProjection,
    saturatedMask,
    freshMask,
  };

  // Tier 1: Active Horizon dynamic context sampling
  for (let h = 0; h < horizonLimit; h++) {
    sessionCtx.step = step;
    sessionCtx.sessionHasGenre = sessionHasGenre;
    if (sessionHasGenre) {
      precomputeStepGenreProjection(
        sessionGenreVector,
        exposureStreaks,
        stepProjection,
        saturatedMask,
        freshMask
      );
    }

    const kCount = Math.min(remaining, shortlistSize);
    if (remaining <= shortlistSize) {
      for (let k = 0; k < remaining; k++) {
        shortlistPoolPositions[k] = k;
      }
    } else {
      // Partial Fisher-Yates draw of `shortlistSize` candidates from `0 .. remaining - 1`
      for (let k = 0; k < kCount; k++) {
        const pick = k + Math.floor(rng() * (remaining - k));
        // Swap pool element `pick` into `k`
        const tmpQ = poolQueueIndices[k];
        poolQueueIndices[k] = poolQueueIndices[pick];
        poolQueueIndices[pick] = tmpQ;

        const tmpL = poolLibIndices[k];
        poolLibIndices[k] = poolLibIndices[pick];
        poolLibIndices[pick] = tmpL;

        shortlistPoolPositions[k] = k;
      }
    }

    for (let k = 0; k < kCount; k++) {
      const poolPos = shortlistPoolPositions[k];
      const libIdx = poolLibIndices[poolPos];
      if (libIdx < 0) {
        shortlistWeights[k] = Math.pow(0.35, gamma);
      } else {
        const score = evaluateCandidateBreakdown(index, libIdx, sessionCtx).total;
        shortlistWeights[k] = Math.pow(Math.max(0.03, score), gamma);
      }
    }

    const chosenShortlistIdx = sampleWeightedShortlist(shortlistWeights, kCount, rng);
    const chosenPoolPos = shortlistPoolPositions[chosenShortlistIdx];
    const chosenQueueIndex = poolQueueIndices[chosenPoolPos];
    const chosenLibIdx = poolLibIndices[chosenPoolPos];

    orderedContext.push(chosenQueueIndex);

    // Swap-and-pop removal from remaining pool in O(1)
    remaining -= 1;
    if (chosenPoolPos !== remaining) {
      poolQueueIndices[chosenPoolPos] = poolQueueIndices[remaining];
      poolLibIndices[chosenPoolPos] = poolLibIndices[remaining];
    }

    if (chosenLibIdx >= 0) {
      observeTrackIndex(chosenLibIdx);
    } else {
      step += 1;
    }
  }

  // Tier 2: O(N) Stratified Weighted Permutation + Artist De-clumping (when contextCount > activeHorizon)
  if (remaining > 0) {
    // 4 strata ordered from highest to lowest stochastic priority key
    const strata0: number[] = [];
    const strata1: number[] = [];
    const strata2: number[] = [];
    const strata3: number[] = [];

    for (let i = 0; i < remaining; i++) {
      const libIdx = poolLibIndices[i];
      const staticWeight =
        libIdx >= 0
          ? clamp(
              (0.55 * index.basePreference[libIdx] +
                0.25 * index.effectivePopularity[libIdx] +
                0.20 * 0.5) *
                index.playCooldown[libIdx],
              0.05,
              1.0
            )
          : 0.4;
      // Add controlled uniform jitter so every track can cross stratum boundaries probabilistically
      const noisyScore = staticWeight * 0.75 + rng() * 0.25;
      if (noisyScore >= 0.62) strata0.push(i);
      else if (noisyScore >= 0.46) strata1.push(i);
      else if (noisyScore >= 0.30) strata2.push(i);
      else strata3.push(i);
    }

    const shuffleBucket = (arr: number[]) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
    };
    shuffleBucket(strata0);
    shuffleBucket(strata1);
    shuffleBucket(strata2);
    shuffleBucket(strata3);

    const tailIndices = new Int32Array(remaining);
    let offset = 0;
    for (const bucket of [strata0, strata1, strata2, strata3]) {
      for (let i = 0; i < bucket.length; i++) {
        tailIndices[offset++] = bucket[i];
      }
    }

    // Single-pass local artist de-clumping on the tail
    let prevArtistId =
      orderedContext.length > 0
        ? (() => {
            const lastQ = orderedContext[orderedContext.length - 1];
            const tid = slots[lastQ].trackId;
            const lIdx = tid !== null && tid !== undefined ? index.idToIndex.get(tid) : undefined;
            return lIdx !== undefined ? index.artistIds[lIdx] : -1;
          })()
        : -1;

    for (let i = 0; i < remaining; i++) {
      let poolPos = tailIndices[i];
      let libIdx = poolLibIndices[poolPos];
      if (libIdx >= 0 && index.artistIds[libIdx] === prevArtistId && i + 1 < remaining) {
        // Look ahead up to 6 slots for a different artist to avoid back-to-back tail collisions
        for (let look = i + 1; look < Math.min(remaining, i + 7); look++) {
          const altPoolPos = tailIndices[look];
          const altLibIdx = poolLibIndices[altPoolPos];
          if (altLibIdx < 0 || index.artistIds[altLibIdx] !== prevArtistId) {
            tailIndices[look] = poolPos;
            poolPos = altPoolPos;
            libIdx = altLibIdx;
            tailIndices[i] = poolPos;
            break;
          }
        }
      }
      orderedContext.push(poolQueueIndices[poolPos]);
      if (libIdx >= 0) prevArtistId = index.artistIds[libIdx];
    }
  }

  return [safeCurrent, ...manualSlots, ...orderedContext, ...autoplaySlots];
}

export interface SelectAutoPlayOptions extends BuildSmartShuffleOptions {
  /** Number of AutoPlay tracks to generate (default: 5). */
  count?: number;
  /** Track IDs currently in the queue or recently played that should be excluded when possible. */
  excludeTrackIds?: ReadonlySet<number>;
  /** Ordered seed track IDs representing the current listening context (most recent last). */
  seedTrackIds?: readonly number[];
}

/**
 * Selects upcoming AutoPlay track IDs from the library that continue the genre and mood of
 * `seedTrackIds` while avoiding immediate artist/recording repetitions.
 */
export function selectAutoPlayTracks(
  tracks: readonly SmartShuffleTrack[],
  options: SelectAutoPlayOptions = {}
): number[] {
  const count = Math.max(1, options.count ?? 5);
  const playableTracks = tracks.filter(t => t.playable !== false);
  if (playableTracks.length === 0) return [];

  const rng = options.rng ?? Math.random;
  const now = options.now ?? Date.now();
  const shortlistSize = Math.max(16, options.shortlistSize ?? 96);
  const gamma = clamp(options.temperatureExponent ?? 2.4, 0.5, 5.0);
  const weights: SmartShuffleWeights = {
    ...DEFAULT_SMART_SHUFFLE_WEIGHTS,
    // In AutoPlay, genre continuity is slightly boosted so transitions feel seamless
    genreCompatibility: 0.34,
    userPreference: 0.32,
    diversity: 0.18,
    popularity: 0.11,
    timeOfDay: 0.05,
    ...options.weights,
  };

  const index =
    options.libraryIndex && options.libraryIndex.trackCount === playableTracks.length
      ? options.libraryIndex
      : buildLibraryShuffleIndex(playableTracks, {
          now,
          intelligenceByKey: options.intelligenceByKey,
          historyEntries: options.historyEntries,
        });

  const sessionGenreVector = new Float32Array(NUM_GENRE_CLUSTERS);
  const exposureStreaks = new Float32Array(NUM_GENRE_CLUSTERS);
  let sessionHasGenre = false;
  let step = 0;

  const lastArtistStep = new Map<number, number>();
  const lastAlbumStep = new Map<number, number>();
  const lastRecordingStep = new Map<number, number>();
  const excludedRecordingIds = new Set<number>();

  const observeSeed = (tid: number) => {
    const libIdx = index.idToIndex.get(tid);
    if (libIdx === undefined) return;
    sessionHasGenre = updateGenreSessionState(
      sessionGenreVector,
      exposureStreaks,
      sessionHasGenre,
      index.genreVectors,
      libIdx * NUM_GENRE_CLUSTERS,
      index.unknownGenreFlags[libIdx] === 1
    );
    lastArtistStep.set(index.artistIds[libIdx], step);
    lastAlbumStep.set(index.albumIds[libIdx], step);
    lastRecordingStep.set(index.recordingIds[libIdx], step);
    excludedRecordingIds.add(index.recordingIds[libIdx]);
    step += 1;
  };

  if (options.recentPlayedTrackIds) {
    for (const tid of options.recentPlayedTrackIds) observeSeed(tid);
  }
  if (options.seedTrackIds) {
    for (const tid of options.seedTrackIds) observeSeed(tid);
  }

  const excludeTrackIds = options.excludeTrackIds ?? new Set<number>();
  for (const tid of excludeTrackIds) {
    const libIdx = index.idToIndex.get(tid);
    if (libIdx !== undefined) {
      excludedRecordingIds.add(index.recordingIds[libIdx]);
    }
  }

  // Build candidate pool of non-excluded tracks; if library is smaller than exclusion set,
  // fall back to all playable tracks except the very last seed track.
  const lastSeedId =
    options.seedTrackIds && options.seedTrackIds.length > 0
      ? options.seedTrackIds[options.seedTrackIds.length - 1]
      : null;

  let candidateIndices: number[] = [];
  for (let i = 0; i < index.trackCount; i++) {
    const tid = index.trackIds[i];
    if (excludeTrackIds.has(tid) || excludedRecordingIds.has(index.recordingIds[i])) continue;
    candidateIndices.push(i);
  }
  if (candidateIndices.length === 0) {
    for (let i = 0; i < index.trackCount; i++) {
      if (index.trackIds[i] !== lastSeedId && index.trackCount > 1) {
        candidateIndices.push(i);
      }
    }
    if (candidateIndices.length === 0 && index.trackCount > 0) {
      candidateIndices.push(0);
    }
  }

  const pool = Int32Array.from(candidateIndices);
  let remaining = pool.length;
  const targetCount = Math.min(count, remaining);
  const selectedIds: number[] = [];

  const shortlistPositions = new Int32Array(shortlistSize);
  const shortlistWeights = new Float32Array(shortlistSize);
  const stepProjection = new Float32Array(NUM_GENRE_CLUSTERS);
  const saturatedMask = new Uint8Array(NUM_GENRE_CLUSTERS);
  const freshMask = new Uint8Array(NUM_GENRE_CLUSTERS);
  const currentDaypart = daypartForTimestamp(now);

  const sessionCtx = {
    step,
    sessionGenreVector,
    exposureStreaks,
    sessionHasGenre,
    lastArtistStep,
    lastAlbumStep,
    lastRecordingStep,
    poolArtistCount: index.uniqueArtistCount,
    poolAlbumCount: index.uniqueAlbumCount,
    poolRecordingCount: index.uniqueRecordingCount,
    currentDaypart,
    weights,
    stepProjection,
    saturatedMask,
    freshMask,
  };

  for (let pickIdx = 0; pickIdx < targetCount && remaining > 0; pickIdx++) {
    sessionCtx.step = step;
    sessionCtx.sessionHasGenre = sessionHasGenre;
    if (sessionHasGenre) {
      precomputeStepGenreProjection(
        sessionGenreVector,
        exposureStreaks,
        stepProjection,
        saturatedMask,
        freshMask
      );
    }

    const kCount = Math.min(remaining, shortlistSize);
    if (remaining <= shortlistSize) {
      for (let k = 0; k < remaining; k++) shortlistPositions[k] = k;
    } else {
      for (let k = 0; k < kCount; k++) {
        const pick = k + Math.floor(rng() * (remaining - k));
        const tmp = pool[k];
        pool[k] = pool[pick];
        pool[pick] = tmp;
        shortlistPositions[k] = k;
      }
    }

    for (let k = 0; k < kCount; k++) {
      const libIdx = pool[shortlistPositions[k]];
      const score = evaluateCandidateBreakdown(index, libIdx, sessionCtx).total;
      shortlistWeights[k] = Math.pow(Math.max(0.03, score), gamma);
    }

    const chosenShortlist = sampleWeightedShortlist(shortlistWeights, kCount, rng);
    const chosenPoolPos = shortlistPositions[chosenShortlist];
    const chosenLibIdx = pool[chosenPoolPos];

    selectedIds.push(index.trackIds[chosenLibIdx]);

    remaining -= 1;
    if (chosenPoolPos !== remaining) {
      pool[chosenPoolPos] = pool[remaining];
    }

    observeSeed(index.trackIds[chosenLibIdx]);
  }

  return selectedIds;
}

export { parseGenreProfile };
