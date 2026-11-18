import { describe, expect, it } from "vitest";
import {
  buildLibraryShuffleIndex,
  buildSmartShuffleOrder,
  computeCompletionRatio,
  computeEffectivePopularity,
  DEFAULT_MIN_GENRE_COMPATIBILITY,
  DEFAULT_RELAXED_GENRE_COMPATIBILITY,
  DEFAULT_SMART_SHUFFLE_WEIGHTS,
  diagnoseCandidateRelevance,
  evaluateCandidateBreakdown,
  selectAutoPlayTracks,
  selectAutoPlayTracksWithDiagnostics,
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

function makeTrack(
  overrides: Partial<SmartShuffleTrack> & { id: number },
): SmartShuffleTrack {
  return {
    id: overrides.id,
    title: overrides.title ?? `Song ${overrides.id}`,
    artist: overrides.artist ?? `Artist ${overrides.id}`,
    albumArtist:
      overrides.albumArtist ?? overrides.artist ?? `Artist ${overrides.id}`,
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
  overrides: Partial<TrackIntelligenceRecord> = {},
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
      makeTrack({ id: i + 1, genre: i % 2 === 0 ? "Rock" : "Electronic" }),
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

    const order = buildSmartShuffleOrder(slots, 3, tracks, {
      rng: makeRng(123),
    });

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
      makeTrack({
        id: 1,
        artist: "Artist A",
        title: "Alpha",
        genre: "Synthpop",
      }),
      makeTrack({
        id: 2,
        artist: "Artist A",
        title: "Alpha",
        genre: "Synthpop",
      }), // Duplicate recording of 1
      makeTrack({
        id: 3,
        artist: "Artist A",
        title: "Beta",
        genre: "Synthpop",
      }),
      makeTrack({
        id: 4,
        artist: "Artist B",
        title: "Gamma",
        genre: "Synthpop",
      }),
      makeTrack({
        id: 5,
        artist: "Artist C",
        title: "Delta",
        genre: "Electropop",
      }),
      makeTrack({
        id: 6,
        artist: "Artist D",
        title: "Epsilon",
        genre: "Indie Pop",
      }),
      makeTrack({
        id: 7,
        artist: "Artist E",
        title: "Zeta",
        genre: "Dream Pop",
      }),
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
      const order = buildSmartShuffleOrder(slots, 0, tracks, {
        rng: makeRng(trial * 97),
      });
      const secondQueueIdx = order[1];
      const secondTrack = tracks[secondQueueIdx];
      if (secondTrack.artist === "Artist A") {
        immediateSameArtistCount += 1;
      }
    }
    expect(immediateSameArtistCount).toBeLessThanOrEqual(3);
  });

  it("still gives less-popular and never-played tracks a chance to be picked via weighted sampling", () => {
    const popularTrack = makeTrack({
      id: 1,
      title: "Hit",
      artist: "A",
      genre: "Rock",
      favorite: true,
      playCount: 25,
    });
    const mediumTrack = makeTrack({
      id: 2,
      title: "Mid",
      artist: "B",
      genre: "Rock",
      playCount: 5,
    });
    const deepCutTrack = makeTrack({
      id: 3,
      title: "Deep Cut",
      artist: "C",
      genre: "Rock",
      playCount: 0,
    });
    const seedTrack = makeTrack({
      id: 4,
      title: "Seed",
      artist: "D",
      genre: "Rock",
    });

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
      const order = buildSmartShuffleOrder(slots, 0, tracks, {
        rng: makeRng(trial * 31),
      });
      const pickedTrackId = tracks[order[1]].id;
      firstNextCounts.set(
        pickedTrackId,
        (firstNextCounts.get(pickedTrackId) ?? 0) + 1,
      );
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
      makeTrack({
        id: 1,
        title: "Seed Jazz 1",
        artist: "Miles",
        genre: "Cool Jazz",
      }),
      makeTrack({
        id: 2,
        title: "Seed Jazz 2",
        artist: "Coltrane",
        genre: "Bebop, Jazz",
      }),
      makeTrack({
        id: 3,
        title: "Candidate Jazz",
        artist: "Bill Evans",
        genre: "Jazz, Piano",
      }),
      makeTrack({
        id: 4,
        title: "Candidate Soul Jazz",
        artist: "Grant Green",
        genre: "Jazz, Soul",
      }),
      makeTrack({
        id: 5,
        title: "Candidate Bossa",
        artist: "Getz",
        genre: "Bossa Nova, Jazz",
      }),
      makeTrack({
        id: 6,
        title: "Harsh Deathcore",
        artist: "Brutal Band",
        genre: "Deathcore, Black Metal",
      }),
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
    expect(picked.every((id) => [3, 4, 5].includes(id))).toBe(true);
  });
});

