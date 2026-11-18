/**
 * AutoPlay genre anchoring: the context is the user's queue as a whole.
 *
 * These tests are genre-label based and artist-name free: every fixture is described by its genre
 * tags only. The numbers they assert are derived from the shared-mass relevance model, which
 * `tests/unit/genreCluster.test.ts` pins exactly.
 */
import { describe, expect, it } from "vitest";
import {
  buildLibraryShuffleIndex,
  buildQueueAnchorGenreVector,
  DEFAULT_RELAXED_GENRE_COMPATIBILITY,
  selectAutoPlayTracksWithDiagnostics,
  type SmartShuffleTrack,
} from "../../src/shared/smartShuffle";
import {
  CLUSTER_INDEX,
  NUM_GENRE_CLUSTERS,
  parseGenreProfile,
} from "../../src/shared/genreCluster";

const NOW = 1_700_000_000_000;

function makeTrack(
  overrides: Partial<SmartShuffleTrack> & { id: number; genre: string },
): SmartShuffleTrack {
  return {
    id: overrides.id,
    title: overrides.title ?? `Track ${overrides.id}`,
    artist: overrides.artist ?? `Artist ${overrides.id}`,
    albumArtist:
      overrides.albumArtist ?? overrides.artist ?? `Artist ${overrides.id}`,
    album: overrides.album ?? `Album ${overrides.id}`,
    genre: overrides.genre,
    duration: overrides.duration ?? 210,
    favorite: overrides.favorite ?? false,
    addedAt: overrides.addedAt ?? NOW - 30 * 24 * 60 * 60 * 1000,
    lastPlayedAt: overrides.lastPlayedAt ?? null,
    playCount: overrides.playCount ?? 0,
    path: overrides.path ?? `/music/${overrides.id}.flac`,
    playable: overrides.playable ?? true,
  };
}

function makeRng(seed = 42): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function anchorVectorOf(tracks: readonly SmartShuffleTrack[]): Float32Array {
  const index = buildLibraryShuffleIndex(tracks, { now: NOW });
  const vector = new Float32Array(NUM_GENRE_CLUSTERS);
  buildQueueAnchorGenreVector(
    index,
    tracks.map((track) => track.id),
    vector,
  );
  return vector;
}

const POP = "Pop";
const JPOP = "J-Pop";
const PHONK = "Phonk";
const ELECTRONIC = "Electronic";

/** Pop 1-3 + 10-11, J-Pop 4-6 + 12, and an Electronic/Phonk minority that must never be relevant. */
const LIBRARY: SmartShuffleTrack[] = [
  makeTrack({ id: 1, genre: POP }),
  makeTrack({ id: 2, genre: POP }),
  makeTrack({ id: 3, genre: "Pop, Indie Pop" }),
  makeTrack({ id: 4, genre: JPOP }),
  makeTrack({ id: 5, genre: "J-Pop, Idol" }),
  makeTrack({ id: 6, genre: "Anime, J-Pop" }),
  makeTrack({ id: 7, genre: PHONK }),
  makeTrack({ id: 8, genre: "Drift Phonk" }),
  makeTrack({ id: 9, genre: ELECTRONIC }),
  makeTrack({ id: 10, genre: POP }),
  makeTrack({ id: 11, genre: "Pop, Indie Pop" }),
  makeTrack({ id: 12, genre: JPOP }),
];

const POP_IDS = [1, 2, 3];
const JPOP_IDS = [4, 5, 6];
const UNRELATED_IDS = [7, 8, 9];

function select(
  anchorIds: number[],
  extra: Partial<
    Parameters<typeof selectAutoPlayTracksWithDiagnostics>[1]
  > = {},
) {
  return selectAutoPlayTracksWithDiagnostics(LIBRARY, {
    count: 5,
    anchorTrackIds: anchorIds,
    excludeTrackIds: new Set(anchorIds),
    seedTrackIds: [],
    rng: makeRng(7),
    now: NOW,
    ...extra,
  });
}

