import { describe, expect, it } from "vitest";
import {
  buildLibraryGenreVectors,
  CLUSTER_INDEX,
  clusterAffinity,
  computeGenreCompatibilityFast,
  NEUTRAL_UNKNOWN_GENRE_COMPATIBILITY,
  NUM_GENRE_CLUSTERS,
  normalizeGenreToken,
  parseGenreProfile,
  tokenizeGenreString,
  updateGenreSessionState,
} from "../../src/shared/genreCluster";

describe("genreCluster — tokenization and normalization", () => {
  it("normalizes punctuation, casing, and ID3v1 numeric genre codes", () => {
    expect(normalizeGenreToken("(17)")).toBe("rock");
    expect(normalizeGenreToken("(13)Pop")).toBe("pop");
    expect(normalizeGenreToken("145")).toBe("anime");
    expect(normalizeGenreToken("Synth-Pop")).toBe("synth pop");
    expect(normalizeGenreToken("Post_Rock")).toBe("post rock");
  });

  it("splits multi-genre strings across commas, slashes, semicolons, and pipes while preserving R&B and Drum & Bass", () => {
    expect(tokenizeGenreString("Alternative Rock, Shoegaze / Dream Pop; Electronic")).toEqual([
      "alternative rock",
      "shoegaze",
      "dream pop",
      "electronic",
    ]);
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
    expect(dreamPop.vector[CLUSTER_INDEX["ambient-chill"]]).toBeGreaterThan(0.15);
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
    expect(empty.vector.every(v => v === 0)).toBe(true);
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
    expect(vectors[1 * NUM_GENRE_CLUSTERS + CLUSTER_INDEX.rock]).toBeGreaterThan(0.6);

    expect(unknownFlags[2]).toBe(0); // Artist fallback
    expect(vectors[2 * NUM_GENRE_CLUSTERS + CLUSTER_INDEX.rock]).toBeGreaterThan(0.6);

    expect(unknownFlags[3]).toBe(0); // Folder path fallback
    expect(vectors[3 * NUM_GENRE_CLUSTERS + CLUSTER_INDEX["jazz-blues"]]).toBeCloseTo(1.0, 4);

    expect(unknownFlags[4]).toBe(1); // Remains unknown
  });
});

describe("genreCluster — bilinear compatibility, streak damping, and bridge transitions", () => {
  it("scores related genres higher than jarring genre jumps", () => {
    expect(clusterAffinity("pop", "electronic")).toBeGreaterThan(0.75);
    expect(clusterAffinity("hip-hop", "r&b-soul")).toBeGreaterThan(0.80);
    expect(clusterAffinity("metal", "ambient-chill")).toBeLessThan(0.30);
  });

  it("damps same-cluster compatibility after consecutive streak plays and rewards bridge tracks", () => {
    const sessionVector = new Float32Array(NUM_GENRE_CLUSTERS);
    const exposureStreaks = new Float32Array(NUM_GENRE_CLUSTERS);
    let hasGenre = false;

    const pureRock = parseGenreProfile("Rock").vector;
    const rockPopBridge = parseGenreProfile("Indie Pop, Alternative Rock").vector;

    // First rock track played
    hasGenre = updateGenreSessionState(
      sessionVector,
      exposureStreaks,
      hasGenre,
      pureRock,
      0,
      false
    );

    const freshRockCompat = computeGenreCompatibilityFast(
      sessionVector,
      exposureStreaks,
      hasGenre,
      pureRock,
      0,
      false
    );
    expect(freshRockCompat).toBeCloseTo(1.0, 2);

    // Simulate 5 consecutive pure rock tracks
    for (let i = 0; i < 5; i++) {
      updateGenreSessionState(sessionVector, exposureStreaks, hasGenre, pureRock, 0, false);
    }

    const saturatedRockCompat = computeGenreCompatibilityFast(
      sessionVector,
      exposureStreaks,
      hasGenre,
      pureRock,
      0,
      false
    );
    const bridgeCompat = computeGenreCompatibilityFast(
      sessionVector,
      exposureStreaks,
      hasGenre,
      rockPopBridge,
      0,
      false
    );

    expect(saturatedRockCompat).toBeLessThan(freshRockCompat);
    // Bridge track blending rock + fresh pop scores competitively or higher than a 7th straight pure rock track
    expect(bridgeCompat).toBeGreaterThan(saturatedRockCompat);
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
      true
    );
    expect(score).toBe(NEUTRAL_UNKNOWN_GENRE_COMPATIBILITY);
  });
});
