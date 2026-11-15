import { create } from "zustand";
import type {
  LibrarySnapshot,
  Playlist,
  SmartPlaylistRule,
  Track,
  TrackMetadataEdit,
} from "../../shared/types";
import { bridge } from "./bridge";
import { setTrackRegistry } from "./trackRegistry";
import { useUi } from "./uiStore";

interface LibraryState {
  snapshot: LibrarySnapshot | null;
  tracksById: Map<number, Track>;
  loading: boolean;
  scanning: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addFolder: () => Promise<void>;
  scanMediaStore: () => Promise<{ granted: boolean }>;
  removeFolder: (path: string) => Promise<void>;
  rescan: () => Promise<void>;
  setFavorite: (id: number, favorite: boolean) => Promise<void>;
  recordPlay: (id: number) => Promise<void>;
  updateTrackMetadata: (id: number, edit: TrackMetadataEdit) => Promise<Track | null>;
  resetTrackMetadata: (id: number) => Promise<Track | null>;
  setTrackArtwork: (id: number, data: ArrayBuffer, mimeType: string) => Promise<Track | null>;
  removeTrackArtwork: (id: number) => Promise<Track | null>;
  resetTrackArtwork: (id: number) => Promise<Track | null>;
  createPlaylist: (name: string, trackIds?: number[]) => Promise<Playlist | null>;
  createSmartPlaylist: (name: string, rule: SmartPlaylistRule) => Promise<Playlist | null>;
  updateSmartPlaylist: (id: number, rule: SmartPlaylistRule) => Promise<void>;
  renamePlaylist: (id: number, name: string) => Promise<void>;
  deletePlaylist: (id: number) => Promise<void>;
  addToPlaylist: (id: number, trackIds: number[]) => Promise<void>;
  removeFromPlaylist: (id: number, trackId: number) => Promise<void>;
  playlistTracks: (id: number) => Promise<Track[]>;
  search: (query: string) => Promise<Track[]>;
}

function indexTracks(snapshot: LibrarySnapshot): Map<number, Track> {
  const map = new Map(snapshot.tracks.map(track => [track.id, track]));
  setTrackRegistry(map);
  return map;
}

/** Stable empty value: selectors must not allocate a new array on every snapshot read. */
export const EMPTY_PLAYLISTS: readonly Playlist[] = [];

