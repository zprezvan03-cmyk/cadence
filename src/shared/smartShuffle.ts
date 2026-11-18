/**
 * Cadence Smart Shuffle & AutoPlay Core Engine.
 *
 * Prioritizes musical relevance before popularity:
 * 1. Multi-cluster genre distributions (never collapsing a track to a single macro genre).
 * 2. Hard genre relevance gating BEFORE weighted random selection, with gradual safe
 *    threshold relaxation (Primary -> Relaxed neighbor -> Incomplete metadata fallback)
 *    that never silently falls back to confidently incompatible tracks.
 * 3. Popularity strictly as a secondary ranking signal among compatible candidates.
 * 4. Structured explainability & diagnostics for selected and rejected candidates.
 * 5. Flat typed-array indexing and two-tier horizon architecture for 20,000+ track libraries.
 */

import {
  buildLibraryGenreVectors,
  computeGenreCompatibilityFast,
  GENRE_CLUSTERS,
  NEUTRAL_UNKNOWN_GENRE_COMPATIBILITY,
  NUM_GENRE_CLUSTERS,
  normalizeGenreVectorInPlace,
  parseGenreProfile,
  precomputeStepGenreProjection,
  scoreProjectedGenreCompatibility,
  updateGenreSessionState,
  type GenreCluster,
} from "./genreCluster";
import type { HistoryEntry } from "./types";

export type ShuffleRng = () => number;

export type QueueOriginKind = "context" | "manual" | "autoplay";

/** Default primary minimum genre compatibility threshold for candidate admission. */
export const DEFAULT_MIN_GENRE_COMPATIBILITY = 0.52;

/** Safe lower limit when gradually relaxing the genre threshold for small/sparse pools. */
export const DEFAULT_RELAXED_GENRE_COMPATIBILITY = 0.44;

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
  genreCompatibility: 0.38,
  userPreference: 0.32,
  diversity: 0.18,
  popularity: 0.08,
  timeOfDay: 0.04,
};

export interface CandidateScoreBreakdown {
  total: number;
  recencyGate: number;
  userPreference: number;
  genreCompatibility: number;
  effectivePopularity: number;
  diversity: number;
  timeOfDay: number;
  relevanceThreshold: number;
  passedRelevanceGate: boolean;
}

export interface ClusterWeightSummary {
  cluster: GenreCluster;
  weight: number;
}

export type CandidateDecisionReason =
  | "selected-primary-gate"
  | "selected-relaxed-gate"
  | "selected-incomplete-metadata-fallback"
  | "selected-seed-genre-unknown"
  | "eligible-not-sampled"
  | "rejected-below-genre-threshold"
  | "rejected-duplicate-recording"
  | "rejected-excluded-track";

export interface CandidateDiagnosticEntry {
  currentTrack: {
    id: number | null;
    title: string;
    artist: string;
    genre: string;
    clusters: ClusterWeightSummary[];
  };
  candidateTrack: {
    id: number;
    title: string;
    artist: string;
    genre: string;
    clusters: ClusterWeightSummary[];
    isUnknownGenre: boolean;
  };
  genreCompatibility: number;
  relevanceThreshold: number;
  passedRelevanceGate: boolean;
  popularity: number | null;
  popularityConfidence: number | null;
  effectivePopularity: number;
  userPreference: number;
  diversity: number;
  finalScore: number;
  decision: "selected" | "eligible" | "rejected";
  reason: CandidateDecisionReason;
  explanation: string;
}

export type RelevanceRelaxationStage =
  | "primary"
  | "relaxed"
  | "incomplete-metadata"
  | "seed-unknown"
  | "no-compatible-candidates";

export interface RecommendationDiagnosticsReport {
  mode: "autoplay" | "smart-shuffle";
  timestampMs: number;
  currentTrack: {
    id: number | null;
    title: string;
    artist: string;
    genre: string;
    clusters: ClusterWeightSummary[];
  };
  primaryThreshold: number;
  relaxedThreshold: number;
  activeThresholdUsed: number;
  relaxationStage: RelevanceRelaxationStage;
  totalCandidatesEvaluated: number;
  compatibleCandidateCount: number;
  rejectedIncompatibleCount: number;
  selectedTrackIds: number[];
  /** Where the genre profile for this batch came from (`none` = no usable user-authored queue). */
  anchorSource?: "manual-queue" | "seed-track" | "none";
  /** Number of known-genre user-authored queue tracks folded into the anchor. */
  anchorTrackCount?: number;
  /** The anchor's cluster distribution (empty when the anchor is `none`). */
  anchorClusters?: ClusterWeightSummary[];
  noCompatibleCandidatesReason: string | null;
  /** Structured diagnostics for selected candidates. */
  selectedDiagnostics: CandidateDiagnosticEntry[];
  /** Bounded sample of rejected candidates (ordered by highest popularity/preference first). */
  rejectedDiagnostics: CandidateDiagnosticEntry[];
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
  readonly rawPopularity: Float32Array;
  readonly popularityConfidence: Float32Array;
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
  /** Primary minimum genre compatibility threshold (default: 0.52). */
  minGenreCompatibility?: number;
  /** Safe lower bound when gradually relaxing the genre threshold (default: 0.44). */
  relaxedGenreCompatibility?: number;
  /** Optional callback receiving structured diagnostics without logging the entire library. */
  onDiagnostics?: (report: RecommendationDiagnosticsReport) => void;
  /** Maximum number of rejected candidate entries retained in diagnostics (default: 20). */
  maxDiagnosticEntries?: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function summarizeGenreVector(
  vectors: Float32Array,
  offset = 0,
  minWeight = 0.05,
): ClusterWeightSummary[] {
  const out: ClusterWeightSummary[] = [];
  for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) {
    const w = vectors[offset + c];
    if (w >= minWeight) {
      out.push({
        cluster: GENRE_CLUSTERS[c],
        weight: Number(w.toFixed(3)),
      });
    }
  }
  out.sort((a, b) => b.weight - a.weight);
  return out;
}

