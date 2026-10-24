/**
 * Cadence library database (Node `node:sqlite` + JSON document adapter over `LibraryStoreCore`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  emptyDatabase,
  LibraryStoreCore,
  type DatabaseShape,
  type LibraryPersistenceAdapter,
  type NewTrack,
  type PlaylistRow,
  type StoredTrack,
} from "./storeCore";

export type { StoredTrack, NewTrack };

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  close(): void;
};

function loadInitialSqlite(sqlite: SqliteDatabase): DatabaseShape {
  try {
    const trackRows = sqlite.prepare("SELECT payload FROM tracks").all() as { payload: string }[];
    const playlistRows = sqlite.prepare("SELECT payload FROM playlists").all() as { payload: string }[];
    const lyricRows = sqlite.prepare("SELECT track_id, payload FROM lyrics").all() as {
      track_id: number;
      payload: string;
    }[];
    const folderRows = sqlite.prepare("SELECT path FROM folders").all() as { path: string }[];
    const metaRows = sqlite.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];

    const data: DatabaseShape = emptyDatabase();
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
    return data;
  } catch (error) {
    console.error("[Cadence] Failed to read SQLite library, starting empty:", error);
    return emptyDatabase();
  }
}

function loadInitialJson(jsonPath: string): DatabaseShape {
  if (!existsSync(jsonPath)) return emptyDatabase();
  try {
    const parsed = JSON.parse(readFileSync(jsonPath, "utf8")) as Partial<DatabaseShape>;
    return {
      tracks: parsed.tracks ?? [],
      lyrics: parsed.lyrics ?? {},
      playlists: parsed.playlists ?? [],
      folders: parsed.folders ?? [],
      nextPlaylistId: parsed.nextPlaylistId ?? 1,
    };
  } catch (error) {
    console.error("[Cadence] Failed to read JSON library, starting empty:", error);
    return emptyDatabase();
  }
}

export class LibraryStore extends LibraryStoreCore {
  constructor(
    dbPath: string,
    artworkDirectory: string,
    mediaUrl: (path: string, isArtwork?: boolean) => string,
    options: { disableSqlite?: boolean } = {}
  ) {
    mkdirSync(artworkDirectory, { recursive: true });
    mkdirSync(dirname(dbPath), { recursive: true });
    const jsonPath = join(dirname(dbPath), "library.json");

    let sqlite: SqliteDatabase | null = null;
    if (!options.disableSqlite) {
      try {
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
    }

    const initialData = sqlite ? loadInitialSqlite(sqlite) : loadInitialJson(jsonPath);

    const adapter: LibraryPersistenceAdapter = sqlite
      ? {
          engine: "sqlite",
          writeThrough: true,
          upsertTrack(track) {
            sqlite.prepare("INSERT OR REPLACE INTO tracks (id, path, payload) VALUES (?, ?, ?)").run(
              track.id,
              track.path,
              JSON.stringify(track)
            );
          },
          deleteTrack(id) {
            sqlite.prepare("DELETE FROM tracks WHERE id = ?").run(id);
          },
          setLyrics(trackId, payload) {
            sqlite.prepare("INSERT OR REPLACE INTO lyrics (track_id, payload) VALUES (?, ?)").run(
              trackId,
              JSON.stringify(payload)
            );
          },
          deleteLyrics(trackId) {
            sqlite.prepare("DELETE FROM lyrics WHERE track_id = ?").run(trackId);
          },
          upsertPlaylist(playlist, nextPlaylistId) {
            sqlite.prepare("INSERT OR REPLACE INTO playlists (id, payload) VALUES (?, ?)").run(
              playlist.id,
              JSON.stringify(playlist)
            );
            sqlite.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('nextPlaylistId', ?)").run(
              String(nextPlaylistId)
            );
          },
          deletePlaylist(id) {
            sqlite.prepare("DELETE FROM playlists WHERE id = ?").run(id);
          },
          addFolder(path) {
            sqlite.prepare("INSERT OR IGNORE INTO folders (path) VALUES (?)").run(path);
          },
          removeFolder(path) {
            sqlite.prepare("DELETE FROM folders WHERE path = ?").run(path);
          },
          close() {
            sqlite.close();
          },
        }
      : {
          engine: "json",
          writeThrough: false,
          flushSnapshot(data) {
            try {
              mkdirSync(dirname(jsonPath), { recursive: true });
              const tmp = `${jsonPath}.tmp`;
              writeFileSync(tmp, JSON.stringify(data));
              renameSync(tmp, jsonPath);
            } catch (error) {
              console.error("[Cadence] Failed to persist JSON library:", error);
            }
          },
        };

    super(artworkDirectory, mediaUrl, adapter, initialData);
  }
}