describe("smartShuffle & AutoPlay — Genre Relevance Gating & Regression Suite", () => {
  const nagorizakura = makeTrack({
    id: 100,
    title: "Nagorizakura",
    artist: "AKB48",
    album: "Nagorizakura Single",
    genre: "J-Pop, Idol",
  });

  const nogizakaIdol = makeTrack({
    id: 101,
    title: "Seifuku no Mannequin",
    artist: "Nogizaka46",
    album: "Toumei na Iro",
    genre: "J-Pop, Japanese Idol",
    playCount: 0,
    favorite: false,
  });

  const keyakizakaIdol = makeTrack({
    id: 102,
    title: "Silent Majority",
    artist: "Keyakizaka46",
    album: "Masshiro na Mono wa Yogoshitaku Naru",
    genre: "J-Pop, Idol",
    playCount: 0,
    favorite: false,
  });

  const akbSameArtist = makeTrack({
    id: 103,
    title: "Heavy Rotation",
    artist: "AKB48",
    album: "Koko ni Ita Koto",
    genre: "J-Pop, Idol",
  });

  const animeTrack = makeTrack({
    id: 104,
    title: "Idol",
    artist: "YOASOBI",
    album: "The Book 3",
    genre: "Anime, J-Pop",
  });

  const jrockTrack = makeTrack({
    id: 105,
    title: "Zenzenzense",
    artist: "RADWIMPS",
    album: "Your Name.",
    genre: "J-Rock, Anime",
  });

  const cityPopTrack = makeTrack({
    id: 106,
    title: "Plastic Love",
    artist: "Mariya Takeuchi",
    album: "Variety",
    genre: "City Pop, Kayokyoku",
  });

  const vocaloidTrack = makeTrack({
    id: 107,
    title: "Senbonzakura",
    artist: "Kurousa-P",
    album: "Vocaloid Best",
    genre: "Vocaloid, J-Pop",
  });

  const justinBieberPop = makeTrack({
    id: 201,
    title: "Peaches",
    artist: "Justin Bieber",
    album: "Justice",
    genre: "Pop, R&B",
    favorite: true,
    playCount: 300,
    lastPlayedAt: NOW - 4 * DAY_MS,
  });

  const justinBieberMainstreamPop = makeTrack({
    id: 202,
    title: "Sorry",
    artist: "Justin Bieber",
    album: "Purpose",
    genre: "Pop",
    favorite: true,
    playCount: 250,
    lastPlayedAt: NOW - 5 * DAY_MS,
  });

  const phonkTrack = makeTrack({
    id: 203,
    title: "Murder in My Mind",
    artist: "Kordhell",
    album: "Drift Phonk Hits",
    genre: "Phonk, Drift Phonk",
    favorite: true,
    playCount: 400,
    lastPlayedAt: NOW - 3 * DAY_MS,
  });

  it("1. J-Pop idol -> J-Pop idol: selects compatible J-Pop idol tracks and avoids repeating the same artist back-to-back", () => {
    const diagNogizaka = diagnoseCandidateRelevance(nagorizakura, nogizakaIdol);
    expect(diagNogizaka.passedRelevanceGate).toBe(true);
    expect(diagNogizaka.reason).toBe("selected-primary-gate");
    expect(diagNogizaka.genreCompatibility).toBeGreaterThan(0.85);

    const library = [nagorizakura, nogizakaIdol, keyakizakaIdol, akbSameArtist];
    let immediateSameArtist = 0;
    for (let trial = 1; trial <= 40; trial++) {
      const picked = selectAutoPlayTracks(library, {
        count: 1,
        seedTrackIds: [nagorizakura.id],
        excludeTrackIds: new Set([nagorizakura.id]),
        rng: makeRng(trial * 53),
      });
      expect(picked).toHaveLength(1);
      if (picked[0] === akbSameArtist.id) {
        immediateSameArtist += 1;
      }
    }
    // Prefers Nogizaka46 / Keyakizaka46 over immediately repeating AKB48
    expect(immediateSameArtist).toBeLessThanOrEqual(5);
  });

  it("2. J-Pop -> compatible neighboring genres: allows Anime, J-Rock, City Pop, and Vocaloid via the genre affinity model", () => {
    for (const neighbor of [
      animeTrack,
      jrockTrack,
      cityPopTrack,
      vocaloidTrack,
    ]) {
      const diag = diagnoseCandidateRelevance(nagorizakura, neighbor);
      expect(diag.passedRelevanceGate).toBe(true);
      expect(diag.genreCompatibility).toBeGreaterThanOrEqual(
        DEFAULT_MIN_GENRE_COMPATIBILITY,
      );
      expect(["selected-primary-gate", "selected-relaxed-gate"]).toContain(
        diag.reason,
      );
    }

    const library = [
      nagorizakura,
      animeTrack,
      jrockTrack,
      cityPopTrack,
      vocaloidTrack,
      justinBieberPop,
      phonkTrack,
    ];
    const { trackIds, diagnostics } = selectAutoPlayTracksWithDiagnostics(
      library,
      {
        count: 4,
        seedTrackIds: [nagorizakura.id],
        excludeTrackIds: new Set([nagorizakura.id]),
        rng: makeRng(101),
      },
    );

    expect(trackIds.sort((a, b) => a - b)).toEqual([
      animeTrack.id,
      jrockTrack.id,
      cityPopTrack.id,
      vocaloidTrack.id,
    ]);
    expect(diagnostics.rejectedIncompatibleCount).toBe(2);
  });

  it("3 & 4. an idol/J-Pop seed strictly rejects Phonk and unrelated mainstream Pop/R&B", () => {
    const diagPhonk = diagnoseCandidateRelevance(nagorizakura, phonkTrack);
    expect(diagPhonk.passedRelevanceGate).toBe(false);
    expect(diagPhonk.decision).toBe("rejected");
    expect(diagPhonk.reason).toBe("rejected-below-genre-threshold");
    expect(diagPhonk.genreCompatibility).toBeLessThan(0.28);
    expect(diagPhonk.explanation).toContain("Rejected");

    const diagBieberRnb = diagnoseCandidateRelevance(
      nagorizakura,
      justinBieberPop,
    );
    expect(diagBieberRnb.passedRelevanceGate).toBe(false);
    expect(diagBieberRnb.decision).toBe("rejected");
    expect(diagBieberRnb.reason).toBe("rejected-below-genre-threshold");
    expect(diagBieberRnb.genreCompatibility).toBeLessThan(
      DEFAULT_RELAXED_GENRE_COMPATIBILITY,
    );

    const diagBieberPop = diagnoseCandidateRelevance(
      nagorizakura,
      justinBieberMainstreamPop,
    );
    expect(diagBieberPop.passedRelevanceGate).toBe(false);
    expect(diagBieberPop.decision).toBe("rejected");
    expect(diagBieberPop.reason).toBe("rejected-below-genre-threshold");
    expect(diagBieberPop.genreCompatibility).toBeLessThan(
      DEFAULT_RELAXED_GENRE_COMPATIBILITY,
    );
  });

  it("5. Popularity-heavy but genre-incompatible candidates NEVER beat a less popular compatible track", () => {
    const intelMap = new Map<string, TrackIntelligenceRecord>([
      makeIntel(nogizakaIdol, {
        popularity: 0.04,
        popularityConfidence: 0.95,
        completeCount: 0,
        skipCount: 0,
      }),
      makeIntel(jrockTrack, {
        popularity: 0.08,
        popularityConfidence: 0.95,
        completeCount: 0,
        skipCount: 0,
      }),
      makeIntel(justinBieberPop, {
        popularity: 1.0,
        popularityConfidence: 1.0,
        completeCount: 150,
        skipCount: 0,
      }),
      makeIntel(justinBieberMainstreamPop, {
        popularity: 1.0,
        popularityConfidence: 1.0,
        completeCount: 150,
        skipCount: 0,
      }),
      makeIntel(phonkTrack, {
        popularity: 1.0,
        popularityConfidence: 1.0,
        completeCount: 200,
        skipCount: 0,
      }),
    ]);

    const diagCompatibleLowPop = diagnoseCandidateRelevance(
      nagorizakura,
      nogizakaIdol,
      {
        intelligenceByKey: intelMap,
      },
    );
    const diagBieberMaxPop = diagnoseCandidateRelevance(
      nagorizakura,
      justinBieberPop,
      {
        intelligenceByKey: intelMap,
      },
    );
    const diagPhonkMaxPop = diagnoseCandidateRelevance(
      nagorizakura,
      phonkTrack,
      {
        intelligenceByKey: intelMap,
      },
    );

    // Even in raw finalScore, the low-popularity compatible track beats the 1.0-popularity incompatible tracks
    expect(diagCompatibleLowPop.passedRelevanceGate).toBe(true);
    expect(diagBieberMaxPop.passedRelevanceGate).toBe(false);
    expect(diagPhonkMaxPop.passedRelevanceGate).toBe(false);
    expect(diagCompatibleLowPop.finalScore).toBeGreaterThan(
      diagBieberMaxPop.finalScore * 4,
    );
    expect(diagCompatibleLowPop.finalScore).toBeGreaterThan(
      diagPhonkMaxPop.finalScore * 4,
    );

    // Across 100 trials of AutoPlay and Smart Shuffle, the unrelated Pop/R&B and Phonk fixtures are
    // NEVER picked before compatible tracks
    const library = [
      nagorizakura,
      nogizakaIdol,
      jrockTrack,
      justinBieberPop,
      justinBieberMainstreamPop,
      phonkTrack,
    ];

    for (let trial = 1; trial <= 100; trial++) {
      const picked = selectAutoPlayTracks(library, {
        count: 2,
        seedTrackIds: [nagorizakura.id],
        excludeTrackIds: new Set([nagorizakura.id]),
        intelligenceByKey: intelMap,
        rng: makeRng(trial * 37),
      });
      expect(picked.sort((a, b) => a - b)).toEqual([
        nogizakaIdol.id,
        jrockTrack.id,
      ]);

      const slots: SmartShuffleQueueSlot[] = library.map((t, i) => ({
        queueIndex: i,
        trackId: t.id,
        origin: "context",
      }));
      const order = buildSmartShuffleOrder(slots, 0, library, {
        intelligenceByKey: intelMap,
        rng: makeRng(trial * 41),
      });
      const firstTwoUpcomingIds = [
        library[order[1]].id,
        library[order[2]].id,
      ].sort((a, b) => a - b);
      expect(firstTwoUpcomingIds).toEqual([nogizakaIdol.id, jrockTrack.id]);
    }
  });

  it("uses popularity as a secondary tie-breaker ONLY among compatible candidates", () => {
    const popularJpop = makeTrack({
      id: 301,
      title: "Popular Idol Hit",
      artist: "Idol Group A",
      genre: "J-Pop, Idol",
    });
    const obscureJpop = makeTrack({
      id: 302,
      title: "Obscure Idol Track",
      artist: "Idol Group B",
      genre: "J-Pop, Idol",
    });

    const intelMap = new Map<string, TrackIntelligenceRecord>([
      makeIntel(popularJpop, { popularity: 0.95, popularityConfidence: 0.95 }),
      makeIntel(obscureJpop, { popularity: 0.1, popularityConfidence: 0.95 }),
    ]);

    const diagPop = diagnoseCandidateRelevance(nagorizakura, popularJpop, {
      intelligenceByKey: intelMap,
    });
    const diagObscure = diagnoseCandidateRelevance(nagorizakura, obscureJpop, {
      intelligenceByKey: intelMap,
    });

    expect(diagPop.passedRelevanceGate).toBe(true);
    expect(diagObscure.passedRelevanceGate).toBe(true);
    expect(diagPop.finalScore).toBeGreaterThan(diagObscure.finalScore);
  });

  it("6. Multi-genre tracks preserve multiple cluster memberships and bridge smoothly across both genres", () => {
    const multiGenreSeed = makeTrack({
      id: 400,
      title: "Cyber Anisong Rock",
      artist: "Hybrid Unit",
      genre: "J-Pop / Electronic / Rock",
    });
    const electronicNeighbor = makeTrack({
      id: 401,
      title: "Future Bass Sunrise",
      artist: "Synth Producer",
      genre: "Future Bass, Electronic",
    });
    const rockNeighbor = makeTrack({
      id: 402,
      title: "Alt Rock Anthem",
      artist: "Guitar Band",
      genre: "Alternative Rock",
    });
    const countryOutlier = makeTrack({
      id: 403,
      title: "Honky Tonk Road",
      artist: "Country Singer",
      genre: "Country, Bluegrass",
    });

    const diagElec = diagnoseCandidateRelevance(
      multiGenreSeed,
      electronicNeighbor,
    );
    const diagRock = diagnoseCandidateRelevance(multiGenreSeed, rockNeighbor);
    const diagCountry = diagnoseCandidateRelevance(
      multiGenreSeed,
      countryOutlier,
    );

    // Seed track retains all 3 clusters in its diagnostic summary
    expect(diagElec.currentTrack.clusters.length).toBeGreaterThanOrEqual(3);
    expect(diagElec.passedRelevanceGate).toBe(true);
    expect(diagRock.passedRelevanceGate).toBe(true);
    expect(diagCountry.passedRelevanceGate).toBe(false);
  });

  it("7. Missing or unreliable genre metadata is preferred over confidently incompatible tracks when no tagged compatible tracks remain", () => {
    const untaggedTrack = makeTrack({
      id: 501,
      title: "Track 01 (Unlabeled Rip)",
      artist: "Unknown Artist",
      album: "Unknown Album",
      genre: "",
      path: "/music/imports/track01.flac",
    });

    const library = [nagorizakura, untaggedTrack, justinBieberPop, phonkTrack];
    const { trackIds, diagnostics } = selectAutoPlayTracksWithDiagnostics(
      library,
      {
        count: 2,
        seedTrackIds: [nagorizakura.id],
        excludeTrackIds: new Set([nagorizakura.id]),
        rng: makeRng(88),
      },
    );

    // Selects only the incomplete-metadata track and still rejects the unrelated Pop & Phonk fixtures
    expect(trackIds).toEqual([untaggedTrack.id]);
    expect(diagnostics.relaxationStage).toBe("incomplete-metadata");
    expect(diagnostics.rejectedIncompatibleCount).toBe(2);
    expect(diagnostics.selectedDiagnostics[0].reason).toBe(
      "selected-incomplete-metadata-fallback",
    );
  });

  it("8. Very small libraries relax safely without selecting incompatible tracks or crashing", () => {
    const smallLibrary = [nagorizakura, nogizakaIdol, phonkTrack];
    // Even if nogizakaIdol was in excludeTrackIds (e.g. played earlier in the small 3-track library),
    // the small-library fallback re-admits the compatible track rather than picking Phonk!
    const { trackIds, diagnostics } = selectAutoPlayTracksWithDiagnostics(
      smallLibrary,
      {
        count: 2,
        seedTrackIds: [nagorizakura.id],
        excludeTrackIds: new Set([nagorizakura.id, nogizakaIdol.id]),
        rng: makeRng(19),
      },
    );

    expect(trackIds).toEqual([nogizakaIdol.id]);
    expect(trackIds).not.toContain(phonkTrack.id);
    expect(diagnostics.relaxationStage).toBe("primary");
  });

  it("9. No compatible candidates: returns empty selection and explicit diagnostic explanation instead of injecting unrelated tracks", () => {
    const incompatibleOnlyLibrary = [
      nagorizakura,
      justinBieberPop,
      justinBieberMainstreamPop,
      phonkTrack,
    ];

    const { trackIds, diagnostics } = selectAutoPlayTracksWithDiagnostics(
      incompatibleOnlyLibrary,
      {
        count: 3,
        seedTrackIds: [nagorizakura.id],
        excludeTrackIds: new Set([nagorizakura.id]),
        rng: makeRng(55),
      },
    );

    expect(trackIds).toEqual([]);
    expect(diagnostics.relaxationStage).toBe("no-compatible-candidates");
    expect(diagnostics.compatibleCandidateCount).toBe(0);
    expect(diagnostics.rejectedIncompatibleCount).toBe(3);
    expect(diagnostics.noCompatibleCandidatesReason).toContain(
      "No compatible candidates met the minimum genre relevance threshold",
    );
    expect(diagnostics.rejectedDiagnostics).toHaveLength(3);
    expect(
      diagnostics.rejectedDiagnostics.every(
        (d) =>
          d.decision === "rejected" &&
          d.reason === "rejected-below-genre-threshold",
      ),
    ).toBe(true);
  });

  it("10. relevance is a function of the genre vectors only: identical outcomes under renamed artists", () => {
    // Same genre labels, two unrelated sets of synthetic artist/title/album names: every
    // compatibility score, gate decision and end-to-end selection must be bit-identical.
    const nameSets = [
      {
        seed: "Alpha",
        pop: "Beta",
        jpop: "Gamma",
        electronic: "Delta",
        phonk: "Epsilon",
      },
      {
        seed: "Zulu",
        pop: "Yankee",
        jpop: "Xray",
        electronic: "Whiskey",
        phonk: "Victor",
      },
    ];

    const buildLibrary = (names: (typeof nameSets)[number]) => ({
      seed: makeTrack({
        id: 300,
        title: "Seed Song",
        artist: names.seed,
        genre: "Pop",
      }),
      pop: makeTrack({
        id: 301,
        title: "Pop Song",
        artist: names.pop,
        genre: "Pop",
      }),
      jpop: makeTrack({
        id: 302,
        title: "J-Pop Song",
        artist: names.jpop,
        genre: "J-Pop",
      }),
      electronic: makeTrack({
        id: 303,
        title: "Electronic Song",
        artist: names.electronic,
        genre: "Electronic",
      }),
      phonk: makeTrack({
        id: 304,
        title: "Phonk Song",
        artist: names.phonk,
        genre: "Phonk",
      }),
    });

    const runs = nameSets.map((names) => {
      const library = buildLibrary(names);
      const scores = {
        pop: diagnoseCandidateRelevance(library.seed, library.pop),
        jpop: diagnoseCandidateRelevance(library.seed, library.jpop),
        electronic: diagnoseCandidateRelevance(
          library.seed,
          library.electronic,
        ),
        phonk: diagnoseCandidateRelevance(library.seed, library.phonk),
      };
      const selections = [11, 42, 77].map((seed) =>
        selectAutoPlayTracksWithDiagnostics(Object.values(library), {
          count: 4,
          seedTrackIds: [library.seed.id],
          excludeTrackIds: new Set([library.seed.id]),
          rng: makeRng(seed),
        }),
      );
      return { scores, selections };
    });

    // Only the derived numbers matter - the diagnostics echo the track metadata, which is exactly
    // what must not influence them.
    const summarise = (run: (typeof runs)[number]) => ({
      scores: Object.fromEntries(
        Object.entries(run.scores).map(([key, value]) => [
          key,
          {
            genreCompatibility: value.genreCompatibility,
            passedRelevanceGate: value.passedRelevanceGate,
            reason: value.reason,
            candidateClusters: value.candidateTrack.clusters,
            isUnknownGenre: value.candidateTrack.isUnknownGenre,
          },
        ]),
      ),
      selections: run.selections.map((selection) => ({
        trackIds: selection.trackIds,
        relaxationStage: selection.diagnostics.relaxationStage,
        compatibleCandidateCount:
          selection.diagnostics.compatibleCandidateCount,
        rejectedIncompatibleCount:
          selection.diagnostics.rejectedIncompatibleCount,
      })),
    });

    expect(summarise(runs[0])).toEqual(summarise(runs[1]));

    // Data-driven expectations, keyed by genre label only.
    const { scores, selections } = runs[0];
    expect(scores.pop.reason).toBe("selected-primary-gate");
    for (const rejected of [scores.electronic, scores.phonk]) {
      expect(rejected.passedRelevanceGate).toBe(false);
      expect(rejected.genreCompatibility).toBeLessThan(
        DEFAULT_RELAXED_GENRE_COMPATIBILITY,
      );
    }

    // A pure Pop seed shares only its 0.12 pop mass with a pure J-Pop track. Under the shared-mass
    // model that is not enough to clear the relaxed gate - the same rule that rejects Electronic and
    // Phonk, with no genre-specific exception. (A J-Pop-dominant manual queue does admit J-Pop
    // neighbours; see the J-Pop/Idol suites above.)
    expect(scores.jpop.reason).toBe("rejected-below-genre-threshold");

    for (const { trackIds, diagnostics } of selections) {
      expect(trackIds).not.toContain(303);
      expect(trackIds).not.toContain(304);
      expect(diagnostics.rejectedIncompatibleCount).toBe(3);
    }
  });

  it("anchors session genre context to the current track when the user manually switches from an unrelated genre", () => {
    // User previously listened to Phonk & Western Pop, then manually clicked Nagorizakura (J-Pop)
    const library = [
      phonkTrack,
      justinBieberPop,
      justinBieberMainstreamPop,
      nagorizakura,
      nogizakaIdol,
      animeTrack,
    ];

    const { trackIds, diagnostics } = selectAutoPlayTracksWithDiagnostics(
      library,
      {
        count: 2,
        recentPlayedTrackIds: [phonkTrack.id, justinBieberPop.id],
        seedTrackIds: [justinBieberPop.id, nagorizakura.id],
        excludeTrackIds: new Set([nagorizakura.id]),
        rng: makeRng(63),
      },
    );

    expect(trackIds.sort((a, b) => a - b)).toEqual([
      nogizakaIdol.id,
      animeTrack.id,
    ]);
    expect(diagnostics.rejectedIncompatibleCount).toBe(1);
    expect(diagnostics.rejectedDiagnostics[0].candidateTrack.id).toBe(
      justinBieberMainstreamPop.id,
    );
  });
});
