//! `#[tauri::command]` handlers callable from the frontend via `invoke()`.
//!
//! These are the typed seam between React and the rest of the backend. The
//! health proxy is the canonical example of the full data path:
//!   React → invoke → (this) Rust command → reqwest → Python FastAPI → OpenCV

use serde::{Deserialize, Serialize};

use crate::python_server;

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
