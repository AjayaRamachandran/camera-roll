//! Lifecycle manager for the Python (FastAPI) sidecar process.
//!
//! Responsibilities:
//!   * Locate the server script and the right Python interpreter (preferring a
//!     project virtualenv if one exists).
//!   * Spawn `python main.py`, which boots a uvicorn server on a fixed port.
//!   * Keep the child handle so we can terminate it cleanly when the app exits.
//!
//! The Rust side never imports OpenCV or does image work itself — it only owns
//! the process and proxies HTTP requests to it (see commands.rs).

use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

/// Loopback port the FastAPI server listens on. Kept in one place so both the
/// spawner and the HTTP proxy (commands.rs) agree. Uncommon to avoid clashes.
pub const PORT: u16 = 8756;

/// Base URL used by the Rust HTTP proxy to reach the Python server.
pub fn base_url() -> String {
    format!("http://127.0.0.1:{PORT}")
}

/// Tauri-managed state holding the running child process (if any).
#[derive(Default)]
pub struct PythonServer {
    child: Mutex<Option<Child>>,
}

impl PythonServer {
    /// Spawn the FastAPI server as a child process. Idempotent-ish: if a child
    /// is already tracked, this does nothing.
    pub fn start(&self, app: &AppHandle) -> std::io::Result<()> {
        let mut guard = self.child.lock().expect("python child mutex poisoned");
        if guard.is_some() {
            return Ok(());
        }

        let server_dir = resolve_server_dir(app);
        let script = server_dir.join("main.py");
        let python = resolve_python(&server_dir);

        eprintln!(
            "[python_server] launching: {} {} (cwd: {})",
            python.display(),
            script.display(),
            server_dir.display()
        );

        let child = Command::new(&python)
            .arg(&script)
            .current_dir(&server_dir)
            // Pass the port through the environment so main.py and Rust never
            // disagree about where the server lives.
            .env("PHOTOVIEWER_PORT", PORT.to_string())
            .spawn()?;

        *guard = Some(child);
        Ok(())
    }

    /// Stop the running sidecar and start a fresh one. Used when the active
    /// library changes: every path is bound at process startup, so a clean
    /// restart is the simplest, most robust way to rebind to the new library.
    pub fn restart(&self, app: &AppHandle) -> std::io::Result<()> {
        self.stop();
        self.start(app)
    }

    /// Terminate the child process if it is still running. Called on app exit.
    pub fn stop(&self) {
        if let Ok(mut guard) = self.child.lock() {
            if let Some(mut child) = guard.take() {
                eprintln!("[python_server] stopping sidecar (pid {})", child.id());
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Figure out where the `server/` directory lives.
///   * Debug builds run from the source tree, so we walk up from the crate dir.
///   * Release builds read it from the bundled resource directory.
fn resolve_server_dir(app: &AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        // <repo>/src-tauri/.. -> <repo>/server
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("server")
    } else {
        // Resources are bundled relative to the resource dir; `main.py` was
        // listed under `../server/...` in tauri.conf.json, so it lands here.
        app.path()
            .resource_dir()
            .map(|r| r.join("server"))
            .unwrap_or_else(|_| PathBuf::from("server"))
    }
}

/// Prefer a project virtualenv interpreter if present, otherwise fall back to
/// whatever `python` is on PATH.
fn resolve_python(server_dir: &PathBuf) -> PathBuf {
    #[cfg(target_os = "windows")]
    let venv = server_dir.join(".venv").join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let venv = server_dir.join(".venv").join("bin").join("python");

    if venv.exists() {
        venv
    } else {
        // `python` on Windows, `python3` elsewhere is the safer default.
        #[cfg(target_os = "windows")]
        {
            PathBuf::from("python")
        }
        #[cfg(not(target_os = "windows"))]
        {
            PathBuf::from("python3")
        }
    }
}
