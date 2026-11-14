//! Scoped Tauri IPC commands for Cadence.
//!
//! Every command validates its inputs (path containment against `MediaAllowlist`, strict SHA-1
//! artwork filenames, `http`/`https` URL schemes, and bounded read sizes) before performing OS I/O.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

#[cfg(target_os = "android")]
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::ipc::{InvokeBody, Response as IpcResponse};
#[cfg(target_os = "android")]
use tauri::Manager;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;

use crate::allowlist::MediaAllowlist;
use crate::db::{DbMutation, DbSnapshot, LibraryDb};

const MAX_CHUNK_READ_BYTES: usize = 4 * 1024 * 1024;
const MAX_SIDECAR_TEXT_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SCAN_DEPTH: usize = 32;

const AUDIO_EXTENSIONS: &[&str] = &[
    "flac", "mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "mp4", "m4b", "aiff", "aif", "webm",
];
const LYRICS_EXTENSIONS: &[&str] = &["lrc", "ttml", "qrc", "srt", "txt"];
const SKIP_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".git",
    ".svn",
    "$RECYCLE.BIN",
    "System Volume Information",
    ".Trash",
    ".Trashes",
    "@eaDir",
];

pub struct AppState {
    pub app_data_dir: PathBuf,
    pub artwork_dir: PathBuf,
    pub alac_cache_dir: PathBuf,
    pub allowlist: Arc<MediaAllowlist>,
    pub db: Arc<LibraryDb>,
    pub http_client: reqwest::Client,
    pub active_http_aborts: Mutex<HashMap<String, oneshot::Sender<()>>>,
    pub pending_open_files: Mutex<Vec<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    pub app_data_dir: String,
    pub artwork_dir: String,
    pub platform: &'static str,
    pub arch: &'static str,
    pub app_version: String,
    pub tauri_version: &'static str,
    pub settings_json: Option<String>,
    pub lyrics_cache_json: Option<String>,
    pub lyrics_ai_cache_json: Option<String>,
    pub lyrics_fetch_job_json: Option<String>,
    pub db_snapshot: DbSnapshot,
    pub startup_files: Vec<String>,
    /// False when the OS draws no window frame, so the renderer draws its own title bar.
    pub undecorated: bool,
}

/// Window frame state the renderer needs to draw Cadence's integrated title bar.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowChromeState {
    pub undecorated: bool,
    pub maximized: bool,
    pub fullscreen: bool,
    pub focused: bool,
}

