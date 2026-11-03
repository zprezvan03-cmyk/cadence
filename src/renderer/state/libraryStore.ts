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

interface LibraryState {
  snapshot: LibrarySnapshot | null;
  tracksById: Map<number, Track>;
  loading: boolean;
  scanning: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addFolder: () => Promise<void>;
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
    set({ scanning: true });
    try {
      await bridge.library.addFolder();
      await get().refresh();
    } catch (error) {
      set({ error: (error as Error).message });
    } finally {
      set({ scanning: false });
    }
  },
  removeFolder: async path => {
    const snapshot = await bridge.library.removeFolder(path);
    set({ snapshot, tracksById: indexTracks(snapshot) });
  },
  rescan: async () => {
    set({ scanning: true });
    try {
      await bridge.library.rescan();
      await get().refresh();
    } catch (error) {
      set({ error: (error as Error).message });
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
