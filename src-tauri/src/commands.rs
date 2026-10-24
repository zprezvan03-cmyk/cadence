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

use serde::{Deserialize, Serialize};
use tauri::ipc::Response as IpcResponse;
use tauri::{State, WebviewWindow};
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
    pub allowlist: Arc<MediaAllowlist>,
    pub db: Arc<LibraryDb>,
    pub http_client: reqwest::Client,
    pub active_http_aborts: Mutex<HashMap<String, oneshot::Sender<()>>>,
    pub pending_open_files: Mutex<Vec<String>>,
    pub user_json_lock: Arc<Mutex<()>>,
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
    pub db_snapshot: DbSnapshot,
    pub startup_files: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkedAudioFile {
    pub path: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub has_sidecar_lyrics: bool,
    pub animated_art_path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanErrorEntry {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkResultPayload {
    pub files: Vec<WalkedAudioFile>,
    pub errors: Vec<ScanErrorEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedLyricsFile {
    pub path: String,
    pub text: String,
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
}

fn atomic_write_utf8(target: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("data.json");
    let tmp = target.with_file_name(format!("{file_name}.tmp"));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    if let Err(rename_err) = std::fs::rename(&tmp, target) {
        if cfg!(windows) && target.exists() {
            std::fs::remove_file(target).map_err(|e| e.to_string())?;
            return std::fs::rename(&tmp, target).map_err(|e| e.to_string());
        }
        return Err(rename_err.to_string());
    }
    Ok(())
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

    let animated_candidates = [
        "cover.mp4".to_string(),
        "cover.webm".to_string(),
        format!("{stem}.mp4"),
        format!("{stem}.webm"),
        format!("{stem}-animated.mp4"),
    ];
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

    for audio_path in files {
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
pub fn cmd_bootstrap(state: State<'_, AppState>) -> Result<BootstrapPayload, String> {
    let settings_path = state.app_data_dir.join("settings.json");
    let lyrics_cache_path = state.app_data_dir.join("lyrics-cache.json");

    let settings_json = std::fs::read_to_string(&settings_path).ok();
    let lyrics_cache_json = std::fs::read_to_string(&lyrics_cache_path).ok();
    let db_snapshot = state.db.load_snapshot()?;

    state.allowlist.set_roots(db_snapshot.folders.iter().cloned());

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
        db_snapshot,
        startup_files,
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

#[tauri::command]
pub async fn cmd_write_user_json(
    kind: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let file_name = match kind.as_str() {
        "settings" => "settings.json",
        "lyricsCache" => "lyrics-cache.json",
        _ => return Err("Unsupported configuration file".to_string()),
    };
    let target = state.app_data_dir.join(file_name);
    let lock = Arc::clone(&state.user_json_lock);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        atomic_write_utf8(&target, &content)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cmd_pick_folder(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
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

#[tauri::command]
pub async fn cmd_pick_lyrics_file() -> Result<Option<PickedLyricsFile>, String> {
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

#[tauri::command]
pub async fn cmd_walk_folders(
    folders: Vec<String>,
    state: State<'_, AppState>,
) -> Result<WalkResultPayload, String> {
    let allowlist = Arc::clone(&state.allowlist);
    tauri::async_runtime::spawn_blocking(move || {
        let mut files = Vec::new();
        let mut errors = Vec::new();
        let mut seen = HashSet::new();

        for folder in folders {
            let Some(allowed_dir) = allowlist.resolve_allowed_media(&folder) else {
                errors.push(ScanErrorEntry {
                    path: folder,
                    reason: "Folder is not in library allowlist".to_string(),
                });
                continue;
            };
            match std::fs::metadata(&allowed_dir) {
                Ok(meta) if meta.is_dir() => {
                    let mut folder_files = Vec::new();
                    walk_directory_recursive(&allowed_dir, 0, &mut folder_files);
                    for entry in folder_files {
                        if seen.insert(entry.path.clone()) {
                            files.push(entry);
                        }
                    }
                }
                Ok(_) => errors.push(ScanErrorEntry {
                    path: folder,
                    reason: "Not a directory".to_string(),
                }),
                Err(err) => errors.push(ScanErrorEntry {
                    path: folder,
                    reason: err.to_string(),
                }),
            }
        }

        Ok(WalkResultPayload { files, errors })
    })
    .await
    .map_err(|e| e.to_string())?
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
    state: State<'_, AppState>,
) -> Result<IpcResponse, String> {
    let Some(allowed_path) = state.allowlist.resolve_allowed_media(&path) else {
        return Err("Forbidden".to_string());
    };
    let clamped = length.min(MAX_CHUNK_READ_BYTES);
    if clamped == 0 {
        return Ok(IpcResponse::new(Vec::new()));
    }
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
    file_name: String,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !is_valid_artwork_filename(&file_name) {
        return Err("Invalid artwork file name".to_string());
    }
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

#[tauri::command]
pub async fn cmd_read_sidecar_text(
    path: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
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

#[tauri::command]
pub async fn cmd_write_sidecar_lrc(
    audio_path: String,
    text: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
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

    let timeout_ms = args.timeout_ms.clamp(500, 30_000);
    let mut req = state
        .http_client
        .get(parsed)
        .timeout(Duration::from_millis(timeout_ms));
    for (k, v) in &args.headers {
        req = req.header(k.as_str(), v.as_str());
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
    let resolved = state
        .allowlist
        .resolve_allowed_media(&path)
        .or_else(|| state.allowlist.resolve_contained_artwork(&path))
        .ok_or_else(|| "Path is outside library allowlist".to_string())?;
    tauri_plugin_opener::reveal_item_in_dir(resolved).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_shell_open_external(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("Only http(s) URLs may be opened externally".to_string());
    }
    tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cmd_window_action(action: String, window: WebviewWindow) -> Result<(), String> {
    match action.as_str() {
        "minimize" => window.minimize().map_err(|e| e.to_string()),
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(|e| e.to_string())
            } else {
                window.maximize().map_err(|e| e.to_string())
            }
        }
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

#[tauri::command]
pub fn cmd_window_is_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    window.is_fullscreen().map_err(|e| e.to_string())
}