fn read_window_chrome(window: &WebviewWindow) -> WindowChromeState {
    #[cfg(desktop)]
    {
        WindowChromeState {
            undecorated: !window.is_decorated().unwrap_or(true),
            maximized: window.is_maximized().unwrap_or(false),
            fullscreen: window.is_fullscreen().unwrap_or(false),
            focused: window.is_focused().unwrap_or(true),
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = window;
        WindowChromeState {
            undecorated: false,
            maximized: false,
            fullscreen: false,
            focused: true,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkedAudioFile {
    pub path: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub has_sidecar_lyrics: bool,
    pub animated_art_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanErrorEntry {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkResultPayload {
    pub files: Vec<WalkedAudioFile>,
    pub errors: Vec<ScanErrorEntry>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedLyricsFile {
    pub path: String,
    pub text: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecodeDeleteOutcome {
    pub path: String,
    pub deleted: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpFetchArgs {
    pub request_id: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub timeout_ms: u64,
    /// HTTP method; absent keeps the historical GET-only behaviour.
    #[serde(default)]
    pub method: Option<String>,
    /// Optional request body for POST-style calls (e.g. last.fm scrobbling).
    #[serde(default)]
    pub body: Option<String>,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidPickReply {
    path: Option<String>,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidChunkReply {
    base64: String,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidTextReply {
    text: Option<String>,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidListDirReply {
    names: Vec<String>,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidPathReply {
    path: String,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AndroidExportReply {
    path: Option<String>,
}

#[cfg(target_os = "android")]
fn android_plugin(app: &AppHandle) -> Result<&crate::CadenceAndroidHandle, String> {
    app.try_state::<crate::CadenceAndroidHandle>()
        .map(|s| s.inner())
        .ok_or_else(|| "Android plugin is not initialized".to_string())
}

fn atomic_write_utf8(target: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = target.with_extension("json.tmp");
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    if cfg!(windows) && target.exists() {
        let _ = std::fs::remove_file(target);
    }
    std::fs::rename(&tmp, target).map_err(|e| e.to_string())
}

pub fn is_audio_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_lyrics_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|ext| LYRICS_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn mtime_milliseconds(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn animated_art_candidate_names(audio_path: &Path) -> Vec<String> {
    let stem = audio_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    vec![
        "cover.mp4".to_string(),
        "cover.webm".to_string(),
        format!("{stem}.mp4"),
        format!("{stem}.webm"),
        format!("{stem}-animated.mp4"),
    ]
}

fn build_audio_entry(
    audio_path: &Path,
    meta: &std::fs::Metadata,
    sibling_lookup: Option<&HashMap<String, PathBuf>>,
) -> WalkedAudioFile {
    let dir = audio_path.parent().unwrap_or_else(|| Path::new(""));
    let stem = audio_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    let lookup_file = |name: &str| -> Option<PathBuf> {
        if let Some(map) = sibling_lookup {
            map.get(&name.to_lowercase()).cloned()
        } else {
            let candidate = dir.join(name);
            candidate.is_file().then_some(candidate)
        }
    };

    let mut has_sidecar_lyrics = false;
    for ext in LYRICS_EXTENSIONS {
        if lookup_file(&format!("{stem}.{ext}")).is_some() {
            has_sidecar_lyrics = true;
            break;
        }
    }

    let animated_candidates = animated_art_candidate_names(audio_path);
    let mut animated_art_path = None;
    for candidate_name in &animated_candidates {
        if let Some(found) = lookup_file(candidate_name) {
            if found != audio_path {
                animated_art_path = Some(found.to_string_lossy().into_owned());
                break;
            }
        }
    }

    WalkedAudioFile {
        path: audio_path.to_string_lossy().into_owned(),
        size: meta.len(),
        mtime_ms: mtime_milliseconds(meta),
        has_sidecar_lyrics,
        animated_art_path,
    }
}

fn walk_directory_recursive(
    dir: &Path,
    depth: usize,
    out: &mut Vec<WalkedAudioFile>,
) {
    if depth > MAX_SCAN_DEPTH {
        return;
    }
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };

    let mut subdirs = Vec::new();
    let mut files = Vec::new();
    let mut sibling_map: HashMap<String, PathBuf> = HashMap::new();

    for entry in read_dir.flatten() {
        let name_os = entry.file_name();
        let name = name_os.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            if !SKIP_DIRECTORIES.contains(&name.as_ref()) {
                subdirs.push(path);
            }
        } else if file_type.is_file() {
            sibling_map.insert(name.to_lowercase(), path.clone());
            if is_audio_extension(&path) {
                files.push(path);
            }
        }
    }

    // Animated covers share audio extensions, but must not become independent library tracks.
    let mut animated_art_paths = HashSet::new();
    for audio_path in &files {
        for candidate_name in animated_art_candidate_names(audio_path) {
            if let Some(found) = sibling_map.get(&candidate_name.to_lowercase()) {
                if found != audio_path {
                    animated_art_paths.insert(found.clone());
                }
            }
        }
    }
    for audio_path in files
        .into_iter()
        .filter(|path| !animated_art_paths.contains(path))
    {
        if let Ok(meta) = std::fs::metadata(&audio_path) {
            out.push(build_audio_entry(&audio_path, &meta, Some(&sibling_map)));
        }
    }

    for subdir in subdirs {
        walk_directory_recursive(&subdir, depth + 1, out);
    }
}

fn is_valid_artwork_filename(name: &str) -> bool {
    let Some((stem, ext)) = name.split_once('.') else {
        return false;
    };
    if stem.len() != 40 || !stem.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    matches!(ext, "jpg" | "png" | "webp" | "gif" | "bmp")
}

#[tauri::command]
pub fn cmd_bootstrap(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<BootstrapPayload, String> {
    let settings_path = state.app_data_dir.join("settings.json");
    let lyrics_cache_path = state.app_data_dir.join("lyrics-cache.json");
    let lyrics_ai_cache_path = state.app_data_dir.join("lyrics-ai-cache.json");
    let lyrics_fetch_job_path = state.app_data_dir.join("lyrics-fetch-job.json");

    let settings_json = std::fs::read_to_string(&settings_path).ok();
    let lyrics_cache_json = std::fs::read_to_string(&lyrics_cache_path).ok();
    let lyrics_ai_cache_json = std::fs::read_to_string(&lyrics_ai_cache_path).ok();
    let lyrics_fetch_job_json = std::fs::read_to_string(&lyrics_fetch_job_path).ok();
    let db_snapshot = state.db.load_snapshot()?;

    state.allowlist.set_roots(db_snapshot.folders.iter().cloned());
    // Also authorize already-scanned tracks (critical on Android when MediaStore scanned `/storage/...`
    // paths under `mediastore://audio`).
    for track in &db_snapshot.tracks {
        if let Some(raw_path) = track.get("path").and_then(|v| v.as_str()) {
            let track_path = Path::new(raw_path);
            state.allowlist.add_file(track_path);
            if !crate::allowlist::is_content_or_mediastore_uri(raw_path) {
                if let Some(parent) = track_path.parent() {
                    state.allowlist.add_root(parent);
                }
            }
        }
    }

    let startup_files = state
        .pending_open_files
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default();
    for file in &startup_files {
        state.allowlist.add_file(Path::new(file));
    }

    let platform = if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else {
        "linux"
    };

    Ok(BootstrapPayload {
        app_data_dir: state.app_data_dir.to_string_lossy().into_owned(),
        artwork_dir: state.artwork_dir.to_string_lossy().into_owned(),
        platform,
        arch: std::env::consts::ARCH,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        tauri_version: tauri::VERSION,
        settings_json,
        lyrics_cache_json,
        lyrics_ai_cache_json,
        lyrics_fetch_job_json,
        db_snapshot,
        startup_files,
        undecorated: read_window_chrome(&window).undecorated,
    })
}

#[tauri::command]
pub fn cmd_allowlist_sync(roots: Vec<String>, state: State<'_, AppState>) -> Result<(), String> {
    state.allowlist.set_roots(roots);
    Ok(())
}

#[tauri::command]
pub async fn cmd_db_mutate(
    ops: Vec<DbMutation>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || db.apply_batch(&ops))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
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

#[tauri::command]
pub async fn cmd_history_add(
    source_kind: String,
    track_id: Option<i64>,
    remote_id: Option<String>,
    canonical_url: Option<String>,
    played_at: i64,
    payload: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        db.add_history_entry(
            &source_kind,
            track_id,
            remote_id.as_deref(),
            canonical_url.as_deref(),
            played_at,
            &payload,
        )
    })
        .await
        .map_err(|e| e.to_string())??;
    Ok(())
}

#[tauri::command]
pub async fn cmd_history_list(state: State<'_, AppState>) -> Result<Vec<HistoryEntry>, String> {
    let db = Arc::clone(&state.db);
    let rows = tauri::async_runtime::spawn_blocking(move || db.list_history(1000))
        .await
        .map_err(|e| e.to_string())??;
    Ok(rows
        .into_iter()
        .map(|row| HistoryEntry {
            id: row.id,
            source_kind: row.source_kind,
            track_id: row.track_id,
            remote_id: row.remote_id,
            canonical_url: row.canonical_url,
            played_at: row.played_at,
            payload: row.payload,
        })
        .collect())
}

#[tauri::command]
pub async fn cmd_history_clear(state: State<'_, AppState>) -> Result<(), String> {
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || db.clear_history())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_load_lyrics(
    track_id: i64,
    state: State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || db.load_lyrics(track_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_write_user_json(
    kind: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let file_name = match kind.as_str() {
        "settings" => "settings.json",
        "lyricsCache" => "lyrics-cache.json",
        "lyricsAiCache" => "lyrics-ai-cache.json",
        "lyricsFetchJob" => "lyrics-fetch-job.json",
        _ => return Err("Unsupported configuration file".to_string()),
    };
    let target = state.app_data_dir.join(file_name);
    tauri::async_runtime::spawn_blocking(move || atomic_write_utf8(&target, &content))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_pick_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    {
        let _ = app;
        let picked = tauri::async_runtime::spawn_blocking(|| {
            rfd::FileDialog::new()
                .set_title("Choose a music folder")
                .pick_folder()
        })
        .await
        .map_err(|e| e.to_string())?;

        let Some(raw_path) = picked else {
            return Ok(None);
        };
        let path = crate::allowlist::strip_verbatim_prefix(raw_path);
        state.allowlist.add_root(&path);
        Ok(Some(path.to_string_lossy().into_owned()))
    }

    #[cfg(target_os = "android")]
    {
        let plugin = android_plugin(&app)?;
        let reply: AndroidPickReply = plugin
            .0
            .run_mobile_plugin_async("pickMusicFolder", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())?;
        if let Some(uri) = reply.path {
            state.allowlist.add_content_root(&uri);
            Ok(Some(uri))
        } else {
            Ok(None)
        }
    }

    #[cfg(not(any(desktop, target_os = "android")))]
    {
        let _ = (app, state);
        Ok(None)
    }
}

#[tauri::command]
pub async fn cmd_pick_lyrics_file(app: AppHandle) -> Result<Option<PickedLyricsFile>, String> {
    #[cfg(desktop)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(|| {
            let picked = rfd::FileDialog::new()
                .set_title("Choose a lyrics file")
                .add_filter("Lyrics", &["ttml", "qrc", "lrc", "srt", "txt"])
                .pick_file();
            let Some(raw_path) = picked else {
                return Ok(None);
            };
            let path = crate::allowlist::strip_verbatim_prefix(raw_path);
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            Ok(Some(PickedLyricsFile {
                path: path.to_string_lossy().into_owned(),
                text,
            }))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[cfg(target_os = "android")]
    {
        let plugin = android_plugin(&app)?;
        let reply: Option<PickedLyricsFile> = plugin
            .0
            .run_mobile_plugin_async("pickLyricsFile", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())?;
        Ok(reply)
    }

    #[cfg(not(any(desktop, target_os = "android")))]
    {
        let _ = app;
        Ok(None)
    }
}

#[tauri::command]
pub async fn cmd_walk_folders(
    folders: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<WalkResultPayload, String> {
    let allowlist = Arc::clone(&state.allowlist);

    #[cfg(not(target_os = "android"))]
    let _ = app;

    let mut files = Vec::new();
    let mut errors = Vec::new();
    let mut seen = HashSet::new();

    let mut posix_folders = Vec::new();
    let mut virtual_folders = Vec::new();

    for folder in folders {
        if crate::allowlist::is_content_or_mediastore_uri(&folder) {
            allowlist.add_content_root(&folder);
            virtual_folders.push(folder);
        } else {
            posix_folders.push(folder);
        }
    }

    if !posix_folders.is_empty() {
        let allowlist_clone = Arc::clone(&allowlist);
        let posix_res = tauri::async_runtime::spawn_blocking(move || -> WalkResultPayload {
            let mut local_files = Vec::new();
            let mut local_errors = Vec::new();

            for folder in posix_folders {
                let Some(allowed_dir) = allowlist_clone.resolve_allowed_media(&folder) else {
                    local_errors.push(ScanErrorEntry {
                        path: folder,
                        reason: "Folder is not in library allowlist".to_string(),
                    });
                    continue;
                };
                match std::fs::metadata(&allowed_dir) {
                    Ok(meta) if meta.is_dir() => {
                        let mut folder_files = Vec::new();
                        walk_directory_recursive(&allowed_dir, 0, &mut folder_files);
                        local_files.extend(folder_files);
                    }
                    Ok(_) => local_errors.push(ScanErrorEntry {
                        path: folder,
                        reason: "Not a directory".to_string(),
                    }),
                    Err(err) => local_errors.push(ScanErrorEntry {
                        path: folder,
                        reason: err.to_string(),
                    }),
                }
            }
            WalkResultPayload {
                files: local_files,
                errors: local_errors,
            }
        })
        .await
        .map_err(|e| e.to_string())?;

        for entry in posix_res.files {
            if seen.insert(entry.path.clone()) {
                files.push(entry);
            }
        }
        errors.extend(posix_res.errors);
    }

    #[cfg(target_os = "android")]
    if !virtual_folders.is_empty() {
        let plugin = android_plugin(&app)?;
        let android_res: WalkResultPayload = plugin
            .0
            .run_mobile_plugin_async(
                "walkFolders",
                serde_json::json!({ "folders": virtual_folders }),
            )
            .await
            .map_err(|e| e.to_string())?;

        for entry in android_res.files {
            let entry_path = Path::new(&entry.path);
            allowlist.add_file(entry_path);
            if !crate::allowlist::is_content_or_mediastore_uri(&entry.path) {
                if let Some(parent) = entry_path.parent() {
                    allowlist.add_root(parent);
                }
            }
            if let Some(ref art_path) = entry.animated_art_path {
                allowlist.add_file(Path::new(art_path));
            }
            if seen.insert(entry.path.clone()) {
                files.push(entry);
            }
        }
        errors.extend(android_res.errors);
    }

    #[cfg(not(target_os = "android"))]
    for folder in virtual_folders {
        errors.push(ScanErrorEntry {
            path: folder,
            reason: "Virtual Android URI is not supported on this platform".to_string(),
        });
    }

    Ok(WalkResultPayload { files, errors })
}

#[tauri::command]
pub async fn cmd_stat_audio_files(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<WalkedAudioFile>, String> {
    let allowlist = Arc::clone(&state.allowlist);
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for raw in paths {
            let p = PathBuf::from(&raw);
            if !is_audio_extension(&p) {
                continue;
            }
            if let Ok(meta) = std::fs::metadata(&p) {
                if meta.is_file() {
                    allowlist.add_file(&p);
                    out.push(build_audio_entry(&p, &meta, None));
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_read_file_chunk(
    path: String,
    offset: u64,
    length: usize,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<IpcResponse, String> {
    #[cfg(not(target_os = "android"))]
    let _ = app;

    let clamped = length.min(MAX_CHUNK_READ_BYTES);
    if clamped == 0 {
        return Ok(IpcResponse::new(Vec::new()));
    }

    #[cfg(target_os = "android")]
    if path.starts_with("content://") {
        if !state.allowlist.is_allowed_content_uri(&path) {
            return Err("Forbidden".to_string());
        }
        let plugin = android_plugin(&app)?;
        let reply: AndroidChunkReply = plugin
            .0
            .run_mobile_plugin_async(
                "readContentChunk",
                serde_json::json!({
                    "uri": path,
                    "offset": offset,
                    "length": clamped
                }),
            )
            .await
            .map_err(|e| e.to_string())?;
        let bytes = STANDARD.decode(reply.base64).map_err(|e| e.to_string())?;
        return Ok(IpcResponse::new(bytes));
    }

    let Some(allowed_path) = state.allowlist.resolve_allowed_media(&path) else {
        return Err("Forbidden".to_string());
    };
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut file = File::open(&allowed_path).map_err(|e| e.to_string())?;
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; clamped];
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        buf.truncate(n);
        Ok(buf)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(IpcResponse::new(bytes))
}

#[tauri::command]
pub async fn cmd_save_artwork(
    request: tauri::ipc::Request<'_>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let file_name = request
        .headers()
        .get("x-file-name")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "Missing artwork file name".to_string())?
        .to_string();
    if !is_valid_artwork_filename(&file_name) {
        return Err("Invalid artwork file name".to_string());
    }
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("Artwork must be sent as raw bytes".to_string());
    };
    let data = bytes.to_vec();
    drop(request); // Do not carry the IPC borrow across the blocking-file-write await.
    let target = state.artwork_dir.join(&file_name);
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        if !target.exists() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&target, &data).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(file_name)
}

/// Build a cached, seekable PCM source for an actual ALAC stream.
///
/// The source path is revalidated against the media allowlist here; the decoder independently
/// inspects the MP4 codec metadata and rejects AAC even when its extension is `.m4a`.
#[tauri::command]
pub async fn cmd_prepare_alac_playback(
    source_path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    #[cfg(not(target_os = "android"))]
    let _ = app;

    let cache_dir = state.alac_cache_dir.clone();
    let allowlist = Arc::clone(&state.allowlist);

    #[cfg(target_os = "android")]
    if source_path.starts_with("content://") {
        if !allowlist.is_allowed_content_uri(&source_path) {
            return Err("Audio path is outside library allowlist".to_string());
        }
        let temp_input = cache_dir.join(format!("alac-src-{}.m4a", std::process::id()));
        let plugin = android_plugin(&app)?;
        let _: Value = plugin
            .0
            .run_mobile_plugin_async(
                "copyContentToFile",
                serde_json::json!({
                    "uri": source_path,
                    "destPath": temp_input.to_string_lossy().into_owned()
                }),
            )
            .await
            .map_err(|e| e.to_string())?;

        let decoded_res = tauri::async_runtime::spawn_blocking(move || {
            let res = crate::alac::decode_alac_to_wav_cached(&temp_input, &cache_dir);
            let _ = std::fs::remove_file(&temp_input);
            let decoded = res?;
            allowlist.add_file(&decoded);
            Ok::<String, String>(decoded.to_string_lossy().into_owned())
        })
        .await
        .map_err(|error| error.to_string())??;

        return Ok(decoded_res);
    }

    let Some(source) = state.allowlist.resolve_allowed_media(&source_path) else {
        return Err("Audio path is outside library allowlist".to_string());
    };
    tauri::async_runtime::spawn_blocking(move || {
        let decoded = crate::alac::decode_alac_to_wav_cached(&source, &cache_dir)?;
        allowlist.add_file(&decoded);
        Ok(decoded.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn cmd_read_sidecar_text(
    path: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    #[cfg(not(target_os = "android"))]
    let _ = app;

    #[cfg(target_os = "android")]
    if path.starts_with("content://") {
        if !state.allowlist.is_allowed_content_uri(&path) {
            return Ok(None);
        }
        let plugin = android_plugin(&app)?;
        let reply: AndroidTextReply = plugin
            .0
            .run_mobile_plugin_async("readSidecarText", serde_json::json!({ "uri": path }))
            .await
            .map_err(|e| e.to_string())?;
        return Ok(reply.text);
    }

    let Some(allowed) = state.allowlist.resolve_allowed_media(&path) else {
        return Ok(None);
    };
    if !is_lyrics_extension(&allowed) {
        return Ok(None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(meta) = std::fs::metadata(&allowed) else {
            return Ok(None);
        };
        if !meta.is_file() || meta.len() > MAX_SIDECAR_TEXT_BYTES {
            return Ok(None);
        }
        Ok(std::fs::read_to_string(&allowed).ok())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Names in an allowlisted directory. Sidecar discovery uses the real spellings instead of
/// guessing every mixed-case variant of a lyrics extension on case-sensitive filesystems.
#[tauri::command]
pub async fn cmd_list_directory(
    directory: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    #[cfg(not(target_os = "android"))]
    let _ = app;

    #[cfg(target_os = "android")]
    if directory.starts_with("content://") {
        if !state.allowlist.is_allowed_content_uri(&directory) {
            return Ok(Vec::new());
        }
        let plugin = android_plugin(&app)?;
        let reply: AndroidListDirReply = plugin
            .0
            .run_mobile_plugin_async("listDirectory", serde_json::json!({ "uri": directory }))
            .await
            .map_err(|e| e.to_string())?;
        return Ok(reply.names);
    }

    let Some(allowed) = state.allowlist.resolve_allowed_media(&directory) else {
        return Ok(Vec::new());
    };
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let Ok(entries) = std::fs::read_dir(&allowed) else {
            return Ok(Vec::new());
        };
        let mut names = Vec::new();
        for entry in entries.flatten() {
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        Ok(names)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn cmd_write_sidecar_lrc(
    audio_path: String,
    text: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    #[cfg(not(target_os = "android"))]
    let _ = app;

    #[cfg(target_os = "android")]
    if audio_path.starts_with("content://") {
        if !state.allowlist.is_allowed_content_uri(&audio_path) {
            return Err("Audio path is outside library allowlist".to_string());
        }
        let plugin = android_plugin(&app)?;
        let reply: AndroidPathReply = plugin
            .0
            .run_mobile_plugin_async(
                "writeSidecar",
                serde_json::json!({ "audioUri": audio_path, "text": text, "ext": "lrc" }),
            )
            .await
            .map_err(|e| e.to_string())?;
        state.allowlist.add_content_file(&reply.path);
        return Ok(reply.path);
    }

    let Some(allowed_audio) = state.allowlist.resolve_allowed_media(&audio_path) else {
        return Err("Audio path is outside library allowlist".to_string());
    };
    if !is_audio_extension(&allowed_audio) {
        return Err("Target is not an audio file".to_string());
    }
    let lrc_path = allowed_audio.with_extension("lrc");
    let returned = lrc_path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&lrc_path, text.as_bytes()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(returned)
}

#[tauri::command]
pub async fn cmd_write_sidecar_ttml(
    audio_path: String,
    text: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    #[cfg(not(target_os = "android"))]
    let _ = app;

    #[cfg(target_os = "android")]
    if audio_path.starts_with("content://") {
        if !state.allowlist.is_allowed_content_uri(&audio_path) {
            return Err("Audio path is outside library allowlist".to_string());
        }
        let plugin = android_plugin(&app)?;
        let reply: AndroidPathReply = plugin
            .0
            .run_mobile_plugin_async(
                "writeSidecar",
                serde_json::json!({ "audioUri": audio_path, "text": text, "ext": "ttml" }),
            )
            .await
            .map_err(|e| e.to_string())?;
        state.allowlist.add_content_file(&reply.path);
        return Ok(reply.path);
    }

    let Some(allowed_audio) = state.allowlist.resolve_allowed_media(&audio_path) else {
        return Err("Audio path is outside library allowlist".to_string());
    };
    if !is_audio_extension(&allowed_audio) {
        return Err("Target is not an audio file".to_string());
    }
    let ttml_path = allowed_audio.with_extension("ttml");
    let returned = ttml_path.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&ttml_path, text.as_bytes()).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(returned)
}

#[tauri::command]
pub async fn cmd_decode_delete_files(
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<DecodeDeleteOutcome>, String> {
    #[cfg(not(target_os = "android"))]
    let _ = app;

    let allowlist = Arc::clone(&state.allowlist);
    let mut seen = HashSet::new();
    let mut posix_paths = Vec::new();
    let mut content_paths = Vec::new();

    for raw in paths {
        if !seen.insert(raw.clone()) {
            continue;
        }
        if raw.starts_with("content://") {
            content_paths.push(raw);
        } else {
            posix_paths.push(raw);
        }
    }

    let mut outcomes = Vec::new();

    if !posix_paths.is_empty() {
        let allowlist_clone = Arc::clone(&allowlist);
        let local_outcomes = tauri::async_runtime::spawn_blocking(move || {
            let mut list = Vec::new();
            for raw in posix_paths {
                let result = (|| -> Result<(), String> {
                    let resolved = allowlist_clone
                        .resolve_allowed_media(&raw)
                        .ok_or_else(|| "Path is outside library allowlist".to_string())?;
                    if !is_audio_extension(&resolved) {
                        return Err("Target is not an audio file".to_string());
                    }
                    let metadata = std::fs::metadata(&resolved).map_err(|e| e.to_string())?;
                    if !metadata.is_file() {
                        return Err("Target is not a file".to_string());
                    }
                    std::fs::remove_file(&resolved).map_err(|e| e.to_string())
                })();
                list.push(match result {
                    Ok(()) => DecodeDeleteOutcome {
                        path: raw,
                        deleted: true,
                        error: None,
                    },
                    Err(error) => DecodeDeleteOutcome {
                        path: raw,
                        deleted: false,
                        error: Some(error),
                    },
                });
            }
            list
        })
        .await
        .map_err(|e| e.to_string())?;
        outcomes.extend(local_outcomes);
    }

    #[cfg(target_os = "android")]
    if !content_paths.is_empty() {
        let mut allowed_uris = Vec::new();
        for uri in content_paths {
            if allowlist.is_allowed_content_uri(&uri) {
                allowed_uris.push(uri);
            } else {
                outcomes.push(DecodeDeleteOutcome {
                    path: uri,
                    deleted: false,
                    error: Some("Path is outside library allowlist".to_string()),
                });
            }
        }
        if !allowed_uris.is_empty() {
            let plugin = android_plugin(&app)?;
            let remote_outcomes: Vec<DecodeDeleteOutcome> = plugin
                .0
                .run_mobile_plugin_async(
                    "deleteContentUris",
                    serde_json::json!({ "uris": allowed_uris }),
                )
                .await
                .map_err(|e| e.to_string())?;
            outcomes.extend(remote_outcomes);
        }
    }

    #[cfg(not(target_os = "android"))]
    for uri in content_paths {
        outcomes.push(DecodeDeleteOutcome {
            path: uri,
            deleted: false,
            error: Some("Android content URI deletion not supported on desktop".to_string()),
        });
    }

    Ok(outcomes)
}

#[tauri::command]
pub async fn cmd_decode_export_list(
    paths: Vec<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let allowlist = Arc::clone(&state.allowlist);
    let mut seen = HashSet::new();
    let mut lines: Vec<String> = Vec::new();
    for raw in &paths {
        if !seen.insert(raw.clone()) {
            continue;
        }
        let allowed = if raw.starts_with("content://") {
            allowlist.is_allowed_content_uri(raw)
        } else {
            allowlist.resolve_allowed_media(raw).is_some()
        };
        if allowed {
            lines.push(raw.clone());
        }
    }
    if lines.is_empty() {
        return Err("No library files to export".to_string());
    }
    let mut content = lines.join("\n");
    content.push('\n');

    #[cfg(desktop)]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
            let picked = rfd::FileDialog::new()
                .set_title("Export problematic file list")
                .add_filter("Text files", &["txt"])
                .set_file_name("cadence-decode-problems.txt")
                .save_file();
            let Some(raw_path) = picked else {
                return Ok(None);
            };
            let path = crate::allowlist::strip_verbatim_prefix(raw_path);
            std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
            Ok(Some(path.to_string_lossy().into_owned()))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[cfg(target_os = "android")]
    {
        let plugin = android_plugin(&app)?;
        let reply: AndroidExportReply = plugin
            .0
            .run_mobile_plugin_async(
                "exportTextFile",
                serde_json::json!({
                    "fileName": "cadence-decode-problems.txt",
                    "content": content
                }),
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(reply.path)
    }

    #[cfg(not(any(desktop, target_os = "android")))]
    {
        let _ = app;
        Ok(None)
    }
}

#[tauri::command]
pub async fn cmd_http_fetch(
    args: HttpFetchArgs,
    state: State<'_, AppState>,
) -> Result<HttpFetchResponse, String> {
    let parsed = url::Url::parse(&args.url).map_err(|_| "Invalid URL".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Refusing non-http(s) URL".to_string());
    }

    let (abort_tx, abort_rx) = oneshot::channel::<()>();
    if let Ok(mut guard) = state.active_http_aborts.lock() {
        guard.insert(args.request_id.clone(), abort_tx);
    }

    let timeout_ms = args.timeout_ms.clamp(500, 300_000);
    let method = match args.method.as_deref().map(str::to_ascii_uppercase).as_deref() {
        Some("POST") => reqwest::Method::POST,
        Some("PUT") => reqwest::Method::PUT,
        Some("DELETE") => reqwest::Method::DELETE,
        _ => reqwest::Method::GET,
    };
    let mut req = state
        .http_client
        .request(method, parsed)
        .timeout(Duration::from_millis(timeout_ms));
    for (k, v) in &args.headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(body) = &args.body {
        req = req.body(body.clone());
    }

    let outcome = tokio::select! {
        _ = abort_rx => Err("ABORTED".to_string()),
        res = async {
            let response = req.send().await.map_err(|e| {
                if e.is_timeout() {
                    "TIMEOUT".to_string()
                } else {
                    format!("NETWORK: {e}")
                }
            })?;
            let status = response.status().as_u16();
            let mut headers = HashMap::new();
            for (name, val) in response.headers() {
                if let Ok(s) = val.to_str() {
                    headers.insert(name.as_str().to_string(), s.to_string());
                }
            }
            let body = response.text().await.map_err(|e| format!("NETWORK: {e}"))?;
            Ok(HttpFetchResponse { status, headers, body })
        } => res,
    };

    if let Ok(mut guard) = state.active_http_aborts.lock() {
        guard.remove(&args.request_id);
    }
    outcome
}

#[tauri::command]
pub fn cmd_http_abort(request_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Ok(mut guard) = state.active_http_aborts.lock() {
        if let Some(tx) = guard.remove(&request_id) {
            let _ = tx.send(());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_shell_show_in_folder(path: String, state: State<'_, AppState>) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let resolved = state
            .allowlist
            .resolve_allowed_media(&path)
            .or_else(|| state.allowlist.resolve_contained_artwork(&path))
            .ok_or_else(|| "Path is outside library allowlist".to_string())?;
        tauri_plugin_opener::reveal_item_in_dir(resolved).map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (path, state);
        Err("Revealing files in folder is not supported on mobile".to_string())
    }
}

#[tauri::command]
pub fn cmd_shell_open_external(url: String, app: AppHandle) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Only http(s) URLs may be opened externally".to_string());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_window_action(action: String, window: WebviewWindow) -> Result<(), String> {
    #[cfg(desktop)]
    {
        match action.as_str() {
            "minimize" => window.minimize().map_err(|e| e.to_string()),
            "maximize" => {
                if window.is_maximized().unwrap_or(false) {
                    window.unmaximize().map_err(|e| e.to_string())
                } else {
                    window.maximize().map_err(|e| e.to_string())
                }
            }
            "restore" => window.unmaximize().map_err(|e| e.to_string()),
            "close" => window.close().map_err(|e| e.to_string()),
            "fullscreen" => window.set_fullscreen(true).map_err(|e| e.to_string()),
            "exitFullscreen" => window.set_fullscreen(false).map_err(|e| e.to_string()),
            "toggleFullScreen" => {
                let next = !window.is_fullscreen().unwrap_or(false);
                window.set_fullscreen(next).map_err(|e| e.to_string())
            }
            _ => Err("Unknown window action".to_string()),
        }
    }
    #[cfg(not(desktop))]
    {
        let _ = (action, window);
        Ok(())
    }
}

#[cfg(desktop)]
struct MiniPlayerState {
    enabled: bool,
    previous_size: Option<(f64, f64)>,
}

#[cfg(desktop)]
static MINI_PLAYER: Mutex<MiniPlayerState> = Mutex::new(MiniPlayerState {
    enabled: false,
    previous_size: None,
});

#[tauri::command]
pub fn cmd_set_mini_player(enabled: bool, window: WebviewWindow) -> Result<(), String> {
    #[cfg(desktop)]
    {
        let mut state = MINI_PLAYER
            .lock()
            .map_err(|_| "Mini-player state unavailable".to_string())?;
        if enabled {
            if !state.enabled {
                if window.is_fullscreen().unwrap_or(false) {
                    window.set_fullscreen(false).map_err(|e| e.to_string())?;
                }
                if window.is_maximized().unwrap_or(false) {
                    window.unmaximize().map_err(|e| e.to_string())?;
                }
                let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
                if let Ok(size) = window.inner_size() {
                    state.previous_size =
                        Some((size.width as f64 / scale, size.height as f64 / scale));
                }
            }
            window
                .set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(
                    360.0, 132.0,
                ))))
                .map_err(|e| e.to_string())?;
            window
                .set_size(tauri::Size::Logical(tauri::LogicalSize::new(460.0, 160.0)))
                .map_err(|e| e.to_string())?;
            window.set_resizable(false).map_err(|e| e.to_string())?;
            window.set_always_on_top(true).map_err(|e| e.to_string())?;
            state.enabled = true;
        } else {
            let (width, height) = state.previous_size.unwrap_or((1440.0, 920.0));
            window.set_always_on_top(false).map_err(|e| e.to_string())?;
            window.set_resizable(true).map_err(|e| e.to_string())?;
            window
                .set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(
                    1040.0, 680.0,
                ))))
                .map_err(|e| e.to_string())?;
            window
                .set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                    width.max(1040.0),
                    height.max(680.0),
                )))
                .map_err(|e| e.to_string())?;
            state.enabled = false;
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (enabled, window);
        Ok(())
    }
}

#[tauri::command]
pub fn cmd_window_is_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    #[cfg(desktop)]
    {
        window.is_fullscreen().map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = window;
        Ok(false)
    }
}

#[tauri::command]
pub fn cmd_window_chrome_state(window: WebviewWindow) -> Result<WindowChromeState, String> {
    Ok(read_window_chrome(&window))
}

#[tauri::command]
pub async fn cmd_android_request_permissions(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let plugin = android_plugin(&app)?;
        plugin
            .0
            .run_mobile_plugin_async("requestAudioPermissions", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(serde_json::json!({
            "audioGranted": true,
            "notificationsGranted": true,
            "unsupported": true
        }))
    }
}

#[tauri::command]
pub async fn cmd_android_audio_action(
    action: String,
    payload: Value,
    app: AppHandle,
) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let plugin = android_plugin(&app)?;
        plugin
            .0
            .run_mobile_plugin_async(
                "audioAction",
                serde_json::json!({
                    "action": action,
                    "payload": payload
                }),
            )
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (action, payload, app);
        Ok(serde_json::json!({ "unsupported": true }))
    }
}

#[tauri::command]
pub async fn cmd_android_system_info(app: AppHandle) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        let plugin = android_plugin(&app)?;
        plugin
            .0
            .run_mobile_plugin_async("getSystemInfo", serde_json::json!({}))
            .await
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(serde_json::json!({ "unsupported": true }))
    }
}
