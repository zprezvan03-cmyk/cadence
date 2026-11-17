import { describe, expect, it } from "vitest";
import {
  buildLibraryShuffleIndex,
  buildSmartShuffleOrder,
  computeCompletionRatio,
  computeEffectivePopularity,
  DEFAULT_SMART_SHUFFLE_WEIGHTS,
  evaluateCandidateBreakdown,
  selectAutoPlayTracks,
  smartRecordingKey,
  type SmartShuffleQueueSlot,
  type SmartShuffleTrack,
  type TrackIntelligenceRecord,
} from "../../src/shared/smartShuffle";

const NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function makeRng(seed = 42): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeTrack(overrides: Partial<SmartShuffleTrack> & { id: number }): SmartShuffleTrack {
  return {
    id: overrides.id,
    title: overrides.title ?? `Song ${overrides.id}`,
    artist: overrides.artist ?? `Artist ${overrides.id}`,
    albumArtist: overrides.albumArtist ?? overrides.artist ?? `Artist ${overrides.id}`,
    album: overrides.album ?? `Album ${overrides.id}`,
    genre: overrides.genre ?? "Pop",
    duration: overrides.duration ?? 210,
    favorite: overrides.favorite ?? false,
    addedAt: overrides.addedAt ?? NOW - 60 * DAY_MS,
    lastPlayedAt: overrides.lastPlayedAt ?? null,
    playCount: overrides.playCount ?? 0,
    path: overrides.path ?? `/music/${overrides.id}.flac`,
    playable: overrides.playable ?? true,
  };
}

function makeIntel(
  track: SmartShuffleTrack,
  overrides: Partial<TrackIntelligenceRecord> = {}
): [string, TrackIntelligenceRecord] {
  const key = smartRecordingKey(track);
  return [
    key,
    {
      recordingKey: key,
      trackId: track.id,
      artist: track.artist,
      title: track.title,
      popularity: overrides.popularity ?? null,
      popularitySource: overrides.popularitySource ?? null,
      popularityConfidence: overrides.popularityConfidence ?? null,
      externalListeners: overrides.externalListeners ?? null,
      externalGenres: overrides.externalGenres ?? [],
      fetchedAt: overrides.fetchedAt ?? NOW,
      expiresAt: overrides.expiresAt ?? NOW + 30 * DAY_MS,
      skipCount: overrides.skipCount ?? 0,
      completeCount: overrides.completeCount ?? 0,
      lastSkippedAt: overrides.lastSkippedAt ?? null,
      lastCompletedAt: overrides.lastCompletedAt ?? null,
      updatedAt: overrides.updatedAt ?? NOW,
    },
  ];
}