function formatClusterSummary(
  clusters: readonly ClusterWeightSummary[],
): string {
  if (clusters.length === 0) return "unknown";
  return clusters.map((c) => `${c.cluster}:${c.weight.toFixed(2)}`).join(", ");
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
    typeof input.duration === "number" &&
    Number.isFinite(input.duration) &&
    input.duration > 0
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
export function computeCompletionRatio(
  completeCount: number,
  skipCount: number,
): number {
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
  completionRatio: number,
): number {
  const rawPop =
    typeof popularity === "number" && Number.isFinite(popularity)
      ? clamp(popularity, 0, 1)
      : 0.5;
  const conf =
    typeof confidence === "number" && Number.isFinite(confidence)
      ? clamp(confidence, 0, 1)
      : popularity !== null && popularity !== undefined
        ? 0.7
        : 0.0;

  const shrunk = conf * rawPop + (1 - conf) * 0.5;
  // If the user frequently skips this track (completionRatio < 0.5), attenuate global popularity
  const personalAttenuation =
    completionRatio < 0.5 ? clamp(completionRatio / 0.5, 0.15, 1.0) : 1.0;
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
  } = {},
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
  const rawPopularity = new Float32Array(n);
  const popularityConfidence = new Float32Array(n);
  const playCooldown = new Float32Array(n);
  rawPopularity.fill(-1);
  popularityConfidence.fill(-1);

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
        (recentHistoryCount.get(entry.source.trackId) ?? 0) + 1,
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

    const albumArtistKey = (
      track.albumArtist ||
      track.artist ||
      "unknown artist"
    )
      .trim()
      .toLocaleLowerCase();
    const albumNameKey = (track.album || "unknown album")
      .trim()
      .toLocaleLowerCase();
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
        recentPlays * 0.75,
    );
    netPlaysArray[i] = netPlays;

    artistPlayTotals.set(
      artistId,
      (artistPlayTotals.get(artistId) ?? 0) + netPlays,
    );
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

    const favBonus = track.favorite ? 0.3 : 0.0;
    const freqScore = clamp(Math.log1p(netPlaysArray[i]) / logPlayDenom, 0, 1);

    const aId = artistIds[i];
    const artistRaw =
      (artistPlayTotals.get(aId) ?? 0) + (artistFavCounts.get(aId) ?? 0) * 4;
    const artistAffinity = clamp(Math.log1p(artistRaw) / logArtistDenom, 0, 1);

    const lastPlayed = Math.max(
      track.lastPlayedAt ?? 0,
      intel?.lastCompletedAt ?? 0,
    );
    const daysSincePlay =
      lastPlayed > 0 ? (now - lastPlayed) / DAY_MS : Number.POSITIVE_INFINITY;

    let rediscoveryOrExploration = 0;
    if (lastPlayed <= 0 && track.playCount <= 0) {
      // Subtle exploration nudge for unplayed tracks so they surface periodically
      rediscoveryOrExploration = 0.05;
    } else if (
      (track.favorite || netPlaysArray[i] >= 3) &&
      daysSincePlay >= 30
    ) {
      rediscoveryOrExploration = clamp(
        0.08 + 0.07 * Math.min(1, (daysSincePlay - 30) / 60),
        0,
        0.15,
      );
    }

    let recentSkipPenalty = 0;
    if (
      intel?.lastSkippedAt &&
      intel.lastSkippedAt > 0 &&
      now >= intel.lastSkippedAt
    ) {
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
      1.0,
    );
    basePreference[i] = pref;

    if (
      typeof intel?.popularity === "number" &&
      Number.isFinite(intel.popularity)
    ) {
      rawPopularity[i] = clamp(intel.popularity, 0, 1);
    }
    if (
      typeof intel?.popularityConfidence === "number" &&
      Number.isFinite(intel.popularityConfidence)
    ) {
      popularityConfidence[i] = clamp(intel.popularityConfidence, 0, 1);
    }

    effectivePopularity[i] = computeEffectivePopularity(
      intel?.popularity,
      intel?.popularityConfidence,
      completionRatio,
    );

    // Soft exponential cooldown based on hours since last play + multiplicative skip suppression
    let cooldown = 1.0;
    if (lastPlayed > 0 && now >= lastPlayed) {
      const hoursSincePlay = (now - lastPlayed) / HOUR_MS;
      cooldown = clamp(1.0 - 0.85 * Math.exp(-hoursSincePlay / 6.0), 0.15, 1.0);
    }
    if (
      intel?.lastSkippedAt &&
      intel.lastSkippedAt > 0 &&
      now >= intel.lastSkippedAt
    ) {
      const hoursSinceSkip = (now - intel.lastSkippedAt) / HOUR_MS;
      const skipCooldown = clamp(
        1.0 - 0.8 * Math.exp(-hoursSinceSkip / 12.0),
        0.2,
        1.0,
      );
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
    if (entry.source.kind !== "local" || !Number.isFinite(entry.playedAt))
      continue;
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
        (dp + 1) * NUM_GENRE_CLUSTERS,
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
    rawPopularity,
    popularityConfidence,
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
 * given the current session state.
 *
 * Enforces the Relevance Gate:
 * - Secondary ranking signals (`userPreference`, `effectivePopularity`, `diversity`, `timeOfDay`)
 *   are scaled by `genreCompatibility`, so popularity can rank among compatible candidates
 *   but can NEVER override a failed genre relevance gate.
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
    relevanceThreshold?: number;
    stepProjection?: Float32Array;
    saturatedMask?: Uint8Array;
    freshMask?: Uint8Array;
    sessionIsFocused?: boolean;
  },
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
    sessionIsFocused,
  } = session;

  const relevanceThreshold =
    session.relevanceThreshold ?? DEFAULT_RELAXED_GENRE_COMPATIBILITY;

  const recId = index.recordingIds[candIdx];
  const prevRecStep = lastRecordingStep.get(recId);
  const recExclusionWindow = Math.min(
    25,
    Math.max(1, Math.floor(poolRecordingCount / 2)),
  );

  let recencyGate = index.playCooldown[candIdx];
  if (prevRecStep !== undefined) {
    const dist = step - prevRecStep;
    if (dist <= recExclusionWindow && poolRecordingCount > 1) {
      recencyGate *= 0.02;
    } else {
      recencyGate *= clamp(dist / (recExclusionWindow + 6), 0.15, 1.0);
    }
  }

  const candidateIsUnknown = index.unknownGenreFlags[candIdx] === 1;
  const genreCompatibility =
    stepProjection && saturatedMask && freshMask
      ? scoreProjectedGenreCompatibility(
          stepProjection,
          saturatedMask,
          freshMask,
          sessionHasGenre,
          index.genreVectors,
          candIdx * NUM_GENRE_CLUSTERS,
          candidateIsUnknown,
          sessionIsFocused ?? true,
          sessionGenreVector,
        )
      : computeGenreCompatibilityFast(
          sessionGenreVector,
          exposureStreaks,
          sessionHasGenre,
          index.genreVectors,
          candIdx * NUM_GENRE_CLUSTERS,
          candidateIsUnknown,
        );

  const passedRelevanceGate =
    !sessionHasGenre || genreCompatibility >= relevanceThreshold;

  // Artist & Album spacing diversity
  let artistSpacing = 1.0;
  if (poolArtistCount > 1) {
    const prevArtistStep = lastArtistStep.get(index.artistIds[candIdx]);
    if (prevArtistStep !== undefined) {
      const dArtist = step - prevArtistStep;
      const relaxFactor = poolArtistCount <= 2 ? 0.35 : 0.0;
      if (dArtist <= 1) artistSpacing = Math.max(relaxFactor, 0.08);
      else if (dArtist === 2) artistSpacing = Math.max(relaxFactor, 0.42);
      else if (dArtist === 3) artistSpacing = Math.max(relaxFactor, 0.8);
    }
  }

  let albumSpacing = 1.0;
  if (poolAlbumCount > 1) {
    const prevAlbumStep = lastAlbumStep.get(index.albumIds[candIdx]);
    if (prevAlbumStep !== undefined) {
      const dAlbum = step - prevAlbumStep;
      const relaxFactor = poolAlbumCount <= 2 ? 0.65 : 0.0;
      if (dAlbum <= 1) albumSpacing = Math.max(relaxFactor, 0.2);
      else if (dAlbum === 2) albumSpacing = Math.max(relaxFactor, 0.55);
    }
  }

  const diversity = 0.7 * artistSpacing + 0.3 * albumSpacing;

  // Time-of-day alignment
  let timeOfDay = 0.5;
  if (index.daypartHasSignal[currentDaypart] === 1 && !candidateIsUnknown) {
    let dot = 0;
    const dpOffset = currentDaypart * NUM_GENRE_CLUSTERS;
    const vecOffset = candIdx * NUM_GENRE_CLUSTERS;
    for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) {
      dot +=
        index.daypartVectors[dpOffset + c] * index.genreVectors[vecOffset + c];
    }
    timeOfDay = clamp(0.35 + 0.65 * dot, 0.2, 1.0);
  }

  const userPreference = index.basePreference[candIdx];
  const effectivePopularity = index.effectivePopularity[candIdx];

  // Secondary terms are modulated by genreRelevanceMultiplier so popularity/preference/diversity
  // only differentiate compatible candidates and can never rescue an incompatible candidate.
  const genreRelevanceMultiplier = sessionHasGenre
    ? clamp(0.25 + 0.75 * genreCompatibility, 0.25, 1.0)
    : 1.0;

  const secondarySum =
    weights.userPreference * userPreference +
    weights.diversity * diversity +
    weights.popularity * effectivePopularity +
    weights.timeOfDay * timeOfDay;

  const rawWeighted =
    weights.genreCompatibility * genreCompatibility +
    genreRelevanceMultiplier * secondarySum;

  // Apply strong multiplicative penalty when the candidate fails the relevance gate
  const relevanceGateMultiplier = passedRelevanceGate
    ? 1.0
    : Math.pow(
        clamp(
          genreCompatibility / Math.max(0.1, relevanceThreshold),
          0.05,
          0.9,
        ),
        3,
      ) * 0.12;

  // Apply strong multiplicative penalty when the same artist or album just played so even
  // a favorite song does not play back-to-back with the same artist when alternatives exist.
  const spacingGate = artistSpacing < 0.5 ? 0.35 + 0.65 * artistSpacing : 1.0;
  const total = clamp(
    recencyGate * spacingGate * relevanceGateMultiplier * rawWeighted,
    0.001,
    1.0,
  );

  return {
    total,
    recencyGate,
    userPreference,
    genreCompatibility,
    effectivePopularity,
    diversity,
    timeOfDay,
    relevanceThreshold,
    passedRelevanceGate,
  };
}

