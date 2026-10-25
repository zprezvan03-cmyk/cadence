/**
 * Runtime-agnostic Cadence library repository core.
 * Holds the in-memory track/album/artist/playlist projections and delegates durable persistence to
 * a pluggable adapter (Rust `rusqlite` in Tauri, or `node:sqlite` / JSON in Node).
 */

import type { Album, Artist, Playlist, Track } from "../../shared/types";
import { pathJoin } from "./metadataCore";

export interface StoredTrack {
  id: number;
  path: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  genre: string;
  year: number | null;
  trackNo: number | null;
  discNo: number | null;
  duration: number;
  bitrate: number | null;
  sampleRate: number | null;
  channels: number | null;
  codec: string;
  container: string;
  fileSize: number;
  mtimeMs: number;
  artworkFile: string | null;
  animatedArtPath: string | null;
  accentColor: string | null;
  hasEmbeddedLyrics: boolean;
  hasSidecarLyrics: boolean;
  playable: boolean;
  favorite: boolean;
  addedAt: number;
  lastPlayedAt: number | null;
  playCount: number;
}

export interface NewTrack extends Omit<StoredTrack, "id" | "favorite" | "addedAt" | "lastPlayedAt" | "playCount"> {
  embeddedLyrics?: { text: string; kind: string } | null;
}

export interface PlaylistRow {
  id: number;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  trackIds: number[];
}

export interface DatabaseShape {
  tracks: StoredTrack[];
  lyrics: Record<string, { text: string; kind: string }>;
  playlists: PlaylistRow[];
  folders: string[];
  nextPlaylistId: number;
}

export function emptyDatabase(): DatabaseShape {
  return { tracks: [], lyrics: {}, playlists: [], folders: [], nextPlaylistId: 1 };
}

export interface LibraryPersistenceAdapter {
  readonly engine: "sqlite" | "json";
  readonly writeThrough: boolean;
  upsertTrack?(track: StoredTrack): void;
  deleteTrack?(id: number): void;
  setLyrics?(trackId: number, payload: { text: string; kind: string }): void;
  deleteLyrics?(trackId: number): void;
  /** Optional lazy backend used by Tauri so startup does not load every embedded lyric. */
  loadLyrics?(trackId: number): Promise<{ text: string; kind: string } | null>;
  upsertPlaylist?(playlist: PlaylistRow, nextPlaylistId: number): void;
  deletePlaylist?(id: number): void;
  addFolder?(path: string): void;
  removeFolder?(path: string): void;
  flushSnapshot?(data: DatabaseShape): void;
  close?(): void;
}

function normalizeText(value: string): string {
  return value.normalize("NFC");
}

export class LibraryStoreCore {
  readonly engine: "sqlite" | "json";
  protected data: DatabaseShape;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private readonly loadedLyrics = new Set<number>();
  private readonly lyricLoads = new Map<number, Promise<void>>();
  private readonly tracksById = new Map<number, StoredTrack>();
  private readonly tracksByPath = new Map<string, StoredTrack>();
  private nextTrackId = 1;

  constructor(
    readonly artworkDirectory: string,
    protected readonly mediaUrl: (path: string, isArtwork?: boolean) => string,
    protected readonly persistence: LibraryPersistenceAdapter,
    initialData?: Partial<DatabaseShape>
  ) {
    this.engine = persistence.engine;
    this.data = {
      tracks: initialData?.tracks ?? [],
      lyrics: initialData?.lyrics ?? {},
      playlists: initialData?.playlists ?? [],
      folders: initialData?.folders ?? [],
      nextPlaylistId: initialData?.nextPlaylistId ?? 1,
    };
    for (const id of Object.keys(this.data.lyrics)) this.loadedLyrics.add(Number(id));
    for (const track of this.data.tracks) {
      this.tracksById.set(track.id, track);
      this.tracksByPath.set(track.path, track);
      this.nextTrackId = Math.max(this.nextTrackId, track.id + 1);
    }
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    if (this.persistence.writeThrough) return;
    this.persistence.flushSnapshot?.(this.data);
  }

