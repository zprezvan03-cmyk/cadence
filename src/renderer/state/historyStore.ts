/**
 * Persistent listening history. Written for Cadence.
 *
 * A row is added exactly once per genuine play start (see playerStore), never on pause/resume,
 * seeking or metadata updates. Entries are self-contained snapshots, so a track that was later
 * removed from the library still renders — playing it again is handled gracefully.
 * History lives in the same SQLite library database as the library itself, so it survives
 * restarts without a new dependency.
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
  load: () => Promise<void>;
  /** Record a genuine play start. Safe to call more than once per session — call sites are
   *  guarded in playerStore so a session only ever adds one row per track start. */
  add: (track: Track) => Promise<void>;
  clear: () => Promise<void>;
}

export const useHistory = create<HistoryState>((set, get) => ({
  entries: [],
  loading: false,
  error: null,

  load: async () => {
    if (!hasBridge()) {
      set({ entries: [], loading: false });
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
      set({ entries: merged, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
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
    set({ entries: [], error: null });
    if (!hasBridge()) return;
    try {
      await bridge.history.clear();
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
}));