function compatOf(
  result: ReturnType<typeof select>,
  id: number,
): number | undefined {
  const entries = [
    ...result.diagnostics.selectedDiagnostics,
    ...result.diagnostics.rejectedDiagnostics,
  ];
  return entries.find((entry) => entry.candidateTrack.id === id)
    ?.genreCompatibility;
}

describe("AutoPlay anchor — the queue as a whole", () => {
  it("1. builds one collective profile from every queued track, not from a single seed", () => {
    const mixed = [
      makeTrack({ id: 1, genre: POP }),
      makeTrack({ id: 2, genre: POP }),
      makeTrack({ id: 3, genre: JPOP }),
      makeTrack({ id: 4, genre: JPOP }),
    ];
    const vector = anchorVectorOf(mixed);

    // Expected values are derived from the parser, not hard-coded: a plain mean of the two cluster
    // distributions, one unit of weight per track.
    const pop = parseGenreProfile(POP).vector;
    const jpop = parseGenreProfile(JPOP).vector;
    for (let c = 0; c < NUM_GENRE_CLUSTERS; c++) {
      expect(vector[c]).toBeCloseTo((2 * pop[c] + 2 * jpop[c]) / 4, 6);
    }
    expect(vector[CLUSTER_INDEX.pop]).toBeGreaterThan(
      vector[CLUSTER_INDEX["jpop-kpop-anime"]],
    );

    // A 3:1 mix shifts the profile towards the majority cluster (uniform weight per track).
    const popHeavy = [
      ...mixed.slice(0, 2),
      makeTrack({ id: 5, genre: POP }),
      mixed[2],
    ];
    const popHeavyVector = anchorVectorOf(popHeavy);
    expect(popHeavyVector[CLUSTER_INDEX.pop]).toBeGreaterThan(
      vector[CLUSTER_INDEX.pop],
    );
    expect(popHeavyVector[CLUSTER_INDEX["jpop-kpop-anime"]]).toBeLessThan(
      vector[CLUSTER_INDEX["jpop-kpop-anime"]],
    );

    // Untagged tracks carry no evidence and are skipped rather than diluting the profile.
    const withUnknown = [...mixed, makeTrack({ id: 6, genre: "" })];
    expect(Array.from(anchorVectorOf(withUnknown))).toEqual(Array.from(vector));
  });

  it("2. the first queue entry is not decisive: every ordering of the same queue gives the same anchor", () => {
    const a = makeTrack({ id: 1, genre: POP });
    const b = makeTrack({ id: 2, genre: JPOP });
    const c = makeTrack({ id: 3, genre: JPOP });
    const d = makeTrack({ id: 4, genre: "Pop, Indie Pop" });

    const forward = anchorVectorOf([a, b, c, d]);
    for (const order of [
      [b, c, d, a],
      [c, a, d, b],
      [d, c, b, a],
    ]) {
      expect(Array.from(anchorVectorOf(order))).toEqual(Array.from(forward));
    }
  });

  it("3/4. adding and removing a queue track changes the profile and the eligibility it implies", () => {
    const popOnly = select(POP_IDS);
    const withIdols = select([...POP_IDS, ...JPOP_IDS]);

    // Adding three J-Pop tracks to a three-track Pop queue moves the profile from ~95% pop to a
    // near-even Pop / J-Pop mix, which is what makes the J-Pop candidates relevant.
    expect(withIdols.diagnostics.anchorClusters).not.toEqual(
      popOnly.diagnostics.anchorClusters,
    );
    expect(popOnly.trackIds.some((id) => JPOP_IDS.includes(id))).toBe(false);
    expect(
      withIdols.trackIds.some((id) => JPOP_IDS.includes(id) || id === 12),
    ).toBe(true);

    // Removing them again restores exactly the earlier profile - the mutation is symmetric.
    const afterRemoval = select(POP_IDS, { excludeTrackIds: new Set(POP_IDS) });
    expect(afterRemoval.diagnostics.anchorClusters).toEqual(
      popOnly.diagnostics.anchorClusters,
    );

    // Reordering the same queue leaves the profile and the eligible set untouched.
    const reordered = select([3, 1, 2]);
    expect(reordered.diagnostics.anchorClusters).toEqual(
      popOnly.diagnostics.anchorClusters,
    );
    expect([...reordered.trackIds].sort()).toEqual(
      [...popOnly.trackIds].sort(),
    );
  });

  it("5. candidates are scored against the anchor only, independent of the AutoPlay tail and of history", () => {
    const anchor = POP_IDS;
    const base = select(anchor);
    const withTailAndHistory = select(anchor, {
      recentPlayedTrackIds: [7, 8, 9],
      excludeTrackIds: new Set(anchor),
    });

    // Phonk/Electronic ids are excluded as "recently played" in the second run, so compare the
    // J-Pop neighbours, which are evaluated in both.
    for (const id of [...JPOP_IDS, 12]) {
      const left = compatOf(base, id);
      const right = compatOf(withTailAndHistory, id);
      expect(left).toBeDefined();
      expect(right, `candidate ${id}`).toBe(left);
    }

    // A Pop history does not move them either, and the Phonk candidates stay rejected in both runs.
    const withPopHistory = select(anchor, { recentPlayedTrackIds: [10, 11] });
    for (const id of [...JPOP_IDS, 12]) {
      expect(compatOf(withPopHistory, id)).toBe(compatOf(base, id));
    }
    for (const id of UNRELATED_IDS) {
      expect(compatOf(base, id)).toBeLessThan(
        DEFAULT_RELAXED_GENRE_COMPATIBILITY,
      );
      expect(compatOf(withPopHistory, id)).toBe(compatOf(base, id));
    }
  });

  it("6. repeated replenishment never drifts, even when every batch is appended to the queue", () => {
    const anchorProfiles: string[] = [];

    for (let batch = 0; batch < 5; batch += 1) {
      const result = select(POP_IDS, { rng: makeRng(100 + batch) });
      anchorProfiles.push(JSON.stringify(result.diagnostics.anchorClusters));
      expect(result.diagnostics.anchorSource).toBe("manual-queue");
      expect(result.diagnostics.anchorTrackCount).toBe(POP_IDS.length);
      // The batch itself may vary (weighted sampling), but the profile it was scored against cannot.
      expect(result.trackIds.some((id) => UNRELATED_IDS.includes(id))).toBe(
        false,
      );
    }

    expect(new Set(anchorProfiles).size).toBe(1);
  });

  it("7. an empty (or untagged) queue is an explicit, isolated fallback — never the AutoPlay tail", () => {
    const empty = select([]);
    expect(empty.diagnostics.anchorSource).toBe("none");
    expect(empty.diagnostics.anchorTrackCount).toBe(0);
    expect(empty.diagnostics.anchorClusters).toEqual([]);

    // No genre context means no genre gating at all: everything is equally eligible and nothing is
    // reported as rejected for relevance. In particular the engine must not fall back to the
    // playing track's genre - `seedTrackIds` is still passed here and must be ignored for anchoring.
    const emptyWithSeed = select([], { seedTrackIds: [1] });
    expect(emptyWithSeed.diagnostics.anchorSource).toBe("none");
    expect(emptyWithSeed.diagnostics.relaxationStage).toBe("seed-unknown");
    expect(emptyWithSeed.diagnostics.rejectedIncompatibleCount).toBe(0);

    // An anchor made only of untagged tracks is the same fallback, not a diluted profile.
    const untagged: SmartShuffleTrack[] = [
      makeTrack({ id: 20, genre: "" }),
      makeTrack({ id: 21, genre: "Unknown Genre" }),
    ];
    const index = buildLibraryShuffleIndex(untagged, { now: NOW });
    const vector = new Float32Array(NUM_GENRE_CLUSTERS);
    expect(buildQueueAnchorGenreVector(index, [20, 21], vector)).toBe(0);
    expect(Array.from(vector).every((value) => value === 0)).toBe(true);
  });

  it("8. duplicate prevention and the relevance gate keep working in anchor mode", () => {
    const result = select(POP_IDS);

    expect(result.trackIds.some((id) => POP_IDS.includes(id))).toBe(false);
    expect(new Set(result.trackIds).size).toBe(result.trackIds.length);

    for (const id of UNRELATED_IDS) {
      expect(result.trackIds).not.toContain(id);
      expect(compatOf(result, id)).toBeLessThan(
        DEFAULT_RELAXED_GENRE_COMPATIBILITY,
      );
    }

    const rejectedIds = result.diagnostics.rejectedDiagnostics
      .filter((entry) => entry.decision === "rejected")
      .map((entry) => entry.candidateTrack.id);
    expect(rejectedIds).toEqual(expect.arrayContaining(UNRELATED_IDS));

    for (const entry of result.diagnostics.selectedDiagnostics) {
      expect(entry.genreCompatibility).toBeGreaterThanOrEqual(
        DEFAULT_RELAXED_GENRE_COMPATIBILITY,
      );
    }
    expect(result.diagnostics.compatibleCandidateCount).toBeGreaterThan(0);
  });

  it("9. a coherent Pop/J-Pop queue keeps rejecting Phonk however much Phonk AutoPlay appends", () => {
    const popProfile = JSON.stringify(
      select(POP_IDS).diagnostics.anchorClusters,
    );
    let phonkSeen = 0;
    const phonkTail: number[] = [];

    for (let batch = 0; batch < 6; batch += 1) {
      const result = select(POP_IDS, {
        // The tail grows every round; it must not become context.
        recentPlayedTrackIds: [...phonkTail],
        rng: makeRng(31 + batch),
      });
      phonkSeen += result.trackIds.filter((id) =>
        UNRELATED_IDS.includes(id),
      ).length;
      phonkTail.push(7, 8, 9);
      expect(JSON.stringify(result.diagnostics.anchorClusters)).toBe(
        popProfile,
      );
    }

    expect(phonkSeen).toBe(0);
  });

  it("10. a single-track anchor is exactly the legacy single-seed anchor", () => {
    const anchored = select([1]);
    const legacy = selectAutoPlayTracksWithDiagnostics(LIBRARY, {
      count: 5,
      seedTrackIds: [1],
      excludeTrackIds: new Set([1]),
      rng: makeRng(7),
      now: NOW,
    });

    expect(anchored.diagnostics.anchorSource).toBe("manual-queue");
    expect(anchored.diagnostics.anchorTrackCount).toBe(1);
    expect(anchored.diagnostics.anchorClusters).toEqual(
      legacy.diagnostics.currentTrack.clusters,
    );
    expect([...anchored.trackIds].sort()).toEqual([...legacy.trackIds].sort());

    // Two all-Pop queue tracks describe exactly the same profile as one. (The selection differs
    // only because track 2 is now part of the queue and therefore excluded from candidacy.)
    const twoTracks = select([1, 2]);
    expect(twoTracks.diagnostics.anchorClusters).toEqual(
      anchored.diagnostics.anchorClusters,
    );
    expect(twoTracks.diagnostics.compatibleCandidateCount).toBe(
      anchored.diagnostics.compatibleCandidateCount - 1,
    );
    expect(twoTracks.trackIds).not.toContain(2);
    for (const id of twoTracks.trackIds) {
      expect(compatOf(twoTracks, id)).toBeGreaterThanOrEqual(
        DEFAULT_RELAXED_GENRE_COMPATIBILITY,
      );
    }
  });
});