/**
 * Temperature-scaled weighted random sampling over a candidate buffer of size `count`.
 * Returns the selected position `0 .. count - 1` inside the shortlist.
 */
export function sampleWeightedShortlist(
  weights: Float32Array,
  count: number,
  rng: ShuffleRng,
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
 * Initializes the session genre vector from the current/seed track(s), anchoring strongly to the
 * active seed track and ignoring historical tracks that belong to a completely different genre
 * (so a manual genre switch by the listener immediately pivots the recommendation context).
 */
function initializeAnchoredSessionGenreState(
  index: LibraryShuffleIndex,
  seedLibIndices: readonly number[],
  recentLibIndices: readonly number[],
  sessionGenreVector: Float32Array,
  exposureStreaks: Float32Array,
  relaxedThreshold: number,
): boolean {
  sessionGenreVector.fill(0);
  exposureStreaks.fill(0);

  // Find the most recent known-genre seed track as the anchor
  let anchorLibIdx = -1;
  for (let i = seedLibIndices.length - 1; i >= 0; i--) {
    const idx = seedLibIndices[i];
    if (idx >= 0 && index.unknownGenreFlags[idx] === 0) {
      anchorLibIdx = idx;
      break;
    }
  }
  if (anchorLibIdx < 0) {
    for (let i = recentLibIndices.length - 1; i >= 0; i--) {
      const idx = recentLibIndices[i];
      if (idx >= 0 && index.unknownGenreFlags[idx] === 0) {
        anchorLibIdx = idx;
        break;
      }
    }
  }

  if (anchorLibIdx < 0) {
    return false;
  }

  const anchorVec = index.genreVectors.subarray(
    anchorLibIdx * NUM_GENRE_CLUSTERS,
    (anchorLibIdx + 1) * NUM_GENRE_CLUSTERS,
  );
  const zeroStreaks = new Float32Array(NUM_GENRE_CLUSTERS);
  let sessionHasGenre = false;

  // Only include up to 3 recent/seed tracks before the anchor if they are genre-compatible with the anchor
  const combinedHistory = [...recentLibIndices.slice(-3), ...seedLibIndices];
  for (const idx of combinedHistory) {
    if (idx < 0 || index.unknownGenreFlags[idx] === 1) continue;
    if (idx !== anchorLibIdx) {
      const compatWithAnchor = computeGenreCompatibilityFast(
        anchorVec,
        zeroStreaks,
        true,
        index.genreVectors,
        idx * NUM_GENRE_CLUSTERS,
        false,
      );
      if (compatWithAnchor < relaxedThreshold) {
        // User switched away from this older genre; do not let it contaminate the current track's context
        continue;
      }
    }
    sessionHasGenre = updateGenreSessionState(
      sessionGenreVector,
      exposureStreaks,
      sessionHasGenre,
      index.genreVectors,
      idx * NUM_GENRE_CLUSTERS,
      false,
      idx === anchorLibIdx ? 0.72 : 0.45,
    );
  }

  return sessionHasGenre;
}

/**
 * Builds the **collective** genre profile of a queue: the mean cluster distribution of the given
 * tracks, one unit of weight per track.
 *
 * Uniform weights are deliberate. A genre vector is already a probability distribution over
 * clusters, so the mean is a mixture that answers "what share of the queue sounds like X" - the
 * natural aggregation for a queue, and the only one that does not let an arbitrarily long track
 * (or an arbitrary queue position) outvote the rest. Duration weighting would bias the profile by
 * track length; recency weighting would reintroduce the drift this exists to remove.
 *
 * Tracks with unknown genre are skipped (they carry no evidence). The result is written to `out`,
 * which is zeroed first; the return value is the number of tracks that contributed, so callers can
 * distinguish "no queue" from "queue with no genre metadata".
 */
export function buildQueueAnchorGenreVector(
  index: LibraryShuffleIndex,
  trackIds: readonly number[],
  out: Float32Array,
): number {
  out.fill(0);
  let contributing = 0;
  for (const trackId of trackIds) {
    const libIdx = index.idToIndex.get(trackId);
    if (libIdx === undefined) continue;
    if (index.unknownGenreFlags[libIdx] === 1) continue;
    const offset = libIdx * NUM_GENRE_CLUSTERS;
    let hasMass = false;
    for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) {
      const weight = index.genreVectors[offset + c];
      if (weight <= 0) continue;
      out[c] += weight;
      hasMass = true;
    }
    if (hasMass) contributing += 1;
  }
  if (contributing > 0) {
    for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) out[c] /= contributing;
  }
  return contributing;
}

/**
 * Orders a queue using Cadence's Smart Shuffle algorithm while strictly enforcing:
 * 1. Queue Partition Invariant:
 *    [ Current Track ] -> [ Manual Entries ] -> [ Smart-Shuffled Context Entries ] -> [ AutoPlay Entries ]
 * 2. Genre Relevance Gating:
 *    Compatible candidates (>= minGenreCompatibility, then >= relaxedGenreCompatibility, then
 *    incomplete metadata) are always prioritized ahead of incompatible candidates before
 *    weighted random sampling.
 */
