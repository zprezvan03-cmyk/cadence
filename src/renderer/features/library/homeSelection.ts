/**
 * Deterministic rotation for the Home album shelves. The featured album and "Explore your albums"
 * come from the same pick, so they must survive HomeView remounts on navigation.
 */

import type { Album } from "../../../shared/types";
import { shuffle, type Rng } from "../../player/queue";

/** Local calendar day, used so the rollover follows the user's clock rather than UTC. */
export function localDayKey(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** FNV-1a: a fixed seed per day, so no settings write is needed at midnight. */
export function dailySeed(dayKey: string): number {
  let hash = 2166136261;
  for (let index = 0; index < dayKey.length; index++) {
    hash ^= dayKey.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Fresh seed for the manual Settings action. */
export function createRefreshSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

export interface HomeSeedSource {
  featuredSeed: number | null;
  featuredSeedDay: string | null;
}

/** A manual seed only wins on the day it was created; older seeds fall back to the daily one. */
export function resolveFeaturedSeed(home: HomeSeedSource | null | undefined, today: string): number {
  if (
    home &&
    home.featuredSeedDay === today &&
    typeof home.featuredSeed === "number" &&
    Number.isFinite(home.featuredSeed)
  ) {
    return home.featuredSeed >>> 0;
  }
  return dailySeed(today);
}

function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Same dedup key and limit as the old mount-time shuffle, now driven by a stable seed. */
export function pickFeaturedAlbums(albums: readonly Album[], seed: number, limit = 10): Album[] {
  const seen = new Set<string>();
  const unique: Album[] = [];
  for (const album of albums) {
    if (seen.has(album.name)) continue;
    seen.add(album.name);
    unique.push(album);
  }
  return shuffle(unique, mulberry32(seed)).slice(0, limit);
}
