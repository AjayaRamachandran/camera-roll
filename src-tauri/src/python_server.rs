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

        let launch = resolve_launch(app);

        eprintln!(
            "[python_server] launching: {} {} (cwd: {})",
            launch.program.display(),
            launch.args.join(" "),
            launch.workdir.display()
        );

        let mut cmd = Command::new(&launch.program);
        cmd.args(&launch.args)
            .current_dir(&launch.workdir)
            // Pass the port through the environment so main.py and Rust never
            // disagree about where the server lives.
            .env("PHOTOVIEWER_PORT", PORT.to_string());

        // In a packaged (release) build the sidecar is a windowed executable and
        // the image workers it spawns re-launch it, so suppress any console
        // window from flashing. Debug keeps the console for the Python logs.
        #[cfg(all(windows, not(debug_assertions)))]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let child = cmd.spawn()?;

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

/// How to launch the sidecar: the program, its arguments, and the working dir.
struct Launch {
    program: PathBuf,
    args: Vec<String>,
    workdir: PathBuf,
}

/// Decide how to start the Python sidecar.
///   * Debug builds run `python main.py` from the source tree (preferring the
///     project virtualenv), so the dev loop needs no freezing step.
///   * Release builds run the self-contained executable produced by PyInstaller
///     and bundled under the resource dir, so the user needs no Python install.
fn resolve_launch(app: &AppHandle) -> Launch {
    if cfg!(debug_assertions) {
        // <repo>/src-tauri/.. -> <repo>/server
        let server_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("server");
        let python = resolve_python(&server_dir);
        let script = server_dir.join("main.py");
        Launch {
            program: python,
            args: vec![script.to_string_lossy().into_owned()],
            workdir: server_dir,
        }
    } else {
        let exe = resolve_frozen_exe(app);
        let workdir = exe
            .parent()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        Launch {
            program: exe,
            args: vec![],
            workdir,
        }
    }
}

/// Locate the frozen sidecar executable inside the bundled resources.
///
/// tauri.conf.json ships the PyInstaller onedir output under `server-bin`, so
/// the executable normally sits at `<resources>/server-bin/camera-roll-server.exe`.
/// We also accept the nested layout some bundlers produce as a fallback.
fn resolve_frozen_exe(app: &AppHandle) -> PathBuf {
    let exe_name = if cfg!(target_os = "windows") {
        "camera-roll-server.exe"
    } else {
        "camera-roll-server"
    };
    let base = app
        .path()
        .resource_dir()
        .map(|r| r.join("server-bin"))
        .unwrap_or_else(|_| PathBuf::from("server-bin"));

    let direct = base.join(exe_name);
    if direct.exists() {
        return direct;
    }
    let nested = base.join("camera-roll-server").join(exe_name);
    if nested.exists() {
        return nested;
    }
    // Fall back to the expected path even if the probe failed, so the spawn
    // error names a real location instead of silently doing nothing.
    direct
}

/// Prefer a project virtualenv interpreter if present, otherwise fall back to
/// whatever `python` is on PATH. Used only by the debug (source-tree) launch.
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
