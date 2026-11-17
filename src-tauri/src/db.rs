//! SQLite persistence for the Cadence library (`library.db`).
//!
//! Uses the exact 6-table schema (`tracks`, `lyrics`, `playlists`, `folders`, `meta`,
//! `listening_history`) established
//! by `src/main/library/store.ts`, so existing user libraries migrate seamlessly without data loss.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSnapshot {
    pub tracks: Vec<Value>,
    pub lyrics: HashMap<String, Value>,
    pub playlists: Vec<Value>,
    pub folders: Vec<String>,
    pub next_playlist_id: i64,
}

impl Default for DbSnapshot {
    fn default() -> Self {
        Self {
            tracks: Vec::new(),
            lyrics: HashMap::new(),
            playlists: Vec::new(),
            folders: Vec::new(),
            next_playlist_id: 1,
        }
    }
}

/// One completed listening session: the track that played, when it started, and a snapshot of its
/// metadata so the history row stays readable even after the file is removed from the library.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: i64,
    pub source_kind: String,
    pub track_id: Option<i64>,
    pub remote_id: Option<String>,
    pub canonical_url: Option<String>,
    pub played_at: i64,
    pub payload: Value,
}

/// The most history rows to keep. Played tracks are append-only, so growth is bounded by dropping
/// the oldest plays once the cap is reached.
const HISTORY_CAP: usize = 1000;

/// Cached popularity and behavioral listening intelligence keyed by normalized recording identity.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackIntelligenceRow {
    pub recording_key: String,
    pub track_id: Option<i64>,
    pub artist: String,
    pub title: String,
    pub popularity: Option<f64>,
    pub popularity_source: Option<String>,
    pub popularity_confidence: Option<f64>,
    pub external_listeners: Option<i64>,
    #[serde(default)]
    pub external_genres: Vec<String>,
    pub fetched_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub skip_count: i64,
    pub complete_count: i64,
    pub last_skipped_at: Option<i64>,
    pub last_completed_at: Option<i64>,
    pub updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum DbMutation {
    UpsertTrack {
        id: i64,
        path: String,
        payload: String,
    },
    DeleteTrack {
        id: i64,
    },
    SetLyrics {
        #[serde(rename = "trackId")]
        track_id: i64,
        payload: String,
    },
    DeleteLyrics {
        #[serde(rename = "trackId")]
        track_id: i64,
    },
    UpsertPlaylist {
        id: i64,
        payload: String,
        #[serde(rename = "nextPlaylistId")]
        next_playlist_id: i64,
    },
    DeletePlaylist {
        id: i64,
    },
    AddFolder {
        path: String,
    },
    RemoveFolder {
        path: String,
    },
}

