//! `#[tauri::command]` handlers callable from the frontend via `invoke()`.
//!
//! These are the typed seam between React and the rest of the backend. The
//! health proxy is the canonical example of the full data path:
//!   React → invoke → (this) Rust command → reqwest → Python FastAPI → OpenCV

use serde::{Deserialize, Serialize};

use crate::python_server;
use crate::python_server::PythonServer;

/// Shape of the Python server's `/health` JSON, relayed verbatim to the
/// frontend. Mirrors `BackendHealth` in src/lib/api.ts.
#[derive(Debug, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub python_version: String,
    /// Number of photos currently in the index.
    pub indexed: u64,
}

/// Trivial example command — handy for confirming the invoke bridge works.
#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {name}! The Rust backend is alive.")
}

/// Open the OS file explorer with the given file selected/highlighted.
///
/// Kept Rust-native rather than pulling in a plugin: on Windows we shell out to
/// `explorer /select,<path>`, which both opens the containing folder and selects
/// the file. Other platforms get their native equivalent.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        // Explorer only highlights the file when the path uses backslashes; a
        // forward-slash path is silently ignored and it falls back to a default
        // folder. Canonicalize so relative/odd paths resolve, then swap `/`→`\`.
        // (`canonicalize` yields a `\\?\` verbatim prefix, which Explorer rejects,
        // so strip it.)
        let resolved = std::fs::canonicalize(&path).unwrap_or_else(|_| path.clone().into());
        let native = resolved
            .to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('/', "\\");

        // Use `raw_arg` so the `/select,<path>` token reaches Explorer verbatim:
        // Rust's normal quoting would wrap the whole thing and break the switch.
        use std::os::windows::process::CommandExt;
        // `explorer` returns exit code 1 even on success, so we don't check status.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{native}\""))
            .spawn()
            .map_err(|e| format!("could not open explorer: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| format!("could not open Finder: {e}"))?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // No portable "select file" on Linux; open the containing directory.
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from(&path));
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("could not open file manager: {e}"))?;
    }
    Ok(())
}

/// Open a native folder picker and return the chosen path (None if cancelled).
///
/// Kept Rust-native via `rfd` (a thin Win32 wrapper) rather than pulling in the
/// Tauri dialog plugin and its JS/capability wiring, matching `reveal_in_explorer`.
#[tauri::command]
pub async fn pick_folder(title: String) -> Option<String> {
    let mut dialog = rfd::AsyncFileDialog::new();
    if !title.is_empty() {
        dialog = dialog.set_title(&title);
    }
    dialog
        .pick_folder()
        .await
        .map(|handle| handle.path().to_string_lossy().to_string())
}

/// Restart the Python sidecar so it rebinds to the now-current library.
///
/// Library paths are bound at process startup, so switching or adding a library
/// (which only writes the registry) takes effect after this restart. The
/// frontend then reloads to pick up the new library's index.
#[tauri::command]
pub async fn restart_backend(
    app: tauri::AppHandle,
    server: tauri::State<'_, PythonServer>,
) -> Result<(), String> {
    server
        .restart(&app)
        .map_err(|e| format!("could not restart backend: {e}"))
}

/// Ask the Python sidecar for its health status and relay it.
///
/// Returns `Err(String)` (which surfaces as a rejected Promise on the JS side)
/// if the server is not reachable yet — e.g. during the second or two it takes
/// to boot, or if the Python deps were never installed.
#[tauri::command]
pub async fn check_backend_health() -> Result<HealthResponse, String> {
    let url = format!("{}/health", python_server::base_url());

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
        .map_err(|e| format!("could not reach Python server at {url}: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Python server returned HTTP {}", resp.status()));
    }

    resp.json::<HealthResponse>()
        .await
        .map_err(|e| format!("invalid health payload: {e}"))
}