describe("smartShuffle — personal preference vs global popularity guardrail", () => {
  it("never lets global popularity override strong personal preference or repeated user skips", () => {
    const personalFavorite = makeTrack({
      id: 1,
      title: "Indie Deep Cut",
      artist: "Local Band",
      genre: "Indie Rock",
      favorite: true,
      playCount: 18,
      lastPlayedAt: NOW - 3 * DAY_MS,
    });
    const chartHitNeutral = makeTrack({
      id: 2,
      title: "Global Chart #1",
      artist: "Mega Popstar",
      genre: "Indie Rock",
      favorite: false,
      playCount: 0,
      lastPlayedAt: null,
    });
    const chartHitSkipped = makeTrack({
      id: 3,
      title: "Overplayed Hit",
      artist: "Radio Star",
      genre: "Indie Rock",
      favorite: false,
      playCount: 6,
      lastPlayedAt: NOW - 2 * DAY_MS,
    });

    const intelMap = new Map<string, TrackIntelligenceRecord>([
      makeIntel(personalFavorite, {
        popularity: 0.12,
        popularityConfidence: 0.9,
        completeCount: 16,
        skipCount: 0,
      }),
      makeIntel(chartHitNeutral, {
        popularity: 0.99,
        popularityConfidence: 0.95,
        completeCount: 0,
        skipCount: 0,
      }),
      makeIntel(chartHitSkipped, {
        popularity: 0.99,
        popularityConfidence: 0.95,
        completeCount: 0,
        skipCount: 7,
        lastSkippedAt: NOW - 2 * 3600 * 1000,
      }),
    ]);

    const tracks = [personalFavorite, chartHitNeutral, chartHitSkipped];
    const index = buildLibraryShuffleIndex(tracks, {
      now: NOW,
      intelligenceByKey: intelMap,
    });

    const session = {
      step: 1,
      sessionGenreVector: new Float32Array(14),
      exposureStreaks: new Float32Array(14),
      sessionHasGenre: false,
      lastArtistStep: new Map<number, number>(),
      lastAlbumStep: new Map<number, number>(),
      lastRecordingStep: new Map<number, number>(),
      poolArtistCount: 3,
      poolAlbumCount: 3,
      poolRecordingCount: 3,
      currentDaypart: 1 as const,
      weights: DEFAULT_SMART_SHUFFLE_WEIGHTS,
    };

    const favScore = evaluateCandidateBreakdown(index, 0, session);
    const chartNeutralScore = evaluateCandidateBreakdown(index, 1, session);
    const chartSkippedScore = evaluateCandidateBreakdown(index, 2, session);

    // Personal favorite with low global popularity beats unplayed global #1 hit
    expect(favScore.total).toBeGreaterThan(chartNeutralScore.total);
    // Skipped chart hit has both lower preference AND attenuated effective popularity
    expect(chartSkippedScore.effectivePopularity).toBeLessThan(0.45);
    expect(chartSkippedScore.total).toBeLessThan(chartNeutralScore.total * 0.6);
  });

  it("computes Bayesian completion ratio and shrinks low-confidence popularity to neutral 0.50", () => {
    expect(computeCompletionRatio(0, 0)).toBeCloseTo(2 / 3, 4);
    expect(computeCompletionRatio(10, 0)).toBeGreaterThan(0.9);
    expect(computeCompletionRatio(0, 8)).toBeLessThan(0.2);

    // Offline / null popularity defaults to 0.50
    expect(computeEffectivePopularity(null, null, 2 / 3)).toBeCloseTo(0.5, 4);
    // Zero confidence shrinks any extreme value to 0.50
    expect(computeEffectivePopularity(1.0, 0.0, 2 / 3)).toBeCloseTo(0.5, 4);
  });
});

describe("smartShuffle — Queue Partition Invariant & manual priority", () => {
  it("always keeps current first, then manual entries in exact order, then context, then autoplay", () => {
    const tracks = Array.from({ length: 10 }, (_, i) =>
      makeTrack({ id: i + 1, genre: i % 2 === 0 ? "Rock" : "Electronic" })
    );
    const slots: SmartShuffleQueueSlot[] = [
      { queueIndex: 0, trackId: 1, origin: "context" },
      { queueIndex: 1, trackId: 2, origin: "context" },
      { queueIndex: 2, trackId: 3, origin: "manual" }, // First manual
      { queueIndex: 3, trackId: 4, origin: "context" }, // Current track (index 3)
      { queueIndex: 4, trackId: 5, origin: "autoplay" }, // AutoPlay 1
      { queueIndex: 5, trackId: 6, origin: "manual" }, // Second manual
      { queueIndex: 6, trackId: 7, origin: "context" },
      { queueIndex: 7, trackId: 8, origin: "autoplay" }, // AutoPlay 2
    ];

    const order = buildSmartShuffleOrder(slots, 3, tracks, { rng: makeRng(123) });

    // 1. Current track is at index 0
    expect(order[0]).toBe(3);
    // 2. Manual entries immediately follow current in their exact relative order (2, then 5)
    expect(order[1]).toBe(2);
    expect(order[2]).toBe(5);
    // 3. Context entries (0, 1, 6) occupy the middle positions (indices 3, 4, 5)
    expect(order.slice(3, 6).sort((a, b) => a - b)).toEqual([0, 1, 6]);
    // 4. AutoPlay entries (4, 7) are strictly at the end
    expect(order.slice(6)).toEqual([4, 7]);
  });
});

