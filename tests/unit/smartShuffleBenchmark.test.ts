import { describe, expect, it } from "vitest";
import { computeGenreCompatibilityFast, NUM_GENRE_CLUSTERS } from "../../src/shared/genreCluster";
import {
  buildLibraryShuffleIndex,
  buildSmartShuffleOrder,
  selectAutoPlayTracks,
  smartRecordingKey,
  type SmartShuffleQueueSlot,
  type SmartShuffleTrack,
  type TrackIntelligenceRecord,
} from "../../src/shared/smartShuffle";
import { buildOrder } from "../../src/renderer/player/queue";
import type { HistoryEntry } from "../../src/shared/types";

const NOW = 1_730_000_000_000;

const SAMPLE_GENRES = [
  "Indie Rock; Shoegaze",
  "Synthwave / Electronic",
  "Jazz Fusion; Contemporary Jazz",
  "Hip-Hop; Boom Bap; R&B",
  "Classical; Orchestral",
  "Post-Punk; Alternative Rock",
  "Ambient; Drone; Electronic",
  "Heavy Metal; Progressive Metal",
  "Folk; Singer-Songwriter; Acoustic",
  "J-Pop; Anime; Electronic",
  "Soul; Funk; R&B",
  "House; Techno; Dance",
  "", // untagged (tests album/artist/folder fallback inference)
];

