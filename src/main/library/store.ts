/**
 * Cadence library database.
 *
 * Written for Cadence. Albums and artists are derived views over the tracks table, and the whole
 * library is held in memory (a personal library is small) so views can be served instantly.
 *
 * Primary storage is SQLite through Node's built-in `node:sqlite`. If that module is not exposed by
 * the Electron build in use, the same repository transparently persists to a JSON document with the
 * identical public API, and reports which engine it used through `engine`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Album, Artist, Playlist, Track } from "../../shared/types";

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

interface PlaylistRow {
  id: number;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  trackIds: number[];
}

interface DatabaseShape {
  tracks: StoredTrack[];
  lyrics: Record<string, { text: string; kind: string }>;
  playlists: PlaylistRow[];
  folders: string[];
  nextPlaylistId: number;
}

const EMPTY_DB: DatabaseShape = { tracks: [], lyrics: {}, playlists: [], folders: [], nextPlaylistId: 1 };

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
};

function normalizeText(value: string): string {
  return value.normalize("NFC");
}

export class LibraryStore {
  readonly engine: "sqlite" | "json";
  private data: DatabaseShape = { ...EMPTY_DB };
  private sqlite: SqliteDatabase | null = null;
  private readonly jsonPath: string;
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(
    private readonly dbPath: string,
    readonly artworkDirectory: string,
    private readonly mediaUrl: (path: string, isArtwork?: boolean) => string
  ) {
    mkdirSync(artworkDirectory, { recursive: true });
    mkdirSync(dirname(dbPath), { recursive: true });
    this.jsonPath = join(dirname(dbPath), "library.json");

    let sqlite: SqliteDatabase | null = null;
    try {
      // `node:sqlite` is built into Node 22.5+ (experimental at first). Electron may or may not
      // expose it, so this is a capability probe rather than an assumption.
      const sqliteModule = process.getBuiltinModule?.("node:sqlite") as
        | { DatabaseSync: new (path: string) => SqliteDatabase }
        | undefined;
      if (sqliteModule?.DatabaseSync) {
        sqlite = new sqliteModule.DatabaseSync(dbPath);
        sqlite.exec("PRAGMA journal_mode = WAL;");
        sqlite.exec(`
          CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            payload TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS lyrics (
            track_id INTEGER PRIMARY KEY,
            payload TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS playlists (
            id INTEGER PRIMARY KEY,
            payload TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS folders (
            path TEXT PRIMARY KEY
          );
          CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        `);
      }
    } catch (error) {
      console.warn("[Cadence] node:sqlite unavailable, falling back to JSON library store:", error);
      sqlite = null;
    }

    this.sqlite = sqlite;
    this.engine = sqlite ? "sqlite" : "json";
    this.load();
  }

  private load(): void {
    if (this.sqlite) {
      try {
        const trackRows = this.sqlite.prepare("SELECT payload FROM tracks").all() as { payload: string }[];
        const playlistRows = this.sqlite.prepare("SELECT payload FROM playlists").all() as { payload: string }[];
        const lyricRows = this.sqlite.prepare("SELECT track_id, payload FROM lyrics").all() as {
          track_id: number;
          payload: string;
        }[];
        const folderRows = this.sqlite.prepare("SELECT path FROM folders").all() as { path: string }[];
        const metaRows = this.sqlite.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];

        const data: DatabaseShape = { ...EMPTY_DB, tracks: [], lyrics: {}, playlists: [], folders: [] };
        for (const row of trackRows) {
          try {
            data.tracks.push(JSON.parse(row.payload) as StoredTrack);
          } catch {
            /* skip corrupt row */
          }
        }
        for (const row of playlistRows) {
          try {
            data.playlists.push(JSON.parse(row.payload) as PlaylistRow);
          } catch {
            /* skip */
          }
        }
        for (const row of lyricRows) {
          try {
            data.lyrics[String(row.track_id)] = JSON.parse(row.payload) as { text: string; kind: string };
          } catch {
            /* skip */
          }
        }
        data.folders = folderRows.map(row => row.path);
        const next = metaRows.find(row => row.key === "nextPlaylistId");
        data.nextPlaylistId = next ? Number(next.value) || 1 : 1;
        this.data = data;
        return;
      } catch (error) {
        console.error("[Cadence] Failed to read SQLite library, starting empty:", error);
        this.data = { ...EMPTY_DB };
        return;
      }
    }

    if (existsSync(this.jsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.jsonPath, "utf8")) as Partial<DatabaseShape>;
        this.data = {
          tracks: parsed.tracks ?? [],
          lyrics: parsed.lyrics ?? {},
          playlists: parsed.playlists ?? [],
          folders: parsed.folders ?? [],
          nextPlaylistId: parsed.nextPlaylistId ?? 1,
        };
      } catch (error) {
        console.error("[Cadence] Failed to read JSON library, starting empty:", error);
        this.data = { ...EMPTY_DB };
      }
    }
  }

  /** Persist pending mutations immediately. Called before app quit and by tests. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;

    if (this.sqlite) return; // SQLite is written through on every mutation.
    try {
      mkdirSync(dirname(this.jsonPath), { recursive: true });
      const tmp = `${this.jsonPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.jsonPath);
    } catch (error) {
      console.error("[Cadence] Failed to persist JSON library:", error);
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.sqlite) return;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, 250);
  }

  private persistTrack(track: StoredTrack): void {
    this.sqlite?.prepare("INSERT OR REPLACE INTO tracks (id, path, payload) VALUES (?, ?, ?)").run(
      track.id,
      track.path,
      JSON.stringify(track)
    );
  }

  private persistPlaylist(playlist: PlaylistRow): void {
    this.sqlite?.prepare("INSERT OR REPLACE INTO playlists (id, payload) VALUES (?, ?)").run(
      playlist.id,
      JSON.stringify(playlist)
    );
    this.sqlite?.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('nextPlaylistId', ?)").run(
      String(this.data.nextPlaylistId)
    );
  }

  // ------------------------------------------------------------------ tracks

  getTracks(): StoredTrack[] {
    return this.data.tracks;
  }

  getTrack(id: number): StoredTrack | null {
    return this.data.tracks.find(track => track.id === id) ?? null;
  }

  getTrackByPath(path: string): StoredTrack | null {
    return this.data.tracks.find(track => track.path === path) ?? null;
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
      this.data.tracks[this.data.tracks.findIndex(candidate => candidate.id === existing.id)] = merged;
      this.persistTrack(merged);
      if (embeddedLyrics) this.setLyrics(existing.id, embeddedLyrics.text, embeddedLyrics.kind);
      this.markDirty();
      return { inserted: false, id: existing.id };
    }

    const id = this.data.tracks.reduce((max, candidate) => Math.max(max, candidate.id), 0) + 1;
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
    for (const id of removedIds) {
      delete this.data.lyrics[String(id)];
      this.sqlite?.prepare("DELETE FROM lyrics WHERE track_id = ?").run(id);
      this.sqlite?.prepare("DELETE FROM tracks WHERE id = ?").run(id);
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
    const payload = JSON.stringify({ text, kind });
    this.data.lyrics[String(trackId)] = { text, kind };
    this.sqlite?.prepare("INSERT OR REPLACE INTO lyrics (track_id, payload) VALUES (?, ?)").run(trackId, payload);
    const track = this.getTrack(trackId);
    if (track && !track.hasEmbeddedLyrics) {
      track.hasEmbeddedLyrics = true;
      this.persistTrack(track);
    }
    this.markDirty();
  }

  getLyrics(trackId: number): { text: string; kind: string } | null {
    return this.data.lyrics[String(trackId)] ?? null;
  }

  // ----------------------------------------------------------------- folders

  getFolders(): string[] {
    return [...this.data.folders];
  }

  addFolder(path: string): void {
    if (this.data.folders.includes(path)) return;
    this.data.folders.push(path);
    this.sqlite?.prepare("INSERT OR REPLACE INTO folders (path) VALUES (?)").run(path);
    this.markDirty();
  }

  removeFolder(path: string): void {
    this.data.folders = this.data.folders.filter(folder => folder !== path);
    this.sqlite?.prepare("DELETE FROM folders WHERE path = ?").run(path);
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
      artworkUrl: firstArtwork ? this.mediaUrl(join(this.artworkDirectory, firstArtwork), true) : null,
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
    this.sqlite?.prepare("DELETE FROM playlists WHERE id = ?").run(id);
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
    // Covers are derived from the first track's artwork; this exists so the UI can pin one later.
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
      artworkUrl: track.artworkFile ? this.mediaUrl(join(this.artworkDirectory, track.artworkFile), true) : null,
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
          artworkUrl: track.artworkFile ? this.mediaUrl(join(this.artworkDirectory, track.artworkFile), true) : null,
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
          artworkUrl: track.artworkFile ? this.mediaUrl(join(this.artworkDirectory, track.artworkFile), true) : null,
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
    this.sqlite?.close();
    this.sqlite = null;
  }
}