  protected markDirty(): void {
    this.dirty = true;
    if (this.persistence.writeThrough) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 250);
  }

  private persistTrack(track: StoredTrack): void {
    this.persistence.upsertTrack?.(track);
  }

  private persistPlaylist(playlist: PlaylistRow): void {
    this.persistence.upsertPlaylist?.(playlist, this.data.nextPlaylistId);
  }

  // ------------------------------------------------------------------ tracks

  getTracks(): StoredTrack[] {
    return this.data.tracks;
  }

  getTrack(id: number): StoredTrack | null {
    return this.tracksById.get(id) ?? null;
  }

  getTrackByPath(path: string): StoredTrack | null {
    return this.tracksByPath.get(path) ?? null;
  }

  upsertTrack(track: NewTrack): { inserted: boolean; id: number } {
    const existing = this.getTrackByPath(track.path);
    const embeddedLyrics = track.embeddedLyrics;
    if (existing) {
      const merged: StoredTrack = {
        ...existing,
        ...track,
        id: existing.id,
        favorite: existing.favorite,
        addedAt: existing.addedAt,
        lastPlayedAt: existing.lastPlayedAt,
        playCount: existing.playCount,
      };
      delete (merged as { embeddedLyrics?: unknown }).embeddedLyrics;
      // Preserve the indexed object identity and avoid a second linear array lookup on updates.
      Object.assign(existing, merged);
      this.tracksByPath.set(existing.path, existing);
      this.persistTrack(existing);
      if (embeddedLyrics) this.setLyrics(existing.id, embeddedLyrics.text, embeddedLyrics.kind);
      this.markDirty();
      return { inserted: false, id: existing.id };
    }

    const id = this.nextTrackId++;
    const row: StoredTrack = {
      ...track,
      id,
      favorite: false,
      addedAt: Date.now(),
      lastPlayedAt: null,
      playCount: 0,
    };
    delete (row as { embeddedLyrics?: unknown }).embeddedLyrics;
    this.data.tracks.push(row);
    this.tracksById.set(id, row);
    this.tracksByPath.set(row.path, row);
    this.persistTrack(row);
    if (embeddedLyrics) this.setLyrics(id, embeddedLyrics.text, embeddedLyrics.kind);
    this.markDirty();
    return { inserted: true, id };
  }

  removeTracks(paths: Set<string>): number {
    const removed = this.data.tracks.filter(track => paths.has(track.path));
    if (removed.length === 0) return 0;
    const removedIds = new Set(removed.map(track => track.id));
    this.data.tracks = this.data.tracks.filter(track => !paths.has(track.path));
    for (const track of removed) this.tracksByPath.delete(track.path);
    for (const id of removedIds) {
      this.tracksById.delete(id);
      delete this.data.lyrics[String(id)];
      this.loadedLyrics.delete(id);
      this.persistence.deleteLyrics?.(id);
      this.persistence.deleteTrack?.(id);
    }
    for (const playlist of this.data.playlists) {
      const before = playlist.trackIds.length;
      playlist.trackIds = playlist.trackIds.filter(id => !removedIds.has(id));
      if (playlist.trackIds.length !== before) this.persistPlaylist(playlist);
    }
    this.markDirty();
    return removed.length;
  }

  setSidecarLyricsFlag(id: number, hasSidecar: boolean): void {
    const track = this.getTrack(id);
    if (!track) return;
    track.hasSidecarLyrics = hasSidecar;
    this.persistTrack(track);
    this.markDirty();
  }

  setFavorite(id: number, favorite: boolean): void {
    const track = this.getTrack(id);
    if (!track) return;
    track.favorite = favorite;
    this.persistTrack(track);
    this.markDirty();
  }

  recordPlay(id: number): void {
    const track = this.getTrack(id);
    if (!track) return;
    track.playCount += 1;
    track.lastPlayedAt = Date.now();
    this.persistTrack(track);
    this.markDirty();
  }

  // ------------------------------------------------------------------ lyrics

  setLyrics(trackId: number, text: string, kind: string): void {
    this.data.lyrics[String(trackId)] = { text, kind };
    this.loadedLyrics.add(trackId);
    this.persistence.setLyrics?.(trackId, { text, kind });
    const track = this.getTrack(trackId);
    if (track && !track.hasEmbeddedLyrics) {
      track.hasEmbeddedLyrics = true;
      this.persistTrack(track);
    }
    this.markDirty();
  }

  /** Load one track's embedded lyrics on demand; concurrent callers share the same read. */
  async ensureLyrics(trackId: number): Promise<void> {
    const trackPath = this.getTrack(trackId)?.path;
    if (!trackPath || this.loadedLyrics.has(trackId) || !this.persistence.loadLyrics) return;
    const existing = this.lyricLoads.get(trackId);
    if (existing) return existing;
    const load = this.persistence
      .loadLyrics(trackId)
      .then(payload => {
        // A scan may remove or replace the track while its lyric read is in flight.
        if (this.getTrack(trackId)?.path !== trackPath) return;
        if (payload) this.data.lyrics[String(trackId)] = payload;
        this.loadedLyrics.add(trackId);
      })
      .finally(() => this.lyricLoads.delete(trackId));
    this.lyricLoads.set(trackId, load);
    return load;
  }

  getLyrics(trackId: number): { text: string; kind: string } | null {
    return this.data.lyrics[String(trackId)] ?? null;
  }

  /** Drop lazily loaded text after use; the lazy persistence backend can read it again on demand. */
  releaseLyrics(trackId?: number): void {
    if (!this.persistence.loadLyrics) return;
    if (trackId === undefined) {
      this.data.lyrics = {};
      this.loadedLyrics.clear();
      return;
    }
    delete this.data.lyrics[String(trackId)];
    this.loadedLyrics.delete(trackId);
  }

  // ----------------------------------------------------------------- folders

  getFolders(): string[] {
    return [...this.data.folders];
  }

  addFolder(path: string): void {
    if (this.data.folders.includes(path)) return;
    this.data.folders.push(path);
    this.persistence.addFolder?.(path);
    this.markDirty();
  }

  removeFolder(path: string): void {
    this.data.folders = this.data.folders.filter(folder => folder !== path);
    this.persistence.removeFolder?.(path);
    this.markDirty();
  }

  // --------------------------------------------------------------- playlists

  private playlistSummary(row: PlaylistRow): Playlist {
    const tracks = row.trackIds
      .map(id => this.getTrack(id))
      .filter((track): track is StoredTrack => track !== null);
    const firstArtwork = tracks.find(track => track.artworkFile)?.artworkFile ?? null;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      trackCount: tracks.length,
      duration: tracks.reduce((total, track) => total + track.duration, 0),
      artworkUrl: firstArtwork ? this.mediaUrl(pathJoin(this.artworkDirectory, firstArtwork), true) : null,
    };
  }

  getPlaylists(): Playlist[] {
    return this.data.playlists.map(row => this.playlistSummary(row)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getPlaylistTrackIds(id: number): number[] {
    return this.data.playlists.find(row => row.id === id)?.trackIds ?? [];
  }

  createPlaylist(name: string, trackIds: number[] = []): Playlist {
    const id = this.data.nextPlaylistId++;
    const now = Date.now();
    const row: PlaylistRow = {
      id,
      name: name.trim() || "New playlist",
      description: "",
      createdAt: now,
      updatedAt: now,
      trackIds: trackIds.filter(trackId => this.getTrack(trackId) !== null),
    };
    this.data.playlists.push(row);
    this.persistPlaylist(row);
    this.markDirty();
    return this.playlistSummary(row);
  }

  renamePlaylist(id: number, name: string): void {
    const row = this.data.playlists.find(playlist => playlist.id === id);
    if (!row) return;
    row.name = name.trim() || row.name;
    row.updatedAt = Date.now();
    this.persistPlaylist(row);
    this.markDirty();
  }

  deletePlaylist(id: number): void {
    this.data.playlists = this.data.playlists.filter(playlist => playlist.id !== id);
    this.persistence.deletePlaylist?.(id);
    this.markDirty();
  }

  addTracksToPlaylist(id: number, trackIds: number[]): void {
    const row = this.data.playlists.find(playlist => playlist.id === id);
    if (!row) return;
    const existing = new Set(row.trackIds);
    for (const trackId of trackIds) {
      if (this.getTrack(trackId) && !existing.has(trackId)) {
        row.trackIds.push(trackId);
        existing.add(trackId);
      }
    }
    row.updatedAt = Date.now();
    this.persistPlaylist(row);
    this.markDirty();
  }

  removeTrackFromPlaylist(id: number, trackId: number): void {
    const row = this.data.playlists.find(playlist => playlist.id === id);
    if (!row) return;
    row.trackIds = row.trackIds.filter(candidate => candidate !== trackId);
    row.updatedAt = Date.now();
    this.persistPlaylist(row);
    this.markDirty();
  }

  reorderPlaylist(id: number, trackIds: number[]): void {
    const row = this.data.playlists.find(playlist => playlist.id === id);
    if (!row) return;
    const valid = new Set(row.trackIds);
    const reordered = trackIds.filter(trackId => valid.has(trackId));
    for (const trackId of row.trackIds) if (!reordered.includes(trackId)) reordered.push(trackId);
    row.trackIds = reordered;
    row.updatedAt = Date.now();
    this.persistPlaylist(row);
    this.markDirty();
  }

  setPlaylistDescription(id: number, description: string): void {
    const row = this.data.playlists.find(playlist => playlist.id === id);
    if (!row) return;
    row.description = description;
    row.updatedAt = Date.now();
    this.persistPlaylist(row);
    this.markDirty();
  }

  updatePlaylistCover(id: number, _artworkFile: string): void {
    const row = this.data.playlists.find(playlist => playlist.id === id);
    if (!row) return;
    row.updatedAt = Date.now();
    this.persistPlaylist(row);
    this.markDirty();
  }

  // ------------------------------------------------------------ projections

  toTrack(track: StoredTrack): Track {
    return {
      id: track.id,
      path: track.path,
      streamUrl: this.mediaUrl(track.path),
      title: track.title,
      artist: track.artist,
      albumArtist: track.albumArtist || track.artist,
      album: track.album,
      genre: track.genre,
      year: track.year,
      trackNo: track.trackNo,
      discNo: track.discNo,
      duration: track.duration,
      bitrate: track.bitrate,
      sampleRate: track.sampleRate,
      channels: track.channels,
      codec: track.codec,
      container: track.container,
      fileSize: track.fileSize,
      mtimeMs: track.mtimeMs,
      artworkUrl: track.artworkFile ? this.mediaUrl(pathJoin(this.artworkDirectory, track.artworkFile), true) : null,
      animatedArtUrl: track.animatedArtPath ? this.mediaUrl(track.animatedArtPath, false) : null,
      accentColor: track.accentColor,
      hasEmbeddedLyrics: track.hasEmbeddedLyrics,
      favorite: track.favorite,
      addedAt: track.addedAt,
      lastPlayedAt: track.lastPlayedAt,
      playCount: track.playCount,
      hasSidecarLyrics: track.hasSidecarLyrics,
      playable: track.playable,
    };
  }

  getAlbums(): Album[] {
    const byKey = new Map<string, Album>();
    for (const track of this.data.tracks) {
      const name = track.album || "Unknown album";
      const albumArtist = track.albumArtist || track.artist || "Unknown artist";
      const key = `${albumArtist}\u0000${name}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.trackCount += 1;
        existing.duration += track.duration;
        existing.year ??= track.year;
      } else {
        byKey.set(key, {
          id: key,
          name,
          albumArtist,
          year: track.year,
          artworkUrl: track.artworkFile ? this.mediaUrl(pathJoin(this.artworkDirectory, track.artworkFile), true) : null,
          accentColor: track.accentColor,
          trackCount: 1,
          duration: track.duration,
        });
      }
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  getArtists(): Artist[] {
    const byName = new Map<string, Artist & { albumSet: Set<string> }>();
    for (const track of this.data.tracks) {
      const name = track.artist || "Unknown artist";
      const existing = byName.get(name);
      if (existing) {
        existing.trackCount += 1;
        existing.albumSet.add(track.album || "Unknown album");
      } else {
        byName.set(name, {
          id: name,
          name,
          artworkUrl: track.artworkFile ? this.mediaUrl(pathJoin(this.artworkDirectory, track.artworkFile), true) : null,
          trackCount: 1,
          albumCount: 0,
          albumSet: new Set([track.album || "Unknown album"]),
        });
      }
    }
    return [...byName.values()]
      .map(({ albumSet, ...artist }) => ({ ...artist, albumCount: albumSet.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  getAlbumTracks(artist: string, album: string): Track[] {
    return this.data.tracks
      .filter(
        track =>
          (track.album || "Unknown album") === album &&
          (track.albumArtist || track.artist || "Unknown artist") === artist
      )
      .sort((a, b) => (a.discNo ?? 0) - (b.discNo ?? 0) || (a.trackNo ?? 0) - (b.trackNo ?? 0))
      .map(track => this.toTrack(track));
  }

  getArtistTracks(name: string): Track[] {
    return this.data.tracks
      .filter(track => (track.artist || "Unknown artist") === name)
      .sort((a, b) => a.album.localeCompare(b.album) || (a.trackNo ?? 0) - (b.trackNo ?? 0))
      .map(track => this.toTrack(track));
  }

  search(query: string, limit = 200): Track[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const scored: { track: StoredTrack; score: number }[] = [];
    for (const track of this.data.tracks) {
      const title = normalizeText(track.title).toLocaleLowerCase();
      const artist = normalizeText(track.artist).toLocaleLowerCase();
      const album = normalizeText(track.album).toLocaleLowerCase();
      let score = 0;
      if (title === needle) score = 100;
      else if (title.startsWith(needle)) score = 80;
      else if (title.includes(needle)) score = 60;
      if (artist === needle) score = Math.max(score, 70);
      else if (artist.includes(needle)) score = Math.max(score, 45);
      if (album.includes(needle)) score = Math.max(score, 30);
      if (track.genre.toLocaleLowerCase().includes(needle)) score = Math.max(score, 10);
      if (score > 0) scored.push({ track, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.track.title.localeCompare(b.track.title))
      .slice(0, limit)
      .map(entry => this.toTrack(entry.track));
  }

  counts(): { tracks: number; albums: number; artists: number; playlists: number; duration: number } {
    const albums = new Set<string>();
    const artists = new Set<string>();
    let duration = 0;
    for (const track of this.data.tracks) {
      albums.add(`${track.albumArtist || track.artist}\u0000${track.album}`);
      artists.add(track.artist);
      duration += track.duration;
    }
    return {
      tracks: this.data.tracks.length,
      albums: albums.size,
      artists: artists.size,
      playlists: this.data.playlists.length,
      duration,
    };
  }

  close(): void {
    this.flush();
    this.persistence.close?.();
  }
}
