/**
 * Runtime-agnostic persistent lyrics cache core for Cadence.
 * Shared between the Tauri WebView2 bridge and Node unit/integration tests.
 */

import {
  LYRICS_CACHE_TTL_MS,
  LYRICS_NEGATIVE_CACHE_TTL_MS,
} from "../../shared/upstream/better-lyrics/constants";
import type { LyricsCandidate } from "../../shared/types";

interface CacheEntry {
  savedAt: number;
  negative: boolean;
  candidates: LyricsCandidate[];
  queriedKeys?: string[];
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheEntry>;
}

const MAX_ENTRIES = 800;

export interface LyricsCachePersistence {
  initialJson?: string | null;
  persist?: (json: string) => void | Promise<void>;
}

export class LyricsCacheCore {
  private data: CacheFile = { version: 1, entries: {} };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(private readonly persistence: LyricsCachePersistence = {}) {
    if (persistence.initialJson) {
      try {
        const parsed = JSON.parse(persistence.initialJson) as CacheFile;
        if (parsed?.version === 1 && parsed.entries) this.data = parsed;
      } catch {
        this.data = { version: 1, entries: {} };
      }
    }
  }

  static key(artist: string, title: string, album: string, duration: number): string {
    return `${artist.toLocaleLowerCase()}|${title.toLocaleLowerCase()}|${album.toLocaleLowerCase()}|${Math.round(duration)}`;
  }

  static searchKey(artist: string, title: string, album: string, duration: number): string {
    return `search:${this.key(artist, title, album, duration)}`;
  }

  get(key: string, requiredKeys?: readonly string[]): LyricsCandidate[] | null {
    const entry = this.data.entries[key];
    if (!entry) return null;
    const ttl = entry.negative ? LYRICS_NEGATIVE_CACHE_TTL_MS : LYRICS_CACHE_TTL_MS;
    if (Date.now() - entry.savedAt > ttl) {
      delete this.data.entries[key];
      this.markDirty();
      return null;
    }
    if (requiredKeys && entry.queriedKeys) {
      const queried = new Set(entry.queriedKeys);
      if (requiredKeys.some(required => !queried.has(required))) {
        return null;
      }
    }
    return entry.negative ? [] : entry.candidates.map(candidate => ({ ...candidate, cached: true }));
  }

  set(key: string, candidates: LyricsCandidate[], queriedKeys?: readonly string[]): void {
    this.data.entries[key] = {
      savedAt: Date.now(),
      negative: candidates.length === 0,
      candidates,
      ...(queriedKeys ? { queriedKeys: [...queriedKeys] } : {}),
    };
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
    if (!this.persistence.persist) return;
    try {
      const result = this.persistence.persist(JSON.stringify(this.data));
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(error => {
          console.warn("[Cadence] Could not persist lyrics cache:", error);
        });
      }
    } catch (error) {
      console.warn("[Cadence] Could not persist lyrics cache:", error);
    }
  }
}
