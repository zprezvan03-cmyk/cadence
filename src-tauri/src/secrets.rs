//! Operating-system credential store for secrets Cadence must never persist in ordinary JSON
//! settings (currently: the optional connected Google account's cookie for YouTube Music).
//!
//! Backends, per platform:
//!   - Windows: DPAPI (`CryptProtectData` / `CryptUnprotectData`), scoped to the current user.
//!     The protected blob is kept in a file under the app data dir, keyed by account name.
//!   - Linux:   Secret Service via the `secret-tool` CLI (libsecret; GNOME Keyring / KWallet).
//!   - macOS:   the login Keychain via the `security` CLI.
//!
//! If no backend is available the commands return a clear error and the renderer keeps Guest
//! mode fully functional; connecting an account is simply reported as unavailable.
//!
//! The stored value is only ever returned to the renderer so it can be attached as a verbatim
//! `Cookie` header to `music.youtube.com` InnerTube requests. It is never logged, never written
//! to settings/db, and never sent to any other host.

use serde::Deserialize;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::State;

use crate::commands::AppState;

/// Only this service name is accepted, so stored secrets can never collide with other apps.
pub const SECRET_SERVICE: &str = "cadence";
const MAX_SECRET_LEN: usize = 8 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStoreArgs {
    pub service: String,
    pub account: String,
    pub secret: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretGetArgs {
    pub service: String,
    pub account: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretDeleteArgs {
    pub service: String,
    pub account: String,
}

fn validate(service: &str, account: &str) -> Result<(), String> {
    if service != SECRET_SERVICE {
        return Err("Unknown secret service".to_string());
    }
    let valid = !account.is_empty()
        && account.len() <= 64
        && account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-');
    if !valid {
        return Err("Invalid account name".to_string());
    }
    Ok(())
}

fn validate_secret(secret: &str) -> Result<(), String> {
    if secret.is_empty() || secret.len() > MAX_SECRET_LEN {
        return Err("Secret length out of bounds".to_string());
    }
    if secret.bytes().any(|b| b == 0) {
        return Err("Secret contains NUL bytes".to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_secret_store(args: SecretStoreArgs, state: State<'_, AppState>) -> Result<(), String> {
    validate(&args.service, &args.account)?;
    validate_secret(&args.secret)?;
    store_secret(&state.app_data_dir, &args.account, &args.secret)
}

#[tauri::command]
pub fn cmd_secret_get(args: SecretGetArgs, state: State<'_, AppState>) -> Result<Option<String>, String> {
    validate(&args.service, &args.account)?;
    get_secret(&state.app_data_dir, &args.account)
}

#[tauri::command]
pub fn cmd_secret_delete(args: SecretDeleteArgs, state: State<'_, AppState>) -> Result<bool, String> {
    validate(&args.service, &args.account)?;
    delete_secret(&state.app_data_dir, &args.account)
}

/* ---------------------------------------------------------------- Windows (DPAPI) */

#[cfg(target_os = "windows")]
fn blob_path(app_data_dir: &std::path::Path, account: &str) -> PathBuf {
    app_data_dir.join("secrets").join(format!("{account}.dpapi"))
}

#[cfg(target_os = "windows")]
fn store_secret(app_data_dir: &std::path::Path, account: &str, secret: &str) -> Result<(), String> {
    use base64::Engine;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: secret.len() as u32,
        pbData: secret.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input` borrows `secret`, which outlives the call; `output` is allocated by the API
    // and released with LocalFree below.
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("DPAPI protect failed: {e}"))?;
    }
    if output.cbData == 0 || output.pbData.is_null() {
        return Err("DPAPI returned an empty blob".to_string());
    }
    // SAFETY: cbData bytes at pbData are valid for the blob's lifetime.
    let slice = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) };
    let encoded = base64::engine::general_purpose::STANDARD.encode(slice);
    unsafe { LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void))) };

    let path = blob_path(app_data_dir, account);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, encoded).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn get_secret(app_data_dir: &std::path::Path, account: &str) -> Result<Option<String>, String> {
    use base64::Engine;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let encoded = match std::fs::read_to_string(blob_path(app_data_dir, account)) {
        Ok(value) => value.trim().to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let blob = base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| "Stored secret is not valid base64".to_string())?;
    let mut input = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: `input` borrows `blob` for the call; `output` is released with LocalFree below.
    unsafe {
        CryptUnprotectData(&input, None, None, None, None, 0, &mut output)
            .map_err(|e| format!("DPAPI unprotect failed: {e}"))?;
    }
    if output.cbData == 0 || output.pbData.is_null() {
        return Ok(None);
    }
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    unsafe { LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void))) };
    let _ = PCWSTR::null;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "Stored secret is not valid UTF-8".to_string())
}

#[cfg(target_os = "windows")]
fn delete_secret(app_data_dir: &std::path::Path, account: &str) -> Result<bool, String> {
    match std::fs::remove_file(blob_path(app_data_dir, account)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/* ---------------------------------------------------------------- macOS (Keychain) */

#[cfg(target_os = "macos")]
fn store_secret(_app_data_dir: &std::path::Path, account: &str, secret: &str) -> Result<(), String> {
    let status = Command::new("security")
        .args(["add-generic-password", "-s", SECRET_SERVICE, "-a", account, "-w", secret, "-U"])
        .status()
        .map_err(|e| format!("Keychain unavailable: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Keychain refused to store the secret".to_string())
    }
}

#[cfg(target_os = "macos")]
fn get_secret(_app_data_dir: &std::path::Path, account: &str) -> Result<Option<String>, String> {
    let output = Command::new("security")
        .args(["find-generic-password", "-s", SECRET_SERVICE, "-a", account, "-w"])
        .output()
        .map_err(|e| format!("Keychain unavailable: {e}"))?;
    if output.status.success() {
        return Ok(Some(String::from_utf8_lossy(&output.stdout).trim_end().to_string()));
    }
    Ok(None)
}

#[cfg(target_os = "macos")]
fn delete_secret(_app_data_dir: &std::path::Path, account: &str) -> Result<bool, String> {
    let output = Command::new("security")
        .args(["delete-generic-password", "-s", SECRET_SERVICE, "-a", account])
        .output()
        .map_err(|e| format!("Keychain unavailable: {e}"))?;
    Ok(output.status.success())
}

/* ---------------------------------------------------------------- Linux (Secret Service) */

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn store_secret(_app_data_dir: &std::path::Path, account: &str, secret: &str) -> Result<(), String> {
    let mut child = Command::new("secret-tool")
        .args(["store", "--label=Cadence YouTube Music", "service", SECRET_SERVICE, "account", account])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Secret Service unavailable (secret-tool): {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("secret-tool stdin missing")?
        .write_all(secret.as_bytes())
        .map_err(|e| e.to_string())?;
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Secret Service refused to store the secret: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn get_secret(_app_data_dir: &std::path::Path, account: &str) -> Result<Option<String>, String> {
    let output = Command::new("secret-tool")
        .args(["lookup", "service", SECRET_SERVICE, "account", account])
        .output()
        .map_err(|e| format!("Secret Service unavailable (secret-tool): {e}"))?;
    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim_end().to_string();
        return Ok(if value.is_empty() { None } else { Some(value) });
    }
    Ok(None)
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn delete_secret(_app_data_dir: &std::path::Path, account: &str) -> Result<bool, String> {
    let output = Command::new("secret-tool")
        .args(["clear", "service", SECRET_SERVICE, "account", account])
        .output()
        .map_err(|e| format!("Secret Service unavailable (secret-tool): {e}"))?;
    // secret-tool exits 0 when at least one item was cleared, 1 when none matched.
    Ok(output.status.success())
}