export const useLibrary = create<LibraryState>()((set, get) => ({
  snapshot: null,
  tracksById: new Map(),
  loading: true,
  scanning: false,
  error: null,
  refresh: async () => {
    try {
      const snapshot = await bridge.library.snapshot();
      set({ snapshot, tracksById: indexTracks(snapshot), loading: false, scanning: snapshot.scan.running, error: null });
    } catch (error) {
      set({ loading: false, error: (error as Error).message });
    }
  },
  addFolder: async () => {
    set({ scanning: true, error: null });
    try {
      const outcome = await bridge.library.addFolder();
      await get().refresh();
      if (!outcome.canceled && outcome.result) {
        if (outcome.result.errors.length > 0 && get().tracksById.size === 0) {
          const msg = outcome.result.errors[0].reason || "Could not scan the selected folder.";
          set({ error: msg });
          useUi.getState().showToast(msg);
        } else if (outcome.result.added === 0 && outcome.result.updated === 0 && get().tracksById.size === 0) {
          useUi.getState().showToast("No audio files were found in that folder.");
        }
      }
    } catch (error) {
      const msg = (error as Error).message || "Folder scan failed.";
      set({ error: msg });
      useUi.getState().showToast(msg);
    } finally {
      set({ scanning: false });
    }
  },
  scanMediaStore: async () => {
    if (!bridge.library.scanMediaStore) {
      return { granted: false };
    }
    set({ scanning: true, error: null });
    try {
      const outcome = await bridge.library.scanMediaStore();
      if (!outcome.granted) {
        const msg =
          "Audio permission was denied. Allow Music & Audio access in Android Settings, or tap Add music folder.";
        set({ error: msg });
        useUi.getState().showToast(msg);
        return { granted: false };
      }
      await get().refresh();
      const result = outcome.result;
      if (result && result.errors.length > 0 && get().tracksById.size === 0) {
        const msg = result.errors[0].reason || "Device audio scan failed.";
        set({ error: msg });
        useUi.getState().showToast(msg);
      } else if (result && result.added === 0 && result.updated === 0 && get().tracksById.size === 0) {
        useUi.getState().showToast(
          "No music found in Android MediaStore — try Add music folder to pick a folder directly."
        );
      }
      return { granted: true };
    } catch (error) {
      const msg = (error as Error).message || "Device audio scan failed.";
      set({ error: msg });
      useUi.getState().showToast(msg);
      return { granted: false };
    } finally {
      set({ scanning: false });
    }
  },
  removeFolder: async path => {
    const snapshot = await bridge.library.removeFolder(path);
    set({ snapshot, tracksById: indexTracks(snapshot) });
  },
  rescan: async () => {
    set({ scanning: true, error: null });
    try {
      await bridge.library.rescan();
      await get().refresh();
    } catch (error) {
      const msg = (error as Error).message || "Rescan failed.";
      set({ error: msg });
      useUi.getState().showToast(msg);
    } finally {
      set({ scanning: false });
    }
  },
  setFavorite: async (id, favorite) => {
    await bridge.library.setFavorite(id, favorite);
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const tracks = snapshot.tracks.map(track => (track.id === id ? { ...track, favorite } : track));
    const tracksById = indexTracks({ ...snapshot, tracks });
    set({ snapshot: { ...snapshot, tracks }, tracksById });
  },
  recordPlay: async id => {
    await bridge.library.recordPlay(id);
    const snapshot = get().snapshot;
    if (!snapshot) return;
    const playedAt = Date.now();
    const tracks = snapshot.tracks.map(track =>
      track.id === id ? { ...track, lastPlayedAt: playedAt, playCount: track.playCount + 1 } : track
    );
    const tracksById = indexTracks({ ...snapshot, tracks });
    set({ snapshot: { ...snapshot, tracks }, tracksById });
  },
  updateTrackMetadata: async (id, edit) => {
    const updated = await bridge.library.updateTrackMetadata(id, edit);
    await get().refresh();
    return updated;
  },
  resetTrackMetadata: async id => {
    const updated = await bridge.library.resetTrackMetadata(id);
    await get().refresh();
    return updated;
  },
  setTrackArtwork: async (id, data, mimeType) => {
    const updated = await bridge.library.setTrackArtwork(id, data, mimeType);
    await get().refresh();
    return updated;
  },
  removeTrackArtwork: async id => {
    const updated = await bridge.library.removeTrackArtwork(id);
    await get().refresh();
    return updated;
  },
  resetTrackArtwork: async id => {
    const updated = await bridge.library.resetTrackArtwork(id);
    await get().refresh();
    return updated;
  },
  createPlaylist: async (name, trackIds = []) => {
    const playlist = await bridge.playlists.create(name, trackIds);
    await get().refresh();
    return playlist;
  },
  createSmartPlaylist: async (name, rule) => {
    const playlist = await bridge.playlists.createSmart(name, rule);
    await get().refresh();
    return playlist;
  },
  updateSmartPlaylist: async (id, rule) => {
    await bridge.playlists.updateSmart(id, rule);
    await get().refresh();
  },
  renamePlaylist: async (id, name) => {
    await bridge.playlists.rename(id, name);
    await get().refresh();
  },
  deletePlaylist: async id => {
    await bridge.playlists.remove(id);
    await get().refresh();
  },
  addToPlaylist: async (id, trackIds) => {
    await bridge.playlists.addTracks(id, trackIds);
    await get().refresh();
  },
  removeFromPlaylist: async (id, trackId) => {
    await bridge.playlists.removeTrack(id, trackId);
    await get().refresh();
  },
  playlistTracks: id => bridge.playlists.tracks(id),
  search: query => bridge.library.search(query),
}));

export function selectTrack(id: number | null): Track | null {
  if (id === null) return null;
  return useLibrary.getState().tracksById.get(id) ?? null;
}
