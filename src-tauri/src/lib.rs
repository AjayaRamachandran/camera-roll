//! PhotoViewer Tauri application wiring.
//!
//! Module map:
//!   * `window_effects` — applies the native frosted-glass blur to the window.
//!   * `python_server`  — spawns and tears down the FastAPI sidecar process.
//!   * `commands`       — `invoke()`-able handlers exposed to the React frontend.
//!
//! `run()` is the single setup function the binary entry point (`main.rs`)
//! calls. It is deliberately small: each concern lives in its own module above.

mod acrylic_capture;
mod commands;
mod python_server;
mod window_effects;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::{Manager, RunEvent, WindowEvent};

use python_server::PythonServer;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The sidecar manager is shared application state so commands and the
        // exit handler can reach the same child process.
        .manage(PythonServer::default())
        .invoke_handler(tauri::generate_handler![
            commands::greet,
            commands::check_backend_health,
            commands::reveal_in_explorer,
            commands::pick_folder,
            commands::restart_backend,
        ])
        .setup(|app| {
            // 1. Frosted glass: apply the native OS blur to the main window.
            if let Some(window) = app.get_webview_window("main") {
                window_effects::apply_frost(&window);

                // Acrylic backplate: capture the desktop behind the window so the
                // liquid-glass material has real pixels to refract over the bare
                // acrylic. `dirty` is flipped on move/resize so the capture
                // re-registers immediately and the backplate feels live.
                let dirty = Arc::new(AtomicBool::new(true));
                window.on_window_event({
                    let dirty = dirty.clone();
                    move |event| {
                        if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                            dirty.store(true, Ordering::Relaxed);
                        }
                    }
                });
                acrylic_capture::start(window.clone(), dirty);
            }

            // 2. Backend: boot the Python/FastAPI sidecar. A failure to spawn is
            //    logged but non-fatal — the UI still runs, just shows "offline".
            let handle = app.handle().clone();
            if let Err(e) = app.state::<PythonServer>().start(&handle) {
                eprintln!("[setup] failed to start Python server: {e}");
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Make sure we don't leave an orphaned Python process behind.
            if let RunEvent::Exit = event {
                app_handle.state::<PythonServer>().stop();
            }
        });
}
