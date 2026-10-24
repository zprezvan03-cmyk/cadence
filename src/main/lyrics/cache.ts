/**
 * Persistent lyrics cache for Cadence, so a song played offline still has the lyrics that were
 * fetched while online. Written for Cadence.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  LYRICS_CACHE_TTL_MS,
  LYRICS_NEGATIVE_CACHE_TTL_MS,
} from "../../shared/upstream/better-lyrics/constants";
import type { LyricsCandidate } from "../../shared/types";

interface CacheEntry {
  savedAt: number;
  negative: boolean;
  candidates: LyricsCandidate[];
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const MAX_ENTRIES = 800;

export class LyricsCache {
  private data: CacheFile = { version: 1, entries: {} };
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      try {
        const parsed = JSON.parse(readFileSync(filePath, "utf8")) as CacheFile;
        if (parsed?.version === 1 && parsed.entries) this.data = parsed;
      } catch {
        this.data = { version: 1, entries: {} };
      }
    }
  }

  static key(artist: string, title: string, album: string, duration: number): string {
    return `${artist.toLocaleLowerCase()}|${title.toLocaleLowerCase()}|${album.toLocaleLowerCase()}|${Math.round(duration)}`;
  }

  /**
   * Manual-search rows live under a prefixed namespace so they never collide with automatic
   * resolution entries (the same words may be searched with different metadata).
   */
  static searchKey(artist: string, title: string, album: string, duration: number): string {
    return `search:${this.key(artist, title, album, duration)}`;
  }

  get(key: string): LyricsCandidate[] | null {
    const entry = this.data.entries[key];
    if (!entry) return null;
    const ttl = entry.negative ? LYRICS_NEGATIVE_CACHE_TTL_MS : LYRICS_CACHE_TTL_MS;
    if (Date.now() - entry.savedAt > ttl) {
      delete this.data.entries[key];
      this.markDirty();
      return null;
    }
    return entry.negative ? [] : entry.candidates.map(candidate => ({ ...candidate, cached: true }));
  }

  set(key: string, candidates: LyricsCandidate[]): void {
    this.data.entries[key] = { savedAt: Date.now(), negative: candidates.length === 0, candidates };
    const keys = Object.keys(this.data.entries);
    if (keys.length > MAX_ENTRIES) {
      keys
        .sort((a, b) => this.data.entries[a].savedAt - this.data.entries[b].savedAt)
        .slice(0, keys.length - MAX_ENTRIES)
        .forEach(stale => delete this.data.entries[stale]);
    }
    this.markDirty();
  }

  clear(): void {
    this.data = { version: 1, entries: {} };
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      writeFileSync(temporary, JSON.stringify(this.data));
      renameSync(temporary, this.filePath);
    } catch (error) {
      console.warn("[Cadence] Could not persist lyrics cache:", error);
    }
  }
}