describe("smartShuffle — probabilistic diversity & artist separation", () => {
  it("spaces out tracks by the same artist and avoids duplicate recordings back-to-back", () => {
    const tracks: SmartShuffleTrack[] = [
      makeTrack({ id: 1, artist: "Artist A", title: "Alpha", genre: "Synthpop" }),
      makeTrack({ id: 2, artist: "Artist A", title: "Alpha", genre: "Synthpop" }), // Duplicate recording of 1
      makeTrack({ id: 3, artist: "Artist A", title: "Beta", genre: "Synthpop" }),
      makeTrack({ id: 4, artist: "Artist B", title: "Gamma", genre: "Synthpop" }),
      makeTrack({ id: 5, artist: "Artist C", title: "Delta", genre: "Electropop" }),
      makeTrack({ id: 6, artist: "Artist D", title: "Epsilon", genre: "Indie Pop" }),
      makeTrack({ id: 7, artist: "Artist E", title: "Zeta", genre: "Dream Pop" }),
    ];

    const slots: SmartShuffleQueueSlot[] = tracks.map((t, idx) => ({
      queueIndex: idx,
      trackId: t.id,
      origin: "context",
    }));

    // Run 30 seeded shuffles starting at track 1 (Artist A - "Alpha"):
    // Position 1 (immediately after track 1) should very rarely be Artist A or duplicate track 2
    let immediateSameArtistCount = 0;
    for (let trial = 1; trial <= 30; trial++) {
      const order = buildSmartShuffleOrder(slots, 0, tracks, { rng: makeRng(trial * 97) });
      const secondQueueIdx = order[1];
      const secondTrack = tracks[secondQueueIdx];
      if (secondTrack.artist === "Artist A") {
        immediateSameArtistCount += 1;
      }
    }
    expect(immediateSameArtistCount).toBeLessThanOrEqual(3);
  });

  it("still gives less-popular and never-played tracks a chance to be picked via weighted sampling", () => {
    const popularTrack = makeTrack({ id: 1, title: "Hit", artist: "A", genre: "Rock", favorite: true, playCount: 25 });
    const mediumTrack = makeTrack({ id: 2, title: "Mid", artist: "B", genre: "Rock", playCount: 5 });
    const deepCutTrack = makeTrack({ id: 3, title: "Deep Cut", artist: "C", genre: "Rock", playCount: 0 });
    const seedTrack = makeTrack({ id: 4, title: "Seed", artist: "D", genre: "Rock" });

    const tracks = [seedTrack, popularTrack, mediumTrack, deepCutTrack];
    const slots: SmartShuffleQueueSlot[] = tracks.map((t, i) => ({
      queueIndex: i,
      trackId: t.id,
      origin: "context",
    }));

    const firstNextCounts = new Map<number, number>([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);

    for (let trial = 1; trial <= 200; trial++) {
      const order = buildSmartShuffleOrder(slots, 0, tracks, { rng: makeRng(trial * 31) });
      const pickedTrackId = tracks[order[1]].id;
      firstNextCounts.set(pickedTrackId, (firstNextCounts.get(pickedTrackId) ?? 0) + 1);
    }

    // Popular favorite is chosen most often, but Deep Cut is still chosen multiple times (> 0)
    expect(firstNextCounts.get(1)!).toBeGreaterThan(firstNextCounts.get(2)!);
    expect(firstNextCounts.get(2)!).toBeGreaterThan(firstNextCounts.get(3)!);
    expect(firstNextCounts.get(3)!).toBeGreaterThan(5);
  });
});

describe("smartShuffle — selectAutoPlayTracks", () => {
  it("selects tracks matching the seed genre context while excluding already-queued tracks", () => {
    const library: SmartShuffleTrack[] = [
      makeTrack({ id: 1, title: "Seed Jazz 1", artist: "Miles", genre: "Cool Jazz" }),
      makeTrack({ id: 2, title: "Seed Jazz 2", artist: "Coltrane", genre: "Bebop, Jazz" }),
      makeTrack({ id: 3, title: "Candidate Jazz", artist: "Bill Evans", genre: "Jazz, Piano" }),
      makeTrack({ id: 4, title: "Candidate Soul Jazz", artist: "Grant Green", genre: "Jazz, Soul" }),
      makeTrack({ id: 5, title: "Candidate Bossa", artist: "Getz", genre: "Bossa Nova, Jazz" }),
      makeTrack({ id: 6, title: "Harsh Deathcore", artist: "Brutal Band", genre: "Deathcore, Black Metal" }),
    ];

    const picked = selectAutoPlayTracks(library, {
      count: 2,
      seedTrackIds: [1, 2],
      excludeTrackIds: new Set([1, 2]),
      rng: makeRng(77),
    });

    expect(picked).toHaveLength(2);
    expect(picked).not.toContain(1);
    expect(picked).not.toContain(2);
    // Should strongly prefer the jazz/soul/bossa tracks (3, 4, 5) over Deathcore (6)
    expect(picked.every(id => [3, 4, 5].includes(id))).toBe(true);
  });
});