function createDeterministicRng(seed = 0x12345678): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function generateSyntheticLibrary(count: number): {
  tracks: SmartShuffleTrack[];
  slots: SmartShuffleQueueSlot[];
  intelligenceByKey: Map<string, TrackIntelligenceRecord>;
  historyEntries: HistoryEntry[];
} {
  const tracks: SmartShuffleTrack[] = new Array(count);
  const slots: SmartShuffleQueueSlot[] = new Array(count);
  const intelligenceByKey = new Map<string, TrackIntelligenceRecord>();

  const artistCount = Math.max(25, Math.floor(count / 12));
  const albumCount = Math.max(50, Math.floor(count / 5));

  for (let i = 0; i < count; i++) {
    const id = i + 1;
    const artistIdx = i % artistCount;
    const albumIdx = i % albumCount;
    const genre = SAMPLE_GENRES[i % SAMPLE_GENRES.length];
    const artist = `Artist ${artistIdx}`;
    const title = `Track Title ${id} (Feat. Guest ${i % 17})`;
    const duration = 150 + (i % 180);

    const track: SmartShuffleTrack = {
      id,
      title,
      artist,
      albumArtist: artist,
      album: `Album ${albumIdx}`,
      genre,
      path: `/music/${genre ? "tagged" : "electronic"}/${artist}/Album ${albumIdx}/${id}.flac`,
      duration,
      favorite: i % 11 === 0,
      playCount: i % 7 === 0 ? (i % 25) + 1 : 0,
      lastPlayedAt: i % 9 === 0 ? NOW - ((i % 48) + 1) * 3600 * 1000 : null,
      addedAt: NOW - (i % 365) * 86400 * 1000,
      year: 1985 + (i % 40),
      playable: true,
    };
    tracks[i] = track;
    slots[i] = {
      queueIndex: i,
      trackId: id,
      origin: "context",
    };

    if (i % 4 === 0) {
      const recKey = smartRecordingKey(track);
      intelligenceByKey.set(recKey, {
        recordingKey: recKey,
        trackId: id,
        artist,
        title,
        popularity: 0.35 + ((i % 60) / 100),
        popularitySource: i % 8 === 0 ? "lastfm+deezer" : "deezer",
        popularityConfidence: 0.78,
        externalListeners: 25_000 + (i % 500_000),
        externalGenres: genre ? [] : ["Electronic", "Synthpop"],
        fetchedAt: NOW - 86400 * 1000,
        expiresAt: NOW + 20 * 86400 * 1000,
        skipCount: i % 16 === 0 ? 3 : 0,
        completeCount: i % 8 === 0 ? 6 : 1,
        lastSkippedAt: i % 16 === 0 ? NOW - 3 * 3600 * 1000 : null,
        lastCompletedAt: NOW - 24 * 3600 * 1000,
        updatedAt: NOW,
      });
    }
  }

  const historyEntries: HistoryEntry[] = [];
  for (let h = 0; h < Math.min(200, count); h++) {
    const t = tracks[h];
    historyEntries.push({
      id: h + 1,
      source: { kind: "local", trackId: t.id },
      playedAt: NOW - h * 1800 * 1000,
      payload: {
        source: { kind: "local", trackId: t.id },
        trackId: t.id,
        path: t.path ?? "",
        title: t.title,
        artist: t.artist,
        albumArtist: t.albumArtist ?? t.artist,
        album: t.album ?? "",
        artworkUrl: null,
        duration: t.duration ?? 200,
      },
    });
  }

  return { tracks, slots, intelligenceByKey, historyEntries };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

describe("Phase 5 — Smart Shuffle & AutoPlay Empirical Benchmarks (1k, 5k, 20k tracks)", () => {
  it("benchmarks cold index build, warm Smart Shuffle ordering, full-horizon naive ordering, and AutoPlay selection across 1k, 5k, and 20k tracks", () => {
    const sizes = [1_000, 5_000, 20_000];
    const reportRows: Array<{
      size: number;
      coldIndexMs: number;
      warmTwoTierMs: number;
      coldTotalMs: number;
      autoPlayMs: number;
    }> = [];

    for (const size of sizes) {
      const { tracks, slots, intelligenceByKey, historyEntries } = generateSyntheticLibrary(size);

      // Warm up JIT once
      const warmupIndex = buildLibraryShuffleIndex(tracks.slice(0, 200), {
        now: NOW,
        intelligenceByKey,
        historyEntries,
      });
      buildSmartShuffleOrder(slots.slice(0, 200), 0, tracks.slice(0, 200), {
        libraryIndex: warmupIndex,
        rng: createDeterministicRng(1),
      });

      // 1. Measure Cold Index Construction (3 runs median)
      const coldTimes: number[] = [];
      let cachedIndex = warmupIndex;
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        cachedIndex = buildLibraryShuffleIndex(tracks, {
          now: NOW,
          intelligenceByKey,
          historyEntries,
        });
        coldTimes.push(performance.now() - t0);
      }
      const coldIndexMs = median(coldTimes);

      // 2. Measure Warm Two-Tier Smart Shuffle Order Construction (5 runs median)
      const warmTimes: number[] = [];
      let lastOrder: number[] = [];
      for (let run = 0; run < 5; run++) {
        const rng = createDeterministicRng(100 + run);
        const t0 = performance.now();
        lastOrder = buildSmartShuffleOrder(slots, 0, tracks, {
          libraryIndex: cachedIndex,
          now: NOW,
          rng,
        });
        warmTimes.push(performance.now() - t0);
      }
      const warmTwoTierMs = median(warmTimes);

      // Verify full permutation integrity
      expect(lastOrder).toHaveLength(size);
      expect(lastOrder[0]).toBe(0);
      expect(new Set(lastOrder).size).toBe(size);

      // 3. Measure Warm AutoPlay Selection (5 tracks from N-track library)
      const autoPlayTimes: number[] = [];
      const excludeSet = new Set<number>([1, 2, 3, 4, 5]);
      for (let run = 0; run < 5; run++) {
        const rng = createDeterministicRng(500 + run);
        const t0 = performance.now();
        const picked = selectAutoPlayTracks(tracks, {
          count: 5,
          seedTrackIds: [1, 2, 3],
          excludeTrackIds: excludeSet,
          libraryIndex: cachedIndex,
          now: NOW,
          rng,
        });
        autoPlayTimes.push(performance.now() - t0);
        expect(picked).toHaveLength(5);
      }
      const autoPlayMs = median(autoPlayTimes);

      reportRows.push({
        size,
        coldIndexMs: Number(coldIndexMs.toFixed(2)),
        warmTwoTierMs: Number(warmTwoTierMs.toFixed(2)),
        coldTotalMs: Number((coldIndexMs + warmTwoTierMs).toFixed(2)),
        autoPlayMs: Number(autoPlayMs.toFixed(2)),
      });
    }

    // Also measure what a full-horizon (activeHorizon = 20,000) dynamic scoring pass costs on 20k tracks
    const lib20k = generateSyntheticLibrary(20_000);
    const idx20k = buildLibraryShuffleIndex(lib20k.tracks, {
      now: NOW,
      intelligenceByKey: lib20k.intelligenceByKey,
      historyEntries: lib20k.historyEntries,
    });
    const tFull0 = performance.now();
    const fullHorizonOrder = buildSmartShuffleOrder(lib20k.slots, 0, lib20k.tracks, {
      libraryIndex: idx20k,
      activeHorizon: 20_000,
      shortlistSize: 64,
      now: NOW,
      rng: createDeterministicRng(999),
    });
    const fullHorizon20kMs = Number((performance.now() - tFull0).toFixed(2));
    expect(fullHorizonOrder).toHaveLength(20_000);

    console.info(
      "[Phase 5 Benchmark Results]",
      JSON.stringify({ reportRows, fullHorizon20kMs }, null, 2)
    );

    // Performance guardrails:
    // Warm 20k two-tier order should complete well within a single interactive budget (< 50ms in CI/sandbox)
    const row20k = reportRows.find(r => r.size === 20_000)!;
    expect(row20k.warmTwoTierMs).toBeLessThan(50);
    expect(row20k.autoPlayMs).toBeLessThan(15);
  });

  it("outperforms classic uniform Fisher-Yates on artist separation and genre transition smoothness in a 20,000-track library", () => {
    const { tracks, slots, intelligenceByKey, historyEntries } = generateSyntheticLibrary(20_000);
    const index = buildLibraryShuffleIndex(tracks, {
      now: NOW,
      intelligenceByKey,
      historyEntries,
    });

    const rngSmart = createDeterministicRng(42);
    const smartOrder = buildSmartShuffleOrder(slots, 0, tracks, {
      libraryIndex: index,
      now: NOW,
      rng: rngSmart,
    });

    const rngClassic = createDeterministicRng(42);
    const classicOrder = buildOrder(20_000, true, 0, rngClassic);

    // Evaluate first 250 transitions (the active listening horizon)
    const horizon = 250;
    const evaluateHorizon = (order: number[]) => {
      let backToBackSameArtist = 0;
      let within3SameArtist = 0;
      let compatSum = 0;
      const zeroStreak = new Float32Array(NUM_GENRE_CLUSTERS);

      for (let pos = 1; pos < horizon; pos++) {
        const prevIdx = order[pos - 1];
        const currIdx = order[pos];
        const prevArtist = index.artistIds[prevIdx];
        const currArtist = index.artistIds[currIdx];

        if (prevArtist === currArtist) {
          backToBackSameArtist += 1;
        }
        for (let back = 1; back <= Math.min(3, pos); back++) {
          if (index.artistIds[order[pos - back]] === currArtist) {
            within3SameArtist += 1;
            break;
          }
        }

        const prevVec = index.genreVectors.subarray(
          prevIdx * NUM_GENRE_CLUSTERS,
          (prevIdx + 1) * NUM_GENRE_CLUSTERS
        );
        const compat = computeGenreCompatibilityFast(
          prevVec,
          zeroStreak,
          index.unknownGenreFlags[prevIdx] === 0,
          index.genreVectors,
          currIdx * NUM_GENRE_CLUSTERS,
          index.unknownGenreFlags[currIdx] === 1
        );
        compatSum += compat;
      }

      return {
        backToBackSameArtist,
        within3SameArtist,
        meanGenreCompatibility: Number((compatSum / (horizon - 1)).toFixed(4)),
      };
    };

    const smartMetrics = evaluateHorizon(smartOrder);
    const classicMetrics = evaluateHorizon(classicOrder);

    console.info(
      "[Phase 5 Quality Metrics (250-track horizon on 20k library)]",
      JSON.stringify({ smartMetrics, classicMetrics }, null, 2)
    );

    expect(smartMetrics.backToBackSameArtist).toBe(0);
    expect(smartMetrics.within3SameArtist).toBeLessThanOrEqual(classicMetrics.within3SameArtist);
    expect(smartMetrics.meanGenreCompatibility).toBeGreaterThan(
      classicMetrics.meanGenreCompatibility
    );
  });
});
