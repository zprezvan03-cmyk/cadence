import { describe, expect, it } from "vitest";
import {
  buildLibraryGenreVectors,
  CLUSTER_INDEX,
  clusterAffinity,
  computeGenreCompatibilityFast,
  DISJOINT_CLUSTER_FLOOR,
  GENRE_CLUSTERS,
  NEUTRAL_UNKNOWN_GENRE_COMPATIBILITY,
  NUM_GENRE_CLUSTERS,
  normalizeGenreToken,
  parseGenreProfile,
  sharedGenreMass,
  tokenizeGenreString,
  updateGenreSessionState,
} from "../../src/shared/genreCluster";
import {
  DEFAULT_MIN_GENRE_COMPATIBILITY,
  DEFAULT_RELAXED_GENRE_COMPATIBILITY,
} from "../../src/shared/smartShuffle";

const ZERO_STREAKS = () => new Float32Array(NUM_GENRE_CLUSTERS);

/**
 * Reference implementation of the documented relevance model. With no exposure history there is no
 * streak damping and no bridge bonus, so the score is exactly
 *   bilinear(seed, candidate) * (focused ? 0.45 + 0.55 * sharedMass : 1), clamped to [0.05, 1].
 */
function referenceCompatibility(
  seed: Float32Array,
  candidate: Float32Array,
): number {
  let bilinear = 0;
  let maxSeed = 0;
  for (let i = 0; i < NUM_GENRE_CLUSTERS; i++) {
    const si = seed[i];
    if (si > maxSeed) maxSeed = si;
    if (si <= 1e-4) continue;
    for (let j = 0; j < NUM_GENRE_CLUSTERS; j++) {
      const gj = candidate[j];
      if (gj <= 1e-4) continue;
      bilinear +=
        si * clusterAffinity(GENRE_CLUSTERS[i], GENRE_CLUSTERS[j]) * gj;
    }
  }
  const shared = sharedGenreMass(seed, 0, candidate, 0);
  const factor =
    maxSeed >= DISJOINT_CLUSTER_FLOOR
      ? DISJOINT_CLUSTER_FLOOR + (1 - DISJOINT_CLUSTER_FLOOR) * shared
      : 1;
  return Math.min(1, Math.max(0.05, bilinear * factor));
}

