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
import type { HistoryEntry, HistoryPayload } from "../../shared/types";

/** The most history rows to keep, mirroring `HISTORY_CAP` in src-tauri/src/db.rs. */
const HISTORY_CAP = 1000;

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
  /** Live SQLite handle for history writes (null on the JSON fallback engine). */
  private sqliteDb: SqliteDatabase | null = null;
  /** Session-only history when SQLite is unavailable (JSON fallback engine). */
  private memoryHistory: HistoryEntry[] = [];

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
            CREATE TABLE IF NOT EXISTS listening_history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              track_id INTEGER NOT NULL,
              played_at INTEGER NOT NULL,
              payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_listening_history_played_at
              ON listening_history(played_at DESC, id DESC);
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
    this.sqliteDb = sqlite;
  }

  /**
   * Listening history, mirroring `LibraryDb::{add_history_entry,list_history,clear_history}`
   * (src-tauri/src/db.rs) against the same `listening_history` table, so the browser
   * harnesses exercise the real persistence semantics: transactional insert, prune to the
   * newest HISTORY_CAP rows, corrupt-payload rows skipped on read.
   */
  addHistoryEntry(trackId: number, playedAt: number, payload: HistoryPayload): HistoryEntry {
    if (!this.sqliteDb) {
      const entry: HistoryEntry = {
        id: this.memoryHistory.reduce((max, e) => Math.max(max, e.id), 0) + 1,
        trackId,
        playedAt,
        payload,
      };
      this.memoryHistory = [entry, ...this.memoryHistory].slice(0, HISTORY_CAP);
      return entry;
    }
    const db = this.sqliteDb;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db
        .prepare("INSERT INTO listening_history (track_id, played_at, payload) VALUES (?, ?, ?)")
        .run(trackId, playedAt, JSON.stringify(payload)) as { lastInsertRowid?: number | bigint };
      db.prepare(
        `DELETE FROM listening_history WHERE id NOT IN (
           SELECT id FROM listening_history ORDER BY played_at DESC, id DESC LIMIT ?
         )`
      ).run(HISTORY_CAP);
      db.exec("COMMIT");
      return { id: Number(result.lastInsertRowid ?? 0), trackId, playedAt, payload };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  listHistory(limit = HISTORY_CAP): HistoryEntry[] {
    if (!this.sqliteDb) return [...this.memoryHistory];
    const rows = this.sqliteDb
      .prepare(
        "SELECT id, track_id, played_at, payload FROM listening_history ORDER BY played_at DESC, id DESC LIMIT ?"
      )
      .all(limit) as Array<{ id: number; track_id: number; played_at: number; payload: string }>;
    const entries: HistoryEntry[] = [];
    for (const row of rows) {
      try {
        entries.push({
          id: row.id,
          trackId: row.track_id,
          playedAt: row.played_at,
          payload: JSON.parse(row.payload) as HistoryPayload,
        });
      } catch {
        /* skip corrupt row: one bad payload must never blank the whole history */
      }
    }
    return entries;
  }

  clearHistory(): void {
    if (!this.sqliteDb) {
      this.memoryHistory = [];
      return;
    }
    this.sqliteDb.prepare("DELETE FROM listening_history").run();
  }
}
