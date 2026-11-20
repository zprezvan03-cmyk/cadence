import { describe, expect, it } from "vitest";
import type { Album } from "../../src/shared/types";
import {
  createRefreshSeed,
  dailySeed,
  localDayKey,
  pickFeaturedAlbums,
  resolveFeaturedSeed,
} from "../../src/renderer/features/library/homeSelection";

function album(name: string): Album {
  return {
    id: `artist\u0000${name}`,
    name,
    albumArtist: "artist",
    year: null,
    artworkUrl: null,
    accentColor: null,
    trackCount: 1,
    duration: 100,
  };
}

const albums = Array.from({ length: 24 }, (_, index) => album(`Album ${index}`));

describe("Home featured album rotation", () => {
  it("uses the local calendar day as the rotation key", () => {
    expect(localDayKey(new Date(2026, 10, 20, 23, 59))).toBe("2026-11-20");
    expect(localDayKey(new Date(2026, 0, 3))).toBe("2026-01-03");
    expect(dailySeed("2026-11-20")).toBe(dailySeed("2026-11-20"));
    expect(dailySeed("2026-11-20")).not.toBe(dailySeed("2026-11-21"));
  });

  it("prefers a manual seed only on the day it was created", () => {
    const home = { featuredSeed: 42, featuredSeedDay: "2026-11-20" };
    expect(resolveFeaturedSeed(home, "2026-11-20")).toBe(42);
    expect(resolveFeaturedSeed(home, "2026-11-21")).toBe(dailySeed("2026-11-21"));
    expect(resolveFeaturedSeed({ featuredSeed: 42, featuredSeedDay: null }, "2026-11-20")).toBe(
      dailySeed("2026-11-20"),
    );
    expect(resolveFeaturedSeed(null, "2026-11-20")).toBe(dailySeed("2026-11-20"));
  });

  it("returns the same ten albums for the same seed, regardless of how often Home remounts", () => {
    const first = pickFeaturedAlbums(albums, 1234);
    expect(first).toHaveLength(10);
    expect(pickFeaturedAlbums(albums, 1234)).toEqual(first);
    expect(pickFeaturedAlbums(albums, 9876)).not.toEqual(first);
  });

  it("keeps the first copy of a duplicate album name", () => {
    const firstCopy = album("Same");
    const withDuplicates = [firstCopy, albums[1], album("Same"), ...albums.slice(2)];
    const picked = pickFeaturedAlbums(withDuplicates, 7, 24);
    expect(picked.filter(item => item.name === "Same")).toEqual([firstCopy]);
  });

  it("creates a 32-bit refresh seed", () => {
    const seed = createRefreshSeed();
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(0x100000000);
  });
});