export function buildSmartShuffleOrder(
  slots: readonly SmartShuffleQueueSlot[],
  currentQueueIndex: number,
  tracks: readonly SmartShuffleTrack[],
  options: BuildSmartShuffleOptions = {},
): number[] {
  const length = slots.length;
  if (length === 0) return [];
  if (length === 1) return [0];

  const rng = options.rng ?? Math.random;
  const now = options.now ?? Date.now();
  const activeHorizon = Math.max(16, options.activeHorizon ?? 250);
  const shortlistSize = Math.max(8, options.shortlistSize ?? 64);
  const gamma = clamp(options.temperatureExponent ?? 2.2, 0.5, 5.0);
  const minGenreCompatibility = clamp(
    options.minGenreCompatibility ?? DEFAULT_MIN_GENRE_COMPATIBILITY,
    0.2,
    0.95,
  );
  const relaxedGenreCompatibility = clamp(
    options.relaxedGenreCompatibility ?? DEFAULT_RELAXED_GENRE_COMPATIBILITY,
    0.15,
    minGenreCompatibility,
  );
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

  const sessionGenreVector = new Float32Array(NUM_GENRE_CLUSTERS);
  const exposureStreaks = new Float32Array(NUM_GENRE_CLUSTERS);
  let step = 0;

  const lastArtistStep = new Map<number, number>();
  const lastAlbumStep = new Map<number, number>();
  const lastRecordingStep = new Map<number, number>();

  const recentLibIndices: number[] = [];
  if (options.recentPlayedTrackIds) {
    for (const tid of options.recentPlayedTrackIds) {
      const libIdx = index.idToIndex.get(tid);
      if (libIdx !== undefined) {
        recentLibIndices.push(libIdx);
        lastArtistStep.set(index.artistIds[libIdx], step);
        lastAlbumStep.set(index.albumIds[libIdx], step);
        lastRecordingStep.set(index.recordingIds[libIdx], step);
        step += 1;
      }
    }
  }

  const seedLibIndices: number[] = [];
  const currentTrackId = slots[safeCurrent]?.trackId;
  if (currentTrackId !== null && currentTrackId !== undefined) {
    const libIdx = index.idToIndex.get(currentTrackId);
    if (libIdx !== undefined) {
      seedLibIndices.push(libIdx);
      lastArtistStep.set(index.artistIds[libIdx], step);
      lastAlbumStep.set(index.albumIds[libIdx], step);
      lastRecordingStep.set(index.recordingIds[libIdx], step);
      step += 1;
    }
  }
  for (const mSlot of manualSlots) {
    const tid = slots[mSlot]?.trackId;
    if (tid !== null && tid !== undefined) {
      const libIdx = index.idToIndex.get(tid);
      if (libIdx !== undefined) {
        seedLibIndices.push(libIdx);
        lastArtistStep.set(index.artistIds[libIdx], step);
        lastAlbumStep.set(index.albumIds[libIdx], step);
        lastRecordingStep.set(index.recordingIds[libIdx], step);
        step += 1;
      }
    }
  }

  let sessionHasGenre = initializeAnchoredSessionGenreState(
    index,
    seedLibIndices,
    recentLibIndices,
    sessionGenreVector,
    exposureStreaks,
    relaxedGenreCompatibility,
  );

  const observeSelectedTrack = (libIdx: number) => {
    sessionHasGenre = updateGenreSessionState(
      sessionGenreVector,
      exposureStreaks,
      sessionHasGenre,
      index.genreVectors,
      libIdx * NUM_GENRE_CLUSTERS,
      index.unknownGenreFlags[libIdx] === 1,
    );
    lastArtistStep.set(index.artistIds[libIdx], step);
    lastAlbumStep.set(index.albumIds[libIdx], step);
    lastRecordingStep.set(index.recordingIds[libIdx], step);
    step += 1;
  };

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
      const libIdx =
        tid !== null && tid !== undefined
          ? (index.idToIndex.get(tid) ?? -1)
          : -1;
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
      poolLibIndices[i] =
        tid !== null && tid !== undefined
          ? (index.idToIndex.get(tid) ?? -1)
          : -1;
    }
  }
  const currentDaypart = daypartForTimestamp(now);

  const orderedContext: number[] = [];
  let remaining = contextCount;
  const horizonLimit = Math.min(remaining, activeHorizon);

  const shortlistPoolPositions = new Int32Array(shortlistSize);
  const shortlistCompat = new Float32Array(shortlistSize);
  const shortlistUnknown = new Uint8Array(shortlistSize);
  const shortlistScores = new Float32Array(shortlistSize);
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
    relevanceThreshold: relaxedGenreCompatibility,
    stepProjection,
    saturatedMask,
    freshMask,
    sessionIsFocused: true,
  };

  // Tier 1: Active Horizon dynamic context sampling with Relevance Gating
  for (let h = 0; h < horizonLimit; h++) {
    sessionCtx.step = step;
    sessionCtx.sessionHasGenre = sessionHasGenre;
    if (sessionHasGenre) {
      sessionCtx.sessionIsFocused = precomputeStepGenreProjection(
        sessionGenreVector,
        exposureStreaks,
        stepProjection,
        saturatedMask,
        freshMask,
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
        const tmpQ = poolQueueIndices[k];
        poolQueueIndices[k] = poolQueueIndices[pick];
        poolQueueIndices[pick] = tmpQ;

        const tmpL = poolLibIndices[k];
        poolLibIndices[k] = poolLibIndices[pick];
        poolLibIndices[pick] = tmpL;

        shortlistPoolPositions[k] = k;
      }
    }

    let primaryPassCount = 0;
    let relaxedPassCount = 0;
    let unknownMetaCount = 0;

    for (let k = 0; k < kCount; k++) {
      const poolPos = shortlistPoolPositions[k];
      const libIdx = poolLibIndices[poolPos];
      if (libIdx < 0) {
        shortlistCompat[k] = NEUTRAL_UNKNOWN_GENRE_COMPATIBILITY;
        shortlistUnknown[k] = 1;
        shortlistScores[k] = 0.35;
        unknownMetaCount += 1;
      } else {
        const isUnk = index.unknownGenreFlags[libIdx] === 1;
        shortlistUnknown[k] = isUnk ? 1 : 0;
        const breakdown = evaluateCandidateBreakdown(index, libIdx, sessionCtx);
        shortlistCompat[k] = breakdown.genreCompatibility;
        shortlistScores[k] = breakdown.total;
        if (!sessionHasGenre) {
          primaryPassCount += 1;
        } else if (
          !isUnk &&
          breakdown.genreCompatibility >= minGenreCompatibility
        ) {
          primaryPassCount += 1;
        } else if (
          !isUnk &&
          breakdown.genreCompatibility >= relaxedGenreCompatibility
        ) {
          relaxedPassCount += 1;
        } else if (isUnk) {
          unknownMetaCount += 1;
        }
      }
    }

    // If the random 64-item shortlist happened to miss compatible tracks that still exist in
    // the wider pool, scan a bounded window in the remaining pool to pull compatible candidates in.
    if (
      sessionHasGenre &&
      primaryPassCount === 0 &&
      relaxedPassCount === 0 &&
      remaining > kCount
    ) {
      const scanLimit = Math.min(remaining, kCount + 256);
      let replaceSlot = 0;
      for (
        let s = kCount;
        s < scanLimit && replaceSlot < Math.min(8, kCount);
        s++
      ) {
        const libIdx = poolLibIndices[s];
        if (libIdx < 0) continue;
        const isUnk = index.unknownGenreFlags[libIdx] === 1;
        if (isUnk) continue;
        const compat = scoreProjectedGenreCompatibility(
          stepProjection,
          saturatedMask,
          freshMask,
          sessionHasGenre,
          index.genreVectors,
          libIdx * NUM_GENRE_CLUSTERS,
          false,
          sessionCtx.sessionIsFocused,
          sessionCtx.sessionGenreVector,
        );
        if (compat >= relaxedGenreCompatibility) {
          // Swap into shortlist slot `replaceSlot`
          const tmpQ = poolQueueIndices[replaceSlot];
          poolQueueIndices[replaceSlot] = poolQueueIndices[s];
          poolQueueIndices[s] = tmpQ;

          const tmpL = poolLibIndices[replaceSlot];
          poolLibIndices[replaceSlot] = poolLibIndices[s];
          poolLibIndices[s] = tmpL;

          const breakdown = evaluateCandidateBreakdown(
            index,
            libIdx,
            sessionCtx,
          );
          shortlistCompat[replaceSlot] = breakdown.genreCompatibility;
          shortlistUnknown[replaceSlot] = 0;
          shortlistScores[replaceSlot] = breakdown.total;
          if (compat >= minGenreCompatibility) primaryPassCount += 1;
          else relaxedPassCount += 1;
          replaceSlot += 1;
        }
      }
    }

    // Apply hard Relevance Gate BEFORE weighted random selection:
    // Rejected candidates receive weight 0 whenever any compatible candidate exists!
    for (let k = 0; k < kCount; k++) {
      const compat = shortlistCompat[k];
      const isUnk = shortlistUnknown[k] === 1;
      let admitted = false;

      if (!sessionHasGenre) {
        admitted = true;
      } else if (primaryPassCount > 0) {
        admitted = !isUnk && compat >= minGenreCompatibility;
      } else if (relaxedPassCount > 0) {
        admitted = !isUnk && compat >= relaxedGenreCompatibility;
      } else if (unknownMetaCount > 0) {
        admitted = isUnk;
      } else {
        // Only if zero compatible or unknown-genre tracks exist in the shortlist may remaining queue items be ordered
        admitted = true;
      }

      shortlistWeights[k] = admitted
        ? Math.pow(Math.max(0.01, shortlistScores[k]), gamma)
        : 0;
    }

    const chosenShortlistIdx = sampleWeightedShortlist(
      shortlistWeights,
      kCount,
      rng,
    );
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
      observeSelectedTrack(chosenLibIdx);
    } else {
      step += 1;
    }
  }

  // Tier 2: O(N) Stratified Relevance + Preference Permutation (when contextCount > activeHorizon)
  if (remaining > 0) {
    if (sessionHasGenre) {
      sessionCtx.sessionIsFocused = precomputeStepGenreProjection(
        sessionGenreVector,
        exposureStreaks,
        stepProjection,
        saturatedMask,
        freshMask,
      );
    }

    const strata0: number[] = [];
    const strata1: number[] = [];
    const strata2: number[] = [];
    const strata3: number[] = [];

    for (let i = 0; i < remaining; i++) {
      const libIdx = poolLibIndices[i];
      let compat = NEUTRAL_UNKNOWN_GENRE_COMPATIBILITY;
      let isUnk = true;
      if (libIdx >= 0) {
        isUnk = index.unknownGenreFlags[libIdx] === 1;
        compat = scoreProjectedGenreCompatibility(
          stepProjection,
          saturatedMask,
          freshMask,
          sessionHasGenre,
          index.genreVectors,
          libIdx * NUM_GENRE_CLUSTERS,
          isUnk,
          sessionCtx.sessionIsFocused,
          sessionCtx.sessionGenreVector,
        );
      }
      const staticPref =
        libIdx >= 0
          ? clamp(
              (0.65 * index.basePreference[libIdx] +
                0.2 * index.effectivePopularity[libIdx] +
                0.15 * 0.5) *
                index.playCooldown[libIdx],
              0.05,
              1.0,
            )
          : 0.4;

      if (!sessionHasGenre) {
        const noisyScore = staticPref * 0.75 + rng() * 0.25;
        if (noisyScore >= 0.62) strata0.push(i);
        else if (noisyScore >= 0.46) strata1.push(i);
        else if (noisyScore >= 0.3) strata2.push(i);
        else strata3.push(i);
      } else if (!isUnk && compat >= minGenreCompatibility) {
        strata0.push(i);
      } else if (!isUnk && compat >= relaxedGenreCompatibility) {
        strata1.push(i);
      } else if (isUnk) {
        strata2.push(i);
      } else {
        strata3.push(i);
      }
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
            const lIdx =
              tid !== null && tid !== undefined
                ? index.idToIndex.get(tid)
                : undefined;
            return lIdx !== undefined ? index.artistIds[lIdx] : -1;
          })()
        : -1;

    for (let i = 0; i < remaining; i++) {
      let poolPos = tailIndices[i];
      let libIdx = poolLibIndices[poolPos];
      if (
        libIdx >= 0 &&
        index.artistIds[libIdx] === prevArtistId &&
        i + 1 < remaining
      ) {
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
  /**
   * Collective genre anchor: every user-authored track currently in the queue (manual and
   * context entries), in queue order. When this property is present the genre profile is the mean
   * cluster distribution of those tracks and nothing else contributes to it - not the playing
   * track, not the playback history and never AutoPlay's own output. Passing an empty array is a
   * deliberate "no anchor" request and yields a neutral session (no genre gating) rather than
   * silently falling back to whichever track happens to be playing.
   *
   * Omit the property to keep the legacy single-seed behaviour (`seedTrackIds` last known genre).
   */
  anchorTrackIds?: readonly number[];
}

export interface SelectAutoPlayResult {
  trackIds: number[];
  diagnostics: RecommendationDiagnosticsReport;
}

/**
 * Evaluates a single candidate track against a seed track and returns a structured diagnostic
 * entry explaining its multi-cluster genre vectors, compatibility, relevance gate outcome,
 * popularity, final score, and selection/rejection reason.
 */
export function diagnoseCandidateRelevance(
  currentTrack: SmartShuffleTrack,
  candidateTrack: SmartShuffleTrack,
  options: {
    intelligenceByKey?: ReadonlyMap<string, TrackIntelligenceRecord>;
    minGenreCompatibility?: number;
    relaxedGenreCompatibility?: number;
    now?: number;
  } = {},
): CandidateDiagnosticEntry {
  const now = options.now ?? Date.now();
  const minGenreCompatibility =
    options.minGenreCompatibility ?? DEFAULT_MIN_GENRE_COMPATIBILITY;
  const relaxedGenreCompatibility =
    options.relaxedGenreCompatibility ?? DEFAULT_RELAXED_GENRE_COMPATIBILITY;

  const pairTracks = [currentTrack, candidateTrack];
  const index = buildLibraryShuffleIndex(pairTracks, {
    now,
    intelligenceByKey: options.intelligenceByKey,
  });

  const sessionGenreVector = new Float32Array(NUM_GENRE_CLUSTERS);
  const exposureStreaks = new Float32Array(NUM_GENRE_CLUSTERS);
  const sessionHasGenre = updateGenreSessionState(
    sessionGenreVector,
    exposureStreaks,
    false,
    index.genreVectors,
    0,
    index.unknownGenreFlags[0] === 1,
    1.0,
  );

  const lastArtistStep = new Map<number, number>([[index.artistIds[0], 0]]);
  const lastAlbumStep = new Map<number, number>([[index.albumIds[0], 0]]);
  const lastRecordingStep = new Map<number, number>([
    [index.recordingIds[0], 0],
  ]);

  const breakdown = evaluateCandidateBreakdown(index, 1, {
    step: 1,
    sessionGenreVector,
    exposureStreaks,
    sessionHasGenre,
    lastArtistStep,
    lastAlbumStep,
    lastRecordingStep,
    poolArtistCount: index.uniqueArtistCount,
    poolAlbumCount: index.uniqueAlbumCount,
    poolRecordingCount: index.uniqueRecordingCount,
    currentDaypart: daypartForTimestamp(now),
    weights: {
      genreCompatibility: 0.44,
      userPreference: 0.3,
      diversity: 0.15,
      popularity: 0.07,
      timeOfDay: 0.04,
    },
    relevanceThreshold: minGenreCompatibility,
  });

  const seedClusters = summarizeGenreVector(index.genreVectors, 0);
  const candClusters = summarizeGenreVector(
    index.genreVectors,
    NUM_GENRE_CLUSTERS,
  );
  const candIsUnknown = index.unknownGenreFlags[1] === 1;

  let passedGate = false;
  let activeThreshold = minGenreCompatibility;
  let decision: "selected" | "eligible" | "rejected" = "rejected";
  let reason: CandidateDecisionReason = "rejected-below-genre-threshold";

  if (index.recordingIds[0] === index.recordingIds[1]) {
    passedGate = false;
    decision = "rejected";
    reason = "rejected-duplicate-recording";
  } else if (!sessionHasGenre) {
    passedGate = true;
    decision = "eligible";
    reason = "selected-seed-genre-unknown";
  } else if (
    !candIsUnknown &&
    breakdown.genreCompatibility >= minGenreCompatibility
  ) {
    passedGate = true;
    activeThreshold = minGenreCompatibility;
    decision = "eligible";
    reason = "selected-primary-gate";
  } else if (
    !candIsUnknown &&
    breakdown.genreCompatibility >= relaxedGenreCompatibility
  ) {
    passedGate = true;
    activeThreshold = relaxedGenreCompatibility;
    decision = "eligible";
    reason = "selected-relaxed-gate";
  } else if (candIsUnknown) {
    passedGate = true;
    activeThreshold = relaxedGenreCompatibility;
    decision = "eligible";
    reason = "selected-incomplete-metadata-fallback";
  } else {
    passedGate = false;
    activeThreshold = relaxedGenreCompatibility;
    decision = "rejected";
    reason = "rejected-below-genre-threshold";
  }

  const rawPop =
    index.rawPopularity[1] >= 0
      ? Number(index.rawPopularity[1].toFixed(3))
      : null;
  const popConf =
    index.popularityConfidence[1] >= 0
      ? Number(index.popularityConfidence[1].toFixed(3))
      : null;

  const explanation = passedGate
    ? `Compatible (${reason}): genreCompatibility=${breakdown.genreCompatibility.toFixed(3)} >= threshold=${activeThreshold.toFixed(3)} [seed=(${formatClusterSummary(seedClusters)}) -> candidate=(${formatClusterSummary(candClusters)})], finalScore=${breakdown.total.toFixed(3)}`
    : `Rejected (${reason}): genreCompatibility=${breakdown.genreCompatibility.toFixed(3)} < threshold=${activeThreshold.toFixed(3)} [seed=(${formatClusterSummary(seedClusters)}) vs candidate=(${formatClusterSummary(candClusters)})]; popularity=${rawPop ?? "none"} cannot override failed relevance gate`;

  return {
    currentTrack: {
      id: currentTrack.id,
      title: currentTrack.title,
      artist: currentTrack.artist,
      genre: currentTrack.genre,
      clusters: seedClusters,
    },
    candidateTrack: {
      id: candidateTrack.id,
      title: candidateTrack.title,
      artist: candidateTrack.artist,
      genre: candidateTrack.genre,
      clusters: candClusters,
      isUnknownGenre: candIsUnknown,
    },
    genreCompatibility: Number(breakdown.genreCompatibility.toFixed(4)),
    relevanceThreshold: Number(activeThreshold.toFixed(4)),
    passedRelevanceGate: passedGate,
    popularity: rawPop,
    popularityConfidence: popConf,
    effectivePopularity: Number(breakdown.effectivePopularity.toFixed(4)),
    userPreference: Number(breakdown.userPreference.toFixed(4)),
    diversity: Number(breakdown.diversity.toFixed(4)),
    finalScore: Number(breakdown.total.toFixed(4)),
    decision,
    reason,
    explanation,
  };
}

function runAutoPlaySelection(
  tracks: readonly SmartShuffleTrack[],
  options: SelectAutoPlayOptions,
  collectFullDiagnostics: boolean,
): SelectAutoPlayResult {
  const count = Math.max(1, options.count ?? 5);
  const now = options.now ?? Date.now();
  const minGenreCompatibility = clamp(
    options.minGenreCompatibility ?? DEFAULT_MIN_GENRE_COMPATIBILITY,
    0.2,
    0.95,
  );
  const relaxedGenreCompatibility = clamp(
    options.relaxedGenreCompatibility ?? DEFAULT_RELAXED_GENRE_COMPATIBILITY,
    0.15,
    minGenreCompatibility,
  );
  const maxDiagnosticEntries = Math.max(5, options.maxDiagnosticEntries ?? 20);
  const wantDiagnostics =
    collectFullDiagnostics || Boolean(options.onDiagnostics);

  let playableTracks = tracks;
  if (
    !options.libraryIndex ||
    options.libraryIndex.trackCount !== tracks.length
  ) {
    let hasUnplayable = false;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].playable === false) {
        hasUnplayable = true;
        break;
      }
    }
    if (hasUnplayable) {
      playableTracks = tracks.filter((t) => t.playable !== false);
    }
  }

  if (playableTracks.length === 0) {
    const emptyReport: RecommendationDiagnosticsReport = {
      mode: "autoplay",
      timestampMs: now,
      currentTrack: {
        id: null,
        title: "",
        artist: "",
        genre: "",
        clusters: [],
      },
      primaryThreshold: minGenreCompatibility,
      relaxedThreshold: relaxedGenreCompatibility,
      activeThresholdUsed: minGenreCompatibility,
      relaxationStage: "no-compatible-candidates",
      totalCandidatesEvaluated: 0,
      compatibleCandidateCount: 0,
      rejectedIncompatibleCount: 0,
      selectedTrackIds: [],
      anchorSource:
        options.anchorTrackIds !== undefined ? "none" : "seed-track",
      anchorTrackCount: 0,
      noCompatibleCandidatesReason: "Library has no playable tracks.",
      selectedDiagnostics: [],
      rejectedDiagnostics: [],
    };
    options.onDiagnostics?.(emptyReport);
    return { trackIds: [], diagnostics: emptyReport };
  }

  const rng = options.rng ?? Math.random;
  const shortlistSize = Math.max(16, options.shortlistSize ?? 96);
  const gamma = clamp(options.temperatureExponent ?? 2.4, 0.5, 5.0);
  const weights: SmartShuffleWeights = {
    ...DEFAULT_SMART_SHUFFLE_WEIGHTS,
    genreCompatibility: 0.44,
    userPreference: 0.3,
    diversity: 0.15,
    popularity: 0.07,
    timeOfDay: 0.04,
    ...options.weights,
  };

  const index =
    options.libraryIndex &&
    options.libraryIndex.trackCount === playableTracks.length
      ? options.libraryIndex
      : buildLibraryShuffleIndex(playableTracks, {
          now,
          intelligenceByKey: options.intelligenceByKey,
          historyEntries: options.historyEntries,
        });

  const sessionGenreVector = new Float32Array(NUM_GENRE_CLUSTERS);
  const exposureStreaks = new Float32Array(NUM_GENRE_CLUSTERS);
  let step = 0;

  const lastArtistStep = new Map<number, number>();
  const lastAlbumStep = new Map<number, number>();
  const lastRecordingStep = new Map<number, number>();
  const excludedRecordingIds = new Set<number>();

  const recentLibIndices: number[] = [];
  if (options.recentPlayedTrackIds) {
    for (const tid of options.recentPlayedTrackIds) {
      const libIdx = index.idToIndex.get(tid);
      if (libIdx !== undefined) {
        recentLibIndices.push(libIdx);
        lastArtistStep.set(index.artistIds[libIdx], step);
        lastAlbumStep.set(index.albumIds[libIdx], step);
        lastRecordingStep.set(index.recordingIds[libIdx], step);
        excludedRecordingIds.add(index.recordingIds[libIdx]);
        step += 1;
      }
    }
  }

  const seedLibIndices: number[] = [];
  if (options.seedTrackIds) {
    for (const tid of options.seedTrackIds) {
      const libIdx = index.idToIndex.get(tid);
      if (libIdx !== undefined) {
        seedLibIndices.push(libIdx);
        lastArtistStep.set(index.artistIds[libIdx], step);
        lastAlbumStep.set(index.albumIds[libIdx], step);
        lastRecordingStep.set(index.recordingIds[libIdx], step);
        excludedRecordingIds.add(index.recordingIds[libIdx]);
        step += 1;
      }
    }
  }

  // Genre anchor: either the collective profile of the user's queue (`anchorTrackIds`) or, for
  // callers that do not provide one, the legacy single-seed anchor.
  const explicitAnchor = options.anchorTrackIds !== undefined;
  const anchorVector = new Float32Array(NUM_GENRE_CLUSTERS);
  const anchorTrackCount = explicitAnchor
    ? buildQueueAnchorGenreVector(
        index,
        options.anchorTrackIds ?? [],
        anchorVector,
      )
    : 0;

  const anchorReportFields = {
    anchorSource: explicitAnchor
      ? anchorTrackCount > 0
        ? ("manual-queue" as const)
        : ("none" as const)
      : ("seed-track" as const),
    anchorTrackCount,
    anchorClusters:
      anchorTrackCount > 0 ? summarizeGenreVector(anchorVector, 0) : [],
  };

  let sessionHasGenre: boolean;
  if (explicitAnchor) {
    // No history, no playing-track heuristics: the queue *is* the context. `anchorTrackCount === 0`
    // means the caller has no user-authored, genre-tagged queue at all, which is reported as a
    // neutral session instead of being filled in from AutoPlay's own output.
    sessionGenreVector.set(anchorVector);
    exposureStreaks.fill(0);
    sessionHasGenre = anchorTrackCount > 0;
  } else {
    sessionHasGenre = initializeAnchoredSessionGenreState(
      index,
      seedLibIndices,
      recentLibIndices,
      sessionGenreVector,
      exposureStreaks,
      relaxedGenreCompatibility,
    );
  }

  const lastSeedId =
    options.seedTrackIds && options.seedTrackIds.length > 0
      ? options.seedTrackIds[options.seedTrackIds.length - 1]
      : options.recentPlayedTrackIds && options.recentPlayedTrackIds.length > 0
        ? options.recentPlayedTrackIds[options.recentPlayedTrackIds.length - 1]
        : null;
  const lastSeedLibIdx =
    lastSeedId !== null ? (index.idToIndex.get(lastSeedId) ?? -1) : -1;
  const currentTrackMeta = wantDiagnostics
    ? lastSeedLibIdx >= 0
      ? {
          id: playableTracks[lastSeedLibIdx].id,
          title: playableTracks[lastSeedLibIdx].title,
          artist: playableTracks[lastSeedLibIdx].artist,
          genre: playableTracks[lastSeedLibIdx].genre,
          clusters: summarizeGenreVector(
            index.genreVectors,
            lastSeedLibIdx * NUM_GENRE_CLUSTERS,
          ),
        }
      : {
          id: null,
          title: "",
          artist: "",
          genre: "",
          clusters: summarizeGenreVector(sessionGenreVector, 0),
        }
    : { id: lastSeedId, title: "", artist: "", genre: "", clusters: [] };

  const excludeTrackIds = options.excludeTrackIds ?? new Set<number>();
  for (const tid of excludeTrackIds) {
    const libIdx = index.idToIndex.get(tid);
    if (libIdx !== undefined) {
      excludedRecordingIds.add(index.recordingIds[libIdx]);
    }
  }

  const stepProjection = new Float32Array(NUM_GENRE_CLUSTERS);
  const saturatedMask = new Uint8Array(NUM_GENRE_CLUSTERS);
  const freshMask = new Uint8Array(NUM_GENRE_CLUSTERS);
  const currentDaypart = daypartForTimestamp(now);

  let sessionIsFocused = false;
  if (sessionHasGenre) {
    sessionIsFocused = precomputeStepGenreProjection(
      sessionGenreVector,
      exposureStreaks,
      stepProjection,
      saturatedMask,
      freshMask,
    );
  }

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
    relevanceThreshold: minGenreCompatibility,
    stepProjection,
    saturatedMask,
    freshMask,
    sessionIsFocused,
  };

  const buildDiagnosticEntry = (
    libIdx: number,
    compat: number,
    threshold: number,
    passedGate: boolean,
    finalScore: number,
    decision: "selected" | "eligible" | "rejected",
    reason: CandidateDecisionReason,
  ): CandidateDiagnosticEntry => {
    const t = playableTracks[libIdx];
    const candClusters = summarizeGenreVector(
      index.genreVectors,
      libIdx * NUM_GENRE_CLUSTERS,
    );
    const isUnk = index.unknownGenreFlags[libIdx] === 1;
    const rawPop =
      index.rawPopularity[libIdx] >= 0
        ? Number(index.rawPopularity[libIdx].toFixed(3))
        : null;
    const popConf =
      index.popularityConfidence[libIdx] >= 0
        ? Number(index.popularityConfidence[libIdx].toFixed(3))
        : null;

    const explanation = passedGate
      ? `Selected/Eligible (${reason}): '${t.title}' by ${t.artist} — genreCompatibility=${compat.toFixed(3)} >= threshold=${threshold.toFixed(3)} [seed=(${formatClusterSummary(currentTrackMeta.clusters)}) -> candidate=(${formatClusterSummary(candClusters)})], finalScore=${finalScore.toFixed(3)}`
      : `Rejected (${reason}): '${t.title}' by ${t.artist} — genreCompatibility=${compat.toFixed(3)} < threshold=${threshold.toFixed(3)} [seed=(${formatClusterSummary(currentTrackMeta.clusters)}) vs candidate=(${formatClusterSummary(candClusters)})]; popularity=${rawPop ?? "none"} cannot override failed relevance gate`;

    return {
      currentTrack: currentTrackMeta,
      candidateTrack: {
        id: t.id,
        title: t.title,
        artist: t.artist,
        genre: t.genre,
        clusters: candClusters,
        isUnknownGenre: isUnk,
      },
      genreCompatibility: Number(compat.toFixed(4)),
      relevanceThreshold: Number(threshold.toFixed(4)),
      passedRelevanceGate: passedGate,
      popularity: rawPop,
      popularityConfidence: popConf,
      effectivePopularity: Number(index.effectivePopularity[libIdx].toFixed(4)),
      userPreference: Number(index.basePreference[libIdx].toFixed(4)),
      diversity: 1.0,
      finalScore: Number(finalScore.toFixed(4)),
      decision,
      reason,
      explanation,
    };
  };

  // Single-pass typed-array pre-filtering by Relevance Gate tiers BEFORE weighted random selection
  const nTracks = index.trackCount;
  const primaryBuf = new Int32Array(nTracks);
  const relaxedBuf = new Int32Array(nTracks);
  const incompleteBuf = new Int32Array(nTracks);
  let primaryCount = 0;
  let relaxedCount = 0;
  let incompleteCount = 0;
  let totalCandidatesEvaluated = 0;
  let rejectedIncompatibleCount = 0;
  const rejectedSample: {
    libIdx: number;
    compat: number;
    prominence: number;
  }[] = [];

  const classifyCandidate = (libIdx: number) => {
    totalCandidatesEvaluated += 1;
    const isUnk = index.unknownGenreFlags[libIdx] === 1;
    const compat = scoreProjectedGenreCompatibility(
      stepProjection,
      saturatedMask,
      freshMask,
      sessionHasGenre,
      index.genreVectors,
      libIdx * NUM_GENRE_CLUSTERS,
      isUnk,
      sessionIsFocused,
      sessionGenreVector,
    );

    if (!sessionHasGenre) {
      primaryBuf[primaryCount++] = libIdx;
    } else if (!isUnk && compat >= minGenreCompatibility) {
      primaryBuf[primaryCount++] = libIdx;
    } else if (!isUnk && compat >= relaxedGenreCompatibility) {
      relaxedBuf[relaxedCount++] = libIdx;
    } else if (isUnk) {
      incompleteBuf[incompleteCount++] = libIdx;
    } else {
      rejectedIncompatibleCount += 1;
      if (wantDiagnostics) {
        const prominence =
          0.6 * index.effectivePopularity[libIdx] +
          0.4 * index.basePreference[libIdx];
        if (rejectedSample.length < maxDiagnosticEntries) {
          rejectedSample.push({ libIdx, compat, prominence });
        } else {
          let minIdx = 0;
          for (let r = 1; r < rejectedSample.length; r++) {
            if (
              rejectedSample[r].prominence < rejectedSample[minIdx].prominence
            ) {
              minIdx = r;
            }
          }
          if (prominence > rejectedSample[minIdx].prominence) {
            rejectedSample[minIdx] = { libIdx, compat, prominence };
          }
        }
      }
    }
  };

  for (let i = 0; i < nTracks; i++) {
    const tid = index.trackIds[i];
    if (
      excludeTrackIds.has(tid) ||
      excludedRecordingIds.has(index.recordingIds[i])
    )
      continue;
    classifyCandidate(i);
  }

  // If all tracks were in excludeTrackIds (very small library), evaluate non-current tracks
  if (totalCandidatesEvaluated === 0) {
    for (let i = 0; i < nTracks; i++) {
      if (index.trackIds[i] !== lastSeedId && nTracks > 1) {
        classifyCandidate(i);
      }
    }
    if (totalCandidatesEvaluated === 0 && nTracks > 0 && lastSeedLibIdx < 0) {
      classifyCandidate(0);
    }
  }

  let rejectedDiagnostics: CandidateDiagnosticEntry[] = [];
  if (wantDiagnostics && rejectedSample.length > 0) {
    rejectedSample.sort((a, b) => b.prominence - a.prominence);
    rejectedDiagnostics = rejectedSample.map((item) => {
      const breakdown = evaluateCandidateBreakdown(index, item.libIdx, {
        ...sessionCtx,
        relevanceThreshold: relaxedGenreCompatibility,
      });
      return buildDiagnosticEntry(
        item.libIdx,
        item.compat,
        relaxedGenreCompatibility,
        false,
        breakdown.total,
        "rejected",
        "rejected-below-genre-threshold",
      );
    });
  }

  // Gradual threshold relaxation across the 3 safe stages (never admitting rejectedIncompatible!)
  let pool: Int32Array;
  let remaining = 0;
  let relaxationStage: RelevanceRelaxationStage = "primary";
  let activeThresholdUsed = minGenreCompatibility;

  if (!sessionHasGenre) {
    pool = primaryBuf;
    remaining = primaryCount;
    relaxationStage = "seed-unknown";
    activeThresholdUsed = 0;
  } else if (
    primaryCount >= count ||
    (primaryCount >= Math.min(count, 2) && relaxedCount === 0) ||
    (primaryCount > 0 && relaxedCount === 0 && incompleteCount === 0)
  ) {
    pool = primaryBuf;
    remaining = primaryCount;
    relaxationStage = "primary";
    activeThresholdUsed = minGenreCompatibility;
  } else if (primaryCount + relaxedCount > 0) {
    for (let i = 0; i < relaxedCount; i++) {
      primaryBuf[primaryCount + i] = relaxedBuf[i];
    }
    pool = primaryBuf;
    remaining = primaryCount + relaxedCount;
    relaxationStage = "relaxed";
    activeThresholdUsed = relaxedGenreCompatibility;
  } else if (incompleteCount > 0) {
    pool = incompleteBuf;
    remaining = incompleteCount;
    relaxationStage = "incomplete-metadata";
    activeThresholdUsed = relaxedGenreCompatibility;
  } else {
    // Small-library safe fallback: check if any excluded track (other than the currently playing track)
    // is genre-compatible before declaring no compatible candidates.
    pool = primaryBuf;
    remaining = 0;
    for (let i = 0; i < nTracks; i++) {
      if (index.trackIds[i] === lastSeedId) continue;
      const isUnk = index.unknownGenreFlags[i] === 1;
      const compat = scoreProjectedGenreCompatibility(
        stepProjection,
        saturatedMask,
        freshMask,
        sessionHasGenre,
        index.genreVectors,
        i * NUM_GENRE_CLUSTERS,
        isUnk,
        sessionIsFocused,
        sessionGenreVector,
      );
      if (!isUnk && compat >= relaxedGenreCompatibility) {
        pool[remaining++] = i;
        relaxationStage =
          compat >= minGenreCompatibility ? "primary" : "relaxed";
        activeThresholdUsed =
          compat >= minGenreCompatibility
            ? minGenreCompatibility
            : relaxedGenreCompatibility;
      } else if (isUnk) {
        pool[remaining++] = i;
        relaxationStage = "incomplete-metadata";
        activeThresholdUsed = relaxedGenreCompatibility;
      }
    }
  }

  const compatibleCandidateCount = remaining;

  if (remaining === 0) {
    // Name the actual context: with an explicit anchor the gate compared every candidate against the
    // user's queue, not against whatever happens to be playing.
    const contextLabel = explicitAnchor
      ? `manual queue (${anchorTrackCount} track${anchorTrackCount === 1 ? "" : "s"})`
      : currentTrackMeta.title || "current track";
    const contextClusters =
      explicitAnchor && anchorTrackCount > 0
        ? summarizeGenreVector(anchorVector, 0)
        : currentTrackMeta.clusters;
    const noMatchReason = `No compatible candidates met the minimum genre relevance threshold (${relaxedGenreCompatibility.toFixed(2)}) for '${contextLabel}' (${formatClusterSummary(contextClusters)}); rejected ${rejectedIncompatibleCount} incompatible track(s) rather than injecting unrelated music.`;
    const report: RecommendationDiagnosticsReport = {
      mode: "autoplay",
      timestampMs: now,
      currentTrack: currentTrackMeta,
      primaryThreshold: minGenreCompatibility,
      relaxedThreshold: relaxedGenreCompatibility,
      activeThresholdUsed: relaxedGenreCompatibility,
      relaxationStage: "no-compatible-candidates",
      totalCandidatesEvaluated,
      compatibleCandidateCount: 0,
      rejectedIncompatibleCount,
      selectedTrackIds: [],
      ...anchorReportFields,
      noCompatibleCandidatesReason: noMatchReason,
      selectedDiagnostics: [],
      rejectedDiagnostics,
    };
    options.onDiagnostics?.(report);
    return { trackIds: [], diagnostics: report };
  }

  const targetCount = Math.min(count, remaining);
  const selectedIds: number[] = [];
  const selectedDiagnostics: CandidateDiagnosticEntry[] = [];

  const shortlistPositions = new Int32Array(shortlistSize);
  const shortlistWeights = new Float32Array(shortlistSize);
  const shortlistBreakdowns = wantDiagnostics
    ? new Array<CandidateScoreBreakdown>(shortlistSize)
    : null;

  sessionCtx.relevanceThreshold = activeThresholdUsed;

  for (let pickIdx = 0; pickIdx < targetCount && remaining > 0; pickIdx++) {
    sessionCtx.step = step;
    sessionCtx.sessionHasGenre = sessionHasGenre;
    if (sessionHasGenre) {
      sessionCtx.sessionIsFocused = precomputeStepGenreProjection(
        sessionGenreVector,
        exposureStreaks,
        stepProjection,
        saturatedMask,
        freshMask,
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

    let anyPassedCurrentStep = false;
    for (let k = 0; k < kCount; k++) {
      const libIdx = pool[shortlistPositions[k]];
      const breakdown = evaluateCandidateBreakdown(index, libIdx, sessionCtx);
      if (shortlistBreakdowns) shortlistBreakdowns[k] = breakdown;
      if (
        breakdown.passedRelevanceGate ||
        index.unknownGenreFlags[libIdx] === 1
      ) {
        anyPassedCurrentStep = true;
        shortlistWeights[k] = Math.pow(Math.max(0.03, breakdown.total), gamma);
      } else {
        shortlistWeights[k] = 0;
      }
    }

    if (!anyPassedCurrentStep) {
      break;
    }

    const chosenShortlist = sampleWeightedShortlist(
      shortlistWeights,
      kCount,
      rng,
    );
    const chosenPoolPos = shortlistPositions[chosenShortlist];
    const chosenLibIdx = pool[chosenPoolPos];
    const chosenIsUnknown = index.unknownGenreFlags[chosenLibIdx] === 1;

    selectedIds.push(index.trackIds[chosenLibIdx]);

    if (wantDiagnostics && shortlistBreakdowns) {
      const chosenBreakdown = shortlistBreakdowns[chosenShortlist];
      const selReason: CandidateDecisionReason = !sessionHasGenre
        ? "selected-seed-genre-unknown"
        : chosenIsUnknown
          ? "selected-incomplete-metadata-fallback"
          : chosenBreakdown.genreCompatibility >= minGenreCompatibility
            ? "selected-primary-gate"
            : "selected-relaxed-gate";

      selectedDiagnostics.push(
        buildDiagnosticEntry(
          chosenLibIdx,
          chosenBreakdown.genreCompatibility,
          activeThresholdUsed,
          true,
          chosenBreakdown.total,
          "selected",
          selReason,
        ),
      );
    }

    remaining -= 1;
    if (chosenPoolPos !== remaining) {
      pool[chosenPoolPos] = pool[remaining];
    }

    sessionHasGenre = updateGenreSessionState(
      sessionGenreVector,
      exposureStreaks,
      sessionHasGenre,
      index.genreVectors,
      chosenLibIdx * NUM_GENRE_CLUSTERS,
      chosenIsUnknown,
    );
    if (explicitAnchor) {
      // The EMA above keeps a *listening session* coherent, but inside a batch it lets the batch
      // drift: pick 1 would score pick 2, so a single odd recommendation could pull the rest of the
      // batch (and, before F1, the next batch's seed) towards its cluster. With an explicit anchor
      // the exposure streaks are still updated - they only drive repetition damping - while the
      // relevance profile is restored to the queue after every pick. Candidate N is therefore
      // scored against exactly the same profile as candidate 1.
      sessionGenreVector.set(anchorVector);
    }
    lastArtistStep.set(index.artistIds[chosenLibIdx], step);
    lastAlbumStep.set(index.albumIds[chosenLibIdx], step);
    lastRecordingStep.set(index.recordingIds[chosenLibIdx], step);
    step += 1;
  }

  const report: RecommendationDiagnosticsReport = {
    mode: "autoplay",
    timestampMs: now,
    currentTrack: currentTrackMeta,
    primaryThreshold: minGenreCompatibility,
    relaxedThreshold: relaxedGenreCompatibility,
    activeThresholdUsed,
    relaxationStage,
    totalCandidatesEvaluated,
    compatibleCandidateCount,
    rejectedIncompatibleCount,
    selectedTrackIds: selectedIds,
    ...anchorReportFields,
    noCompatibleCandidatesReason: null,
    selectedDiagnostics,
    rejectedDiagnostics,
  };
  options.onDiagnostics?.(report);

  return { trackIds: selectedIds, diagnostics: report };
}

/**
 * Selects upcoming AutoPlay track IDs from the library with full structured diagnostics.
 *
 * Strictly enforces Genre Relevance Gating BEFORE weighted random selection:
 * - Stage 1 (Primary Gate): Known-genre candidates with `compat >= minGenreCompatibility` (0.52).
 * - Stage 2 (Relaxed Gate): Known-genre candidates with `compat >= relaxedGenreCompatibility` (0.44).
 * - Stage 3 (Incomplete Metadata Fallback): Untagged candidates (`unknownGenreFlags === 1`),
 *   preferred over confidently incompatible tracks.
 * - Never silently falls back to unrestricted random selection of incompatible tracks.
 */
export function selectAutoPlayTracksWithDiagnostics(
  tracks: readonly SmartShuffleTrack[],
  options: SelectAutoPlayOptions = {},
): SelectAutoPlayResult {
  return runAutoPlaySelection(tracks, options, true);
}

/**
 * Selects upcoming AutoPlay track IDs from the library that continue the genre and mood of
 * `seedTrackIds` while strictly rejecting genre-incompatible tracks.
 */
export function selectAutoPlayTracks(
  tracks: readonly SmartShuffleTrack[],
  options: SelectAutoPlayOptions = {},
): number[] {
  return runAutoPlaySelection(tracks, options, false).trackIds;
}

export { parseGenreProfile };