/// Rebuilds the pre-Stage-7 history table in place. Existing IDs, timestamps and payloads are
/// copied verbatim; local rows gain `source_kind='local'`, while the new nullable identity
/// columns let remote rows exist without a fake local track ID.
fn migrate_history_schema(conn: &mut Connection) -> Result<(), String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(listening_history)")
        .map_err(|e| e.to_string())?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    let mut names = Vec::new();
    for column in columns.flatten() {
        names.push(column);
    }
    drop(stmt);
    if names.iter().any(|name| name == "source_kind") {
        return Ok(());
    }
    if !names.iter().any(|name| name == "track_id") {
        return Err("Listening history table has an unrecognized schema".to_string());
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute_batch(
        "
        ALTER TABLE listening_history RENAME TO listening_history_legacy_stage7;
        CREATE TABLE listening_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_kind TEXT NOT NULL DEFAULT 'local',
          track_id INTEGER,
          remote_id TEXT,
          canonical_url TEXT,
          played_at INTEGER NOT NULL,
          payload TEXT NOT NULL,
          CHECK (
            (source_kind = 'local' AND track_id IS NOT NULL AND remote_id IS NULL)
            OR
            (source_kind IN ('youtube', 'youtube-music') AND track_id IS NULL AND remote_id IS NOT NULL)
          )
        );
        INSERT INTO listening_history
          (id, source_kind, track_id, remote_id, canonical_url, played_at, payload)
        SELECT id, 'local', track_id, NULL, NULL, played_at, payload
          FROM listening_history_legacy_stage7;
        DROP TABLE listening_history_legacy_stage7;
        CREATE INDEX IF NOT EXISTS idx_listening_history_played_at
          ON listening_history(played_at DESC, id DESC);
        ",
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

pub struct LibraryDb {
    conn: Mutex<Connection>,
}

impl LibraryDb {
    pub fn open(db_path: &Path, legacy_json_path: &Path) -> Result<Self, String> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
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
              source_kind TEXT NOT NULL DEFAULT 'local',
              track_id INTEGER,
              remote_id TEXT,
              canonical_url TEXT,
              played_at INTEGER NOT NULL,
              payload TEXT NOT NULL,
              CHECK (
                (source_kind = 'local' AND track_id IS NOT NULL AND remote_id IS NULL)
                OR
                (source_kind IN ('youtube', 'youtube-music') AND track_id IS NULL AND remote_id IS NOT NULL)
              )
            );
            CREATE INDEX IF NOT EXISTS idx_listening_history_played_at
              ON listening_history(played_at DESC, id DESC);
            CREATE TABLE IF NOT EXISTS track_intelligence (
              recording_key TEXT PRIMARY KEY,
              track_id INTEGER,
              artist TEXT NOT NULL,
              title TEXT NOT NULL,
              popularity REAL,
              popularity_source TEXT,
              popularity_confidence REAL,
              external_listeners INTEGER,
              external_genres TEXT NOT NULL DEFAULT '[]',
              fetched_at INTEGER,
              expires_at INTEGER,
              skip_count INTEGER NOT NULL DEFAULT 0,
              complete_count INTEGER NOT NULL DEFAULT 0,
              last_skipped_at INTEGER,
              last_completed_at INTEGER,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_track_intelligence_track_id
              ON track_intelligence(track_id);
            CREATE INDEX IF NOT EXISTS idx_track_intelligence_expires_at
              ON track_intelligence(expires_at);
            ",
        )
        .map_err(|e| e.to_string())?;
        migrate_history_schema(&mut conn)?;

        let db = Self {
            conn: Mutex::new(conn),
        };
        let _ = db.import_legacy_json_if_empty(legacy_json_path);
        Ok(db)
    }

    fn import_legacy_json_if_empty(&self, json_path: &Path) -> Result<(), String> {
        if !json_path.is_file() {
            return Ok(());
        }
        let mut conn = self.conn.lock().map_err(|_| "DB mutex poisoned")?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM tracks", [], |row| row.get(0))
            .unwrap_or(0);
        if count > 0 {
            return Ok(());
        }

        let raw = std::fs::read_to_string(json_path).map_err(|e| e.to_string())?;
        let parsed: DbSnapshot = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for track in &parsed.tracks {
            if let (Some(id), Some(path)) = (
                track.get("id").and_then(|v| v.as_i64()),
                track.get("path").and_then(|v| v.as_str()),
            ) {
                let _ = tx.execute(
                    "INSERT OR REPLACE INTO tracks (id, path, payload) VALUES (?1, ?2, ?3)",
                    params![id, path, track.to_string()],
                );
            }
        }
        for (track_id, payload) in &parsed.lyrics {
            if let Ok(id) = track_id.parse::<i64>() {
                let _ = tx.execute(
                    "INSERT OR REPLACE INTO lyrics (track_id, payload) VALUES (?1, ?2)",
                    params![id, payload.to_string()],
                );
            }
        }
        for playlist in &parsed.playlists {
            if let Some(id) = playlist.get("id").and_then(|v| v.as_i64()) {
                let _ = tx.execute(
                    "INSERT OR REPLACE INTO playlists (id, payload) VALUES (?1, ?2)",
                    params![id, playlist.to_string()],
                );
            }
        }
        for folder in &parsed.folders {
            let _ = tx.execute(
                "INSERT OR IGNORE INTO folders (path) VALUES (?1)",
                params![folder],
            );
        }
        let _ = tx.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('nextPlaylistId', ?1)",
            params![parsed.next_playlist_id.to_string()],
        );
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn load_snapshot(&self) -> Result<DbSnapshot, String> {
        let conn = self.conn.lock().map_err(|_| "DB mutex poisoned")?;
        // Keep embedded lyrics out of bootstrap IPC; cmd_load_lyrics reads one row when needed.
        let mut snapshot = DbSnapshot::default();

        {
            let mut stmt = conn
                .prepare("SELECT payload FROM tracks")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                if let Ok(val) = serde_json::from_str::<Value>(&row) {
                    snapshot.tracks.push(val);
                }
            }
        }

        {
            let mut stmt = conn
                .prepare("SELECT payload FROM playlists")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for row in rows.flatten() {
                if let Ok(val) = serde_json::from_str::<Value>(&row) {
                    snapshot.playlists.push(val);
                }
            }
        }

        {
            let mut stmt = conn
                .prepare("SELECT path FROM folders")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            for path in rows.flatten() {
                snapshot.folders.push(path);
            }
        }

        if let Ok(val) = conn.query_row(
            "SELECT value FROM meta WHERE key = 'nextPlaylistId'",
            [],
            |row| row.get::<_, String>(0),
        ) {
            snapshot.next_playlist_id = val.parse::<i64>().unwrap_or(1).max(1);
        }

        Ok(snapshot)
    }

    /// Embedded lyrics can be large and are only needed when resolving one playing track.
    pub fn load_lyrics(&self, track_id: i64) -> Result<Option<Value>, String> {
        let conn = self.conn.lock().map_err(|_| "DB mutex poisoned")?;
        let payload = conn
            .query_row(
                "SELECT payload FROM lyrics WHERE track_id = ?1",
                params![track_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        payload
            .map(|raw| serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()))
            .transpose()
    }

    pub fn add_history_entry(
        &self,
        source_kind: &str,
        track_id: Option<i64>,
        remote_id: Option<&str>,
        canonical_url: Option<&str>,
        played_at: i64,
        payload: &str,
    ) -> Result<i64, String> {
        let valid = match source_kind {
            "local" => track_id.is_some() && remote_id.is_none(),
            "youtube" | "youtube-music" => track_id.is_none() && remote_id.is_some(),
            _ => false,
        };
        if !valid {
            return Err("Invalid listening-history source identity".to_string());
        }
        let mut conn = self.conn.lock().map_err(|_| "DB mutex poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT INTO listening_history
               (source_kind, track_id, remote_id, canonical_url, played_at, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![source_kind, track_id, remote_id, canonical_url, played_at, payload],
        )
        .map_err(|e| e.to_string())?;
        // Bound growth: keep the most recent plays, drop the rest.
        tx.execute(
            "DELETE FROM listening_history WHERE id NOT IN (
                SELECT id FROM listening_history ORDER BY played_at DESC, id DESC LIMIT ?1
            )",
            params![HISTORY_CAP as i64],
        )
        .map_err(|e| e.to_string())?;
        let id: i64 = tx.query_row("SELECT last_insert_rowid()", [], |row| row.get(0)).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn list_history(&self, limit: usize) -> Result<Vec<HistoryEntry>, String> {
        let conn = self.conn.lock().map_err(|_| "DB mutex poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, source_kind, track_id, remote_id, canonical_url, played_at, payload
                   FROM listening_history
                  ORDER BY played_at DESC, id DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, String>(6)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows.flatten() {
            let (id, source_kind, track_id, remote_id, canonical_url, played_at, payload) = row;
            let valid = match source_kind.as_str() {
                "local" => track_id.is_some() && remote_id.is_none(),
                "youtube" | "youtube-music" => track_id.is_none() && remote_id.is_some(),
                _ => false,
            };
            if !valid {
                continue;
            }
            // Skip a row whose payload no longer parses instead of failing the whole
            // restore: one corrupt entry must never blank the user's entire history.
            let Ok(payload) = serde_json::from_str(&payload) else {
                continue;
            };
            out.push(HistoryEntry {
                id,
                source_kind,
                track_id,
                remote_id,
                canonical_url,
                played_at,
                payload,
            });
        }
        Ok(out)
    }

    pub fn clear_history(&self) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|_| "DB mutex poisoned")?;
        conn.execute("DELETE FROM listening_history", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn list_intelligence(&self) -> Result<Vec<TrackIntelligenceRow>, String> {
        let conn = self.conn.lock().map_err(|_| "DB mutex poisoned")?;
        let mut stmt = conn
            .prepare(
                "SELECT recording_key, track_id, artist, title, popularity, popularity_source,
                        popularity_confidence, external_listeners, external_genres, fetched_at,
                        expires_at, skip_count, complete_count, last_skipped_at, last_completed_at,
                        updated_at
                   FROM track_intelligence",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let raw_genres: String = row.get(8).unwrap_or_else(|_| "[]".to_string());
                let external_genres: Vec<String> =
                    serde_json::from_str(&raw_genres).unwrap_or_default();
                Ok(TrackIntelligenceRow {
                    recording_key: row.get(0)?,
                    track_id: row.get(1)?,
                    artist: row.get(2)?,
                    title: row.get(3)?,
                    popularity: row.get(4)?,
                    popularity_source: row.get(5)?,
                    popularity_confidence: row.get(6)?,
                    external_listeners: row.get(7)?,
                    external_genres,
                    fetched_at: row.get(9)?,
                    expires_at: row.get(10)?,
                    skip_count: row.get(11)?,
                    complete_count: row.get(12)?,
                    last_skipped_at: row.get(13)?,
                    last_completed_at: row.get(14)?,
                    updated_at: row.get(15)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows.flatten() {
            out.push(row);
        }
        Ok(out)
    }

    pub fn upsert_intelligence(&self, records: &[TrackIntelligenceRow]) -> Result<(), String> {
        if records.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().map_err(|_| "DB mutex poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for rec in records {
            let genres_json =
                serde_json::to_string(&rec.external_genres).unwrap_or_else(|_| "[]".to_string());
            tx.execute(
                "INSERT INTO track_intelligence (
                   recording_key, track_id, artist, title, popularity, popularity_source,
                   popularity_confidence, external_listeners, external_genres, fetched_at,
                   expires_at, skip_count, complete_count, last_skipped_at, last_completed_at,
                   updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                 ON CONFLICT(recording_key) DO UPDATE SET
                   track_id = COALESCE(excluded.track_id, track_intelligence.track_id),
                   artist = excluded.artist,
                   title = excluded.title,
                   popularity = excluded.popularity,
                   popularity_source = excluded.popularity_source,
                   popularity_confidence = excluded.popularity_confidence,
                   external_listeners = excluded.external_listeners,
                   external_genres = excluded.external_genres,
                   fetched_at = excluded.fetched_at,
                   expires_at = excluded.expires_at,
                   skip_count = excluded.skip_count,
                   complete_count = excluded.complete_count,
                   last_skipped_at = excluded.last_skipped_at,
                   last_completed_at = excluded.last_completed_at,
                   updated_at = excluded.updated_at",
                params![
                    rec.recording_key,
                    rec.track_id,
                    rec.artist,
                    rec.title,
                    rec.popularity,
                    rec.popularity_source,
                    rec.popularity_confidence,
                    rec.external_listeners,
                    genres_json,
                    rec.fetched_at,
                    rec.expires_at,
                    rec.skip_count,
                    rec.complete_count,
                    rec.last_skipped_at,
                    rec.last_completed_at,
                    rec.updated_at,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn apply_batch(&self, ops: &[DbMutation]) -> Result<(), String> {
        if ops.is_empty() {
            return Ok(());
        }
        let mut conn = self.conn.lock().map_err(|_| "DB mutex poisoned")?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for op in ops {
            match op {
                DbMutation::UpsertTrack { id, path, payload } => {
                    tx.execute(
                        "INSERT OR REPLACE INTO tracks (id, path, payload) VALUES (?1, ?2, ?3)",
                        params![id, path, payload],
                    )
                    .map_err(|e| e.to_string())?;
                }
                DbMutation::DeleteTrack { id } => {
                    tx.execute("DELETE FROM tracks WHERE id = ?1", params![id])
                        .map_err(|e| e.to_string())?;
                }
                DbMutation::SetLyrics { track_id, payload } => {
                    tx.execute(
                        "INSERT OR REPLACE INTO lyrics (track_id, payload) VALUES (?1, ?2)",
                        params![track_id, payload],
                    )
                    .map_err(|e| e.to_string())?;
                }
                DbMutation::DeleteLyrics { track_id } => {
                    tx.execute("DELETE FROM lyrics WHERE track_id = ?1", params![track_id])
                        .map_err(|e| e.to_string())?;
                }
                DbMutation::UpsertPlaylist {
                    id,
                    payload,
                    next_playlist_id,
                } => {
                    tx.execute(
                        "INSERT OR REPLACE INTO playlists (id, payload) VALUES (?1, ?2)",
                        params![id, payload],
                    )
                    .map_err(|e| e.to_string())?;
                    tx.execute(
                        "INSERT OR REPLACE INTO meta (key, value) VALUES ('nextPlaylistId', ?1)",
                        params![next_playlist_id.to_string()],
                    )
                    .map_err(|e| e.to_string())?;
                }
                DbMutation::DeletePlaylist { id } => {
                    tx.execute("DELETE FROM playlists WHERE id = ?1", params![id])
                        .map_err(|e| e.to_string())?;
                }
                DbMutation::AddFolder { path } => {
                    tx.execute(
                        "INSERT OR IGNORE INTO folders (path) VALUES (?1)",
                        params![path],
                    )
                    .map_err(|e| e.to_string())?;
                }
                DbMutation::RemoveFolder { path } => {
                    tx.execute("DELETE FROM folders WHERE path = ?1", params![path])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }
}