/** Deterministic LCG so the property sweeps are reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomVector(
  random: () => number,
  clustersInPlay: number,
): Float32Array {
  const vector = new Float32Array(NUM_GENRE_CLUSTERS);
  let sum = 0;
  for (let i = 0; i < clustersInPlay; i++) {
    const value = 0.1 + random();
    vector[i] = value;
    sum += value;
  }
  for (let i = 0; i < NUM_GENRE_CLUSTERS; i++) vector[i] /= sum;
  return vector;
}

describe("genreCluster — tokenization and normalization", () => {
  it("normalizes punctuation, casing, and ID3v1 numeric genre codes", () => {
    expect(normalizeGenreToken("(17)")).toBe("rock");
    expect(normalizeGenreToken("(13)Pop")).toBe("pop");
    expect(normalizeGenreToken("145")).toBe("anime");
    expect(normalizeGenreToken("Synth-Pop")).toBe("synth pop");
    expect(normalizeGenreToken("Post_Rock")).toBe("post rock");
  });

  it("splits multi-genre strings across commas, slashes, semicolons, and pipes while preserving R&B and Drum & Bass", () => {
    expect(
      tokenizeGenreString("Alternative Rock, Shoegaze / Dream Pop; Electronic"),
    ).toEqual(["alternative rock", "shoegaze", "dream pop", "electronic"]);
    expect(tokenizeGenreString("R&B / Soul, Drum & Bass")).toEqual([
      "r&b",
      "soul",
      "drum and bass",
    ]);
    expect(tokenizeGenreString("Unknown Genre, None, Other")).toEqual([]);
  });
});

describe("genreCluster — multi-cluster distributions", () => {
  it("maps hybrid subgenres to multiple macro clusters instead of a single genre", () => {
    const synthpop = parseGenreProfile("Synthpop");
    expect(synthpop.isUnknown).toBe(false);
    expect(synthpop.vector[CLUSTER_INDEX.pop]).toBeCloseTo(0.6, 2);
    expect(synthpop.vector[CLUSTER_INDEX.electronic]).toBeCloseTo(0.4, 2);
    expect(synthpop.dominantClusters).toEqual(["pop", "electronic"]);

    const dreamPop = parseGenreProfile("Dream Pop");
    expect(dreamPop.vector[CLUSTER_INDEX.pop]).toBeGreaterThan(0.5);
    expect(dreamPop.vector[CLUSTER_INDEX.rock]).toBeGreaterThan(0.2);
    expect(dreamPop.vector[CLUSTER_INDEX["ambient-chill"]]).toBeGreaterThan(
      0.15,
    );
    expect(dreamPop.dominantClusters).toContain("pop");
    expect(dreamPop.dominantClusters).toContain("rock");
    expect(dreamPop.dominantClusters).toContain("ambient-chill");
  });

  it("aggregates multiple genre tags into a normalized probability vector summing to 1", () => {
    const multi = parseGenreProfile("Jazz Fusion, Electronic, Hip-Hop");
    expect(multi.isUnknown).toBe(false);
    const sum = multi.vector.reduce((acc, v) => acc + v, 0);
    expect(sum).toBeCloseTo(1.0, 5);
    expect(multi.vector[CLUSTER_INDEX["jazz-blues"]]).toBeGreaterThan(0.2);
    expect(multi.vector[CLUSTER_INDEX.electronic]).toBeGreaterThan(0.2);
    expect(multi.vector[CLUSTER_INDEX["hip-hop"]]).toBeGreaterThan(0.2);
  });

  it("handles missing or unrecognized genres gracefully", () => {
    const empty = parseGenreProfile("");
    expect(empty.isUnknown).toBe(true);
    expect(empty.dominantClusters).toEqual([]);
    expect(empty.vector.every((v) => v === 0)).toBe(true);
  });
});

describe("genreCluster — fallback inference across library", () => {
  it("infers missing track genres from album consensus, artist consensus, and folder path", () => {
    const tracks = [
      {
        id: 1,
        genre: "Indie Rock, Shoegaze",
        artist: "My Bloody Valentine",
        albumArtist: "My Bloody Valentine",
        album: "Loveless",
        path: "/music/rock/mbv/01.flac",
      },
      {
        id: 2,
        genre: "", // Should inherit from album "Loveless"
        artist: "My Bloody Valentine",
        albumArtist: "My Bloody Valentine",
        album: "Loveless",
        path: "/music/untagged/02.flac",
      },
      {
        id: 3,
        genre: "", // Different album, should inherit from artist "My Bloody Valentine"
        artist: "My Bloody Valentine",
        albumArtist: "My Bloody Valentine",
        album: "EP Collection",
        path: "/music/untagged/03.flac",
      },
      {
        id: 4,
        genre: "", // Unknown artist/album, should infer from folder "/Music/Jazz/..."
        artist: "Mystery Trio",
        albumArtist: "Mystery Trio",
        album: "Untitled Session",
        path: "/Users/listener/Music/Jazz/Mystery Trio/track01.flac",
      },
      {
        id: 5,
        genre: "", // Completely unknown everywhere
        artist: "Unknown Artist",
        albumArtist: "Unknown Artist",
        album: "Unknown Album",
        path: "/Users/listener/Downloads/audio01.mp3",
      },
    ];

    const { vectors, unknownFlags } = buildLibraryGenreVectors(tracks);
    expect(unknownFlags[0]).toBe(0);
    expect(unknownFlags[1]).toBe(0); // Album fallback
    expect(
      vectors[1 * NUM_GENRE_CLUSTERS + CLUSTER_INDEX.rock],
    ).toBeGreaterThan(0.6);

    expect(unknownFlags[2]).toBe(0); // Artist fallback
    expect(
      vectors[2 * NUM_GENRE_CLUSTERS + CLUSTER_INDEX.rock],
    ).toBeGreaterThan(0.6);

    expect(unknownFlags[3]).toBe(0); // Folder path fallback
    expect(
      vectors[3 * NUM_GENRE_CLUSTERS + CLUSTER_INDEX["jazz-blues"]],
    ).toBeCloseTo(1.0, 4);

    expect(unknownFlags[4]).toBe(1); // Remains unknown
  });
});

describe("genreCluster — bilinear compatibility, streak damping, and bridge transitions", () => {
  it("scores related genres higher than jarring genre jumps", () => {
    expect(clusterAffinity("pop", "electronic")).toBeGreaterThan(0.75);
    expect(clusterAffinity("hip-hop", "r&b-soul")).toBeGreaterThan(0.8);
    expect(clusterAffinity("metal", "ambient-chill")).toBeLessThan(0.3);
  });

  it("damps same-cluster compatibility after consecutive streak plays and keeps bridge tracks relevant", () => {
    const sessionVector = new Float32Array(NUM_GENRE_CLUSTERS);
    const exposureStreaks = new Float32Array(NUM_GENRE_CLUSTERS);
    let hasGenre = false;

    const pureRock = parseGenreProfile("Rock").vector;
    const rockPopBridge = parseGenreProfile(
      "Indie Pop, Alternative Rock",
    ).vector;
    const disjointJump = parseGenreProfile("Electronic").vector;

    hasGenre = updateGenreSessionState(
      sessionVector,
      exposureStreaks,
      hasGenre,
      pureRock,
      0,
      false,
    );
    const freshRockCompat = computeGenreCompatibilityFast(
      sessionVector,
      exposureStreaks,
      hasGenre,
      pureRock,
      0,
      false,
    );
    expect(freshRockCompat).toBeCloseTo(1.0, 2);

    for (let i = 0; i < 5; i++) {
      updateGenreSessionState(
        sessionVector,
        exposureStreaks,
        hasGenre,
        pureRock,
        0,
        false,
      );
    }

    const saturatedRockCompat = computeGenreCompatibilityFast(
      sessionVector,
      exposureStreaks,
      hasGenre,
      pureRock,
      0,
      false,
    );
    const bridgeCompat = computeGenreCompatibilityFast(
      sessionVector,
      exposureStreaks,
      hasGenre,
      rockPopBridge,
      0,
      false,
    );
    const jumpCompat = computeGenreCompatibilityFast(
      sessionVector,
      exposureStreaks,
      hasGenre,
      disjointJump,
      0,
      false,
    );

    expect(saturatedRockCompat).toBeLessThan(freshRockCompat);

    // A half-pivot bridge keeps a rock foothold and adds fresh pop mass. The shared-mass
    // attenuation scales it by 0.45 + 0.55 * d (~0.75 at d ~= 0.55), so a 7th straight rock track
    // edges it out; the bridge must still clear the primary gate and must stay far ahead of a jump
    // into a cluster that shares nothing with the session.
    expect(bridgeCompat).toBeGreaterThanOrEqual(
      DEFAULT_MIN_GENRE_COMPATIBILITY,
    );
    expect(bridgeCompat).toBeGreaterThan(jumpCompat);
    expect(jumpCompat).toBeLessThan(DEFAULT_RELAXED_GENRE_COMPATIBILITY);
  });

  it("assigns neutral compatibility to unknown-genre tracks so they are neither starved nor dominant", () => {
    const sessionVector = parseGenreProfile("Electronic").vector;
    const exposureStreaks = new Float32Array(NUM_GENRE_CLUSTERS);
    const unknownVec = new Float32Array(NUM_GENRE_CLUSTERS);

    const score = computeGenreCompatibilityFast(
      sessionVector,
      exposureStreaks,
      true,
      unknownVec,
      0,
      true,
    );
    expect(score).toBe(NEUTRAL_UNKNOWN_GENRE_COMPATIBILITY);
  });

  it("derives cross-genre relevance from shared cluster mass (label-keyed table, no genre special cases)", () => {
    const strengths = ZERO_STREAKS();
    const seed = parseGenreProfile("J-Pop, Idol").vector;

    const table: Array<{ label: string; expect: "primary" | "rejected" }> = [
      { label: "J-Pop, Idol", expect: "primary" },
      { label: "Anime, J-Pop", expect: "primary" },
      { label: "J-Rock", expect: "primary" },
      { label: "City Pop", expect: "primary" },
      { label: "Pop", expect: "rejected" },
      { label: "Pop, R&B", expect: "rejected" },
      { label: "Phonk", expect: "rejected" },
      { label: "Drift Phonk", expect: "rejected" },
      { label: "Electronic", expect: "rejected" },
    ];

    const measured = table.map((row) => {
      const candidate = parseGenreProfile(row.label).vector;
      return {
        ...row,
        shared: sharedGenreMass(seed, 0, candidate, 0),
        score: computeGenreCompatibilityFast(
          seed,
          strengths,
          true,
          candidate,
          0,
          false,
        ),
      };
    });

    for (const row of measured) {
      if (row.expect === "primary") {
        expect(row.score, row.label).toBeGreaterThanOrEqual(
          DEFAULT_MIN_GENRE_COMPATIBILITY,
        );
      } else {
        expect(row.score, row.label).toBeLessThan(
          DEFAULT_RELAXED_GENRE_COMPATIBILITY,
        );
      }
    }

    // Which rows pass is decided by shared mass, not by genre identity: every "primary" row shares
    // more mass with the seed than the most generous "rejected" row.
    const weakestPrimary = Math.min(
      ...measured
        .filter((row) => row.expect === "primary")
        .map((row) => row.shared),
    );
    const strongestRejected = Math.max(
      ...measured
        .filter((row) => row.expect === "rejected")
        .map((row) => row.shared),
    );
    expect(weakestPrimary).toBeGreaterThan(strongestRejected);
  });

  it("attenuates by shared mass alone, whatever clusters supply that mass", () => {
    const strengths = ZERO_STREAKS();
    const seed = parseGenreProfile("Pop, Indie Pop").vector;
    const seedClusters = GENRE_CLUSTERS.filter(
      (name) => seed[CLUSTER_INDEX[name]] > 1e-4,
    );

    // Identical shared mass (0.5 in a cluster the seed occupies) supplied through a different
    // partner cluster each time: the attenuation must not care which clusters are involved.
    for (const target of seedClusters) {
      for (const other of GENRE_CLUSTERS) {
        if (seed[CLUSTER_INDEX[other]] > 1e-4) continue;
        const candidate = new Float32Array(NUM_GENRE_CLUSTERS);
        candidate[CLUSTER_INDEX[target]] = 0.5;
        candidate[CLUSTER_INDEX[other]] = 0.5;
        const score = computeGenreCompatibilityFast(
          seed,
          strengths,
          true,
          candidate,
          0,
          false,
        );
        expect(score, `${target}/${other}`).toBeCloseTo(
          referenceCompatibility(seed, candidate),
          9,
        );
      }
    }

    // Randomised sweep: the same rule holds for arbitrary multi-cluster distributions.
    const random = makeRandom(0x5eed);
    for (let n = 0; n < 120; n++) {
      const randomSeed = randomVector(random, 3);
      const randomCandidate = randomVector(
        random,
        2 + Math.floor(random() * 5),
      );
      const score = computeGenreCompatibilityFast(
        randomSeed,
        strengths,
        true,
        randomCandidate,
        0,
        false,
      );
      expect(score, `random #${n}`).toBeCloseTo(
        referenceCompatibility(randomSeed, randomCandidate),
        9,
      );
    }
  });

  it("matches the documented rule for every pure-cluster pair, symmetrically, and rejects zero shared mass", () => {
    const strengths = ZERO_STREAKS();
    let disjointPairs = 0;

    for (const seedName of GENRE_CLUSTERS) {
      const seed = parseGenreProfile(seedName).vector;
      for (const candidateName of GENRE_CLUSTERS) {
        const candidate = parseGenreProfile(candidateName).vector;
        const score = computeGenreCompatibilityFast(
          seed,
          strengths,
          true,
          candidate,
          0,
          false,
        );
        expect(score, `${seedName} -> ${candidateName}`).toBeCloseTo(
          referenceCompatibility(seed, candidate),
          9,
        );

        // Symmetry: with no exposure history the model cannot prefer one direction.
        const reverse = computeGenreCompatibilityFast(
          candidate,
          strengths,
          true,
          seed,
          0,
          false,
        );
        expect(
          Math.abs(score - reverse),
          `${seedName} <-> ${candidateName}`,
        ).toBeLessThan(1e-12);

        if (
          seedName !== candidateName &&
          sharedGenreMass(seed, 0, candidate, 0) < 1e-6
        ) {
          disjointPairs++;
          expect(score, `${seedName} -> ${candidateName}`).toBeLessThan(
            DEFAULT_RELAXED_GENRE_COMPATIBILITY,
          );
        }
      }
    }
    expect(disjointPairs).toBeGreaterThan(100);

    // The sharpest case (pure Pop seed): the old damping let these through at 0.5616 / 0.4306.
    const pop = parseGenreProfile("Pop").vector;
    const scoreOf = (label: string) =>
      computeGenreCompatibilityFast(
        pop,
        strengths,
        true,
        parseGenreProfile(label).vector,
        0,
        false,
      );
    expect(scoreOf("Electronic")).toBeCloseTo(
      clusterAffinity("pop", "electronic") * DISJOINT_CLUSTER_FLOOR,
      6,
    );
    expect(scoreOf("Phonk")).toBeLessThan(DEFAULT_RELAXED_GENRE_COMPATIBILITY);
    expect(scoreOf("Pop")).toBeCloseTo(1.0, 6);
  });

  it("never damps same-genre streaks below unrelated genres", () => {
    const sessionVector = new Float32Array(NUM_GENRE_CLUSTERS);
    const exposureStreaks = new Float32Array(NUM_GENRE_CLUSTERS);
    const jpop = parseGenreProfile("J-Pop").vector;
    const westernPop = parseGenreProfile("Pop").vector;
    const phonk = parseGenreProfile("Phonk").vector;

    let hasGenre = false;
    for (let i = 0; i < 8; i++) {
      hasGenre = updateGenreSessionState(
        sessionVector,
        exposureStreaks,
        hasGenre,
        jpop,
        0,
        false,
      );
    }

    const sameGenreAfterLongStreak = computeGenreCompatibilityFast(
      sessionVector,
      exposureStreaks,
      hasGenre,
      jpop,
      0,
      false,
    );
    const unrelatedPopAfterStreak = computeGenreCompatibilityFast(
      sessionVector,
      exposureStreaks,
      hasGenre,
      westernPop,
      0,
      false,
    );
    const phonkAfterStreak = computeGenreCompatibilityFast(
      sessionVector,
      exposureStreaks,
      hasGenre,
      phonk,
      0,
      false,
    );

    expect(sameGenreAfterLongStreak).toBeGreaterThan(0.6);
    expect(sameGenreAfterLongStreak).toBeGreaterThan(
      unrelatedPopAfterStreak + 0.25,
    );
    expect(sameGenreAfterLongStreak).toBeGreaterThan(phonkAfterStreak + 0.4);
  });
});
