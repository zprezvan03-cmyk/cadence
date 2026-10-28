/**
 * Persistent listening history. Written for Cadence.
 *
 * A row is added exactly once per genuine play start (see playerStore), never on pause/resume,
 * seeking or metadata updates. Entries are self-contained snapshots, so a track that was later
 * removed from the library still renders — playing it again is handled gracefully.
 * History lives in the same SQLite library database as the library itself, so it survives
 * restarts without a new dependency.
 *
 * The store is the single source of truth for both the History tab and the homepage's Recently
 * Played section. It loads from persistent storage on first access (via bootstrap and view mounts)
 * and retries if the bridge is not yet ready, so history is never lost across restarts.
 */

import { create } from "zustand";
import { bridge, hasBridge } from "./bridge";
import type { HistoryEntry, HistoryPayload, Track } from "../../shared/types";

/** Client ids for optimistic entries predate the server-assigned row id. */
let nextClientId = -1;

function trackPayload(track: Track): HistoryPayload {
  return {
    trackId: track.id,
    path: track.path,
    title: track.title,
    artist: track.artist,
    albumArtist: track.albumArtist,
    album: track.album,
    artworkUrl: track.artworkUrl,
    duration: track.duration,
  };
}

interface HistoryState {
  entries: HistoryEntry[];
  loading: boolean;
  error: string | null;
  /** True once the initial load from persistent storage has been attempted at least once. */
  loaded: boolean;
  load: (attempt?: number) => Promise<void>;
  /** Record a genuine play start. Safe to call more than once per session — call sites are
   *  guarded in playerStore so a session only ever adds one row per track start. */
  add: (track: Track) => Promise<void>;
  clear: () => Promise<void>;
}

/** Maximum load attempts before giving up on restoring persisted history. */
const MAX_LOAD_ATTEMPTS = 3;
/** Base delay between load retries, in ms. */
const LOAD_RETRY_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const useHistory = create<HistoryState>((set, get) => ({
  entries: [],
  loading: false,
  error: null,
  loaded: false,

  load: async (attempt = 1) => {
    // Idempotent: once the initial load has completed, subsequent calls are no-ops.
    if (get().loaded) return;

    if (!hasBridge()) {
      if (attempt <= MAX_LOAD_ATTEMPTS) {
        await sleep(LOAD_RETRY_DELAY_MS * attempt);
        return void get().load(attempt + 1);
      }
      // Bridge never became available: keep whatever entries we have, log, and stop retrying.
      console.error("[Cadence] History bridge unavailable; persisted history could not be restored.");
      set({ loaded: true, loading: false });
      return;
    }

    set({ loading: true, error: null });
    try {
      const serverEntries = await bridge.history.list();
      // Entries added optimistically while the load was in flight are kept; anything the server
      // already knows about is not duplicated.
      const known = new Set(
        get().entries.map(entry => `${entry.trackId}|${entry.playedAt}`),
      );
      const merged = [
        ...serverEntries.filter(entry => !known.has(`${entry.trackId}|${entry.playedAt}`)),
        ...get().entries,
      ].sort((a, b) => b.playedAt - a.playedAt || b.id - a.id);
      set({ entries: merged, loading: false, loaded: true });
    } catch (error) {
      if (attempt <= MAX_LOAD_ATTEMPTS) {
        await sleep(LOAD_RETRY_DELAY_MS * attempt);
        return void get().load(attempt + 1);
      }
      // Never wipe existing entries on a failed read; keep what we have and surface the error.
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Cadence] Failed to restore listening history:", error);
      set({ loading: false, error: message, loaded: true });
    }
  },

  add: async track => {
    const entry: HistoryEntry = {
      id: nextClientId--,
      trackId: track.id,
      playedAt: Date.now(),
      payload: trackPayload(track),
    };
    set(state => ({ entries: [entry, ...state.entries] }));
    if (!hasBridge()) return;
    // Fire and forget: playback must never wait on disk I/O. A failure is logged, not surfaced,
    // because the listen already happened and the optimistic row is already on screen.
    try {
      await bridge.history.add({
        trackId: track.id,
        playedAt: entry.playedAt,
        payload: trackPayload(track),
      });
    } catch (error) {
      console.error("[Cadence] Failed to persist listening history:", error);
    }
  },

  clear: async () => {
    if (!hasBridge()) {
      // No bridge: clear locally only; persisted entries survive and will be restored on reload.
      set({ entries: [], error: null });
      return;
    }
    try {
      await bridge.history.clear();
      // Only clear local state after the server reports success, so a failed delete never
      // destroys data that can't be recovered.
      set({ entries: [], error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Cadence] Failed to clear listening history:", error);
      set({ error: message });
    }
  },
}));
