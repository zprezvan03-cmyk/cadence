//! Cadence Tauri v2 application bootstrap.
//!
//! Wires single-instance CLI audio-file handoff, the `cadence-media` HTTP Range streaming scheme,
//! SQLite library persistence (`library.db`), global hardware media keys (`MediaPlayPause`,
//! `MediaTrackNext`, `MediaTrackPrevious`, `MediaStop`), and least-privilege IPC commands.

pub mod allowlist;
pub mod commands;
pub mod db;
pub mod protocol;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};

use crate::allowlist::MediaAllowlist;
use crate::commands::{is_audio_extension, AppState};
use crate::db::LibraryDb;

const CLIENT_USER_AGENT: &str =
    "Cadence Player v0.2.1 (https://github.com/zprezvan03-cmyk/betterlyrics-standalone)";

fn extract_cli_audio_files(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter_map(|arg| {
            let path = PathBuf::from(arg);
            if is_audio_extension(&path) && path.is_file() {
                Some(path.to_string_lossy().into_owned())
            } else {
                None
            }
        })
        .collect()
}

fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn register_media_shortcuts<R: Runtime>(app: &AppHandle<R>) {
    let bindings = [
        (Code::MediaPlayPause, "toggle"),
        (Code::MediaTrackNext, "next"),
        (Code::MediaTrackPrevious, "previous"),
        (Code::MediaStop, "stop"),
    ];
    let manager = app.global_shortcut();
    for (code, command) in bindings {
        let shortcut = Shortcut::new(None, code);
        let cmd_name = command.to_string();
        let _ = manager.on_shortcut(shortcut, move |app_handle, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let _ = app_handle.emit("cadence://player-command", &cmd_name);
            }
        });
    }
}

#[cfg(target_os = "macos")]
fn setup_macos_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let add_folder = MenuItemBuilder::with_id("library:addFolder", "Add Music Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let rescan = MenuItemBuilder::with_id("library:rescan", "Rescan Library")
        .accelerator("CmdOrCtrl+Shift+R")
        .build(app)?;
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&add_folder)
        .item(&rescan)
        .separator()
        .quit()
        .build()?;

    let toggle = MenuItemBuilder::with_id("player:toggle", "Play / Pause")
        .accelerator("Space")
        .build(app)?;
    let next = MenuItemBuilder::with_id("player:next", "Next Track")
        .accelerator("CmdOrCtrl+Right")
        .build(app)?;
    let prev = MenuItemBuilder::with_id("player:previous", "Previous Track")
        .accelerator("CmdOrCtrl+Left")
        .build(app)?;
    let playback_menu = SubmenuBuilder::new(app, "Playback")
        .item(&toggle)
        .item(&next)
        .item(&prev)
        .build()?;

    let lyrics = MenuItemBuilder::with_id("view:lyrics", "Lyrics Fullscreen")
        .accelerator("F11")
        .build(app)?;
    let view_menu = SubmenuBuilder::new(app, "View").item(&lyrics).build()?;

    let menu = MenuBuilder::new(app)
        .items(&[&file_menu, &playback_menu, &view_menu])
        .build()?;
    app.set_menu(menu)?;

    app.on_menu_event(|app_handle, event| match event.id().as_ref() {
        "player:toggle" => {
            let _ = app_handle.emit("cadence://player-command", "toggle");
        }
        "player:next" => {
            let _ = app_handle.emit("cadence://player-command", "next");
        }
        "player:previous" => {
            let _ = app_handle.emit("cadence://player-command", "previous");
        }
        other => {
            let _ = app_handle.emit("cadence://menu-action", other);
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_argv: Vec<String> = std::env::args().collect();
    let initial_files = extract_cli_audio_files(&initial_argv);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            focus_main_window(app);
            let opened = extract_cli_audio_files(&argv);
            if !opened.is_empty() {
                if let Some(state) = app.try_state::<AppState>() {
                    for file in &opened {
                        state.allowlist.add_file(std::path::Path::new(file));
                    }
                }
                let _ = app.emit("cadence://open-files", opened);
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol("cadence-media", |ctx, request, responder| {
            let Some(state) = ctx.app_handle().try_state::<AppState>() else {
                responder.respond(
                    tauri::http::Response::builder()
                        .status(tauri::http::StatusCode::SERVICE_UNAVAILABLE)
                        .body(Vec::new())
                        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new())),
                );
                return;
            };
            protocol::handle_async_media_protocol(
                Arc::clone(&state.allowlist),
                request,
                responder,
            );
        })
        .setup(move |app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
            let artwork_dir = app_data_dir.join("artwork");
            std::fs::create_dir_all(&artwork_dir)?;

            let db_path = app_data_dir.join("library.db");
            let legacy_json_path = app_data_dir.join("library.json");
            let db = Arc::new(
                LibraryDb::open(&db_path, &legacy_json_path)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?,
            );

            let allowlist = Arc::new(MediaAllowlist::new(artwork_dir.clone()));
            if let Ok(snapshot) = db.load_snapshot() {
                allowlist.set_roots(snapshot.folders);
            }
            for file in &initial_files {
                allowlist.add_file(std::path::Path::new(file));
            }

            let http_client = reqwest::Client::builder()
                .user_agent(CLIENT_USER_AGENT)
                .build()
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;

            app.manage(AppState {
                app_data_dir,
                artwork_dir,
                allowlist,
                db,
                http_client,
                active_http_aborts: Mutex::new(HashMap::new()),
                pending_open_files: Mutex::new(initial_files),
            });

            #[cfg(target_os = "macos")]
            let _ = setup_macos_menu(app.handle());

            register_media_shortcuts(app.handle());

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::cmd_bootstrap,
            commands::cmd_allowlist_sync,
            commands::cmd_db_mutate,
            commands::cmd_load_lyrics,
            commands::cmd_write_user_json,
            commands::cmd_pick_folder,
            commands::cmd_pick_lyrics_file,
            commands::cmd_walk_folders,
            commands::cmd_stat_audio_files,
            commands::cmd_read_file_chunk,
            commands::cmd_save_artwork,
            commands::cmd_read_sidecar_text,
            commands::cmd_write_sidecar_lrc,
            commands::cmd_decode_delete_files,
            commands::cmd_decode_export_list,
            commands::cmd_http_fetch,
            commands::cmd_http_abort,
            commands::cmd_shell_show_in_folder,
            commands::cmd_shell_open_external,
            commands::cmd_window_action,
            commands::cmd_window_is_fullscreen,
            commands::cmd_window_chrome_state,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cadence Tauri application");
}
