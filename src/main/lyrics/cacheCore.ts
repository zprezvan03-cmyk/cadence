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
}

/**
 * `version` 2: entries written by earlier builds attributed every `/getLyrics` TTML to
 * `blyrics-richsynced`, so replaying them would resurrect the wrong provider identity for up to
 * the 30-day TTL. Older files are dropped rather than migrated — the lyrics are one request away.
 */
interface CacheFile {
  version: 2;
  entries: Record<string, CacheEntry>;
}

const CACHE_VERSION = 2;

const MAX_ENTRIES = 800;

export interface LyricsCachePersistence {
  initialJson?: string | null;
  persist?: (json: string) => void | Promise<void>;
}

export class LyricsCacheCore {
  private data: CacheFile = { version: CACHE_VERSION, entries: {} };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  /**
   * Bumped by {@link clear}. A lookup that was already in flight when the user cleared the cache
   * carries the previous token, so its result is dropped instead of writing the entries the user
   * just deleted straight back to disk.
   */
  private generation = 0;

  constructor(private readonly persistence: LyricsCachePersistence = {}) {
    if (persistence.initialJson) {
      try {
        const parsed = JSON.parse(persistence.initialJson) as CacheFile;
        if (parsed?.version === CACHE_VERSION && parsed.entries) this.data = parsed;
      } catch {
        this.data = { version: CACHE_VERSION, entries: {} };
      }
    }
  }

  static key(artist: string, title: string, album: string, duration: number): string {
    return `${artist.toLocaleLowerCase()}|${title.toLocaleLowerCase()}|${album.toLocaleLowerCase()}|${Math.round(duration)}`;
  }

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

  /** Token to hand back to {@link set} when the write is the result of a long-running lookup. */
  currentGeneration(): number {
    return this.generation;
  }

  /** Number of cached songs, used to report what a clear actually removed. */
  size(): number {
    return Object.keys(this.data.entries).length;
  }

  set(key: string, candidates: LyricsCandidate[], generation: number = this.generation): void {
    // The cache was cleared while this lookup was running: keep it cleared.
    if (generation !== this.generation) return;
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
    this.generation += 1;
    this.data = { version: CACHE_VERSION, entries: {} };
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

  /** Fire-and-forget persistence for the hot paths: failures are logged, never thrown. */
  flush(): void {
    void this.persistNow().catch(error => {
      console.warn("[Cadence] Could not persist lyrics cache:", error);
    });
  }

  /**
   * Persists and resolves only once the write has actually landed, rejecting when it fails, so a
   * caller that reports the result to the user (Settings -> "Clear lyrics cache") can tell the
   * truth. A failed write leaves the data marked dirty so the next flush retries it.
   */
  async persistNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    if (!this.persistence.persist) return;
    try {
      // `persist` may be synchronous (Node) or a promise (Tauri `invoke`); both are awaited here.
      await this.persistence.persist(JSON.stringify(this.data));
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }
}
