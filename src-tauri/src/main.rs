// Prevents an extra console window on Windows in release builds — DO NOT REMOVE.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
fn configure_windows_app_identity() {
    // Must match `identifier` in tauri.conf.json. Tauri's installers put this AUMID on the
    // Cadence Start Menu shortcut, which lets Windows resolve SMTC's source to "Cadence".
    if let Err(error) = unsafe {
        windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(
            windows::core::w!("app.cadence.player"),
        )
    } {
        // Identity should not prevent playback if the shell rejects the assignment.
        eprintln!("[Cadence] Could not set Windows AppUserModelID: {error}");
    }
}

fn main() {
    // The shell requires this before any UI is presented or WebView2 creates its SMTC session.
    #[cfg(target_os = "windows")]
    configure_windows_app_identity();

    cadence_lib::run();
}
