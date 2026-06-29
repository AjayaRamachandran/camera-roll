import { invoke } from "@tauri-apps/api/core";

/**
 * Typed wrappers around the Rust `#[tauri::command]` handlers.
 *
 * Keeping every `invoke()` call in this one module means the rest of the React
 * app never sees raw command-name strings, and the request/response shapes live
 * in a single place that mirrors `src-tauri/src/commands.rs`.
 */

/** Mirrors the `HealthResponse` struct returned by the Rust health proxy. */
export interface BackendHealth {
  status: string;
  /** Python interpreter version string. */
  python_version: string;
  /** Number of photos currently in the index. */
  indexed: number;
}

/**
 * Ask the Rust backend to call the Python (FastAPI) server's `/health` endpoint
 * and relay the result. This exercises the full chain:
 *   React → Tauri invoke → Rust (reqwest) → Python FastAPI → OpenCV
 */
export async function checkBackendHealth(): Promise<BackendHealth> {
  return invoke<BackendHealth>("check_backend_health");
}

/** Trivial example command, handy for sanity-checking the invoke bridge. */
export async function greet(name: string): Promise<string> {
  return invoke<string>("greet", { name });
}

/** Open the OS file explorer with the given file selected/highlighted. */
export async function revealInExplorer(path: string): Promise<void> {
  return invoke<void>("reveal_in_explorer", { path });
}

/**
 * Open a native folder picker. Returns the chosen path, or null if the user
 * cancels. `title` sets the dialog's window title.
 */
export async function pickFolder(title: string): Promise<string | null> {
  return invoke<string | null>("pick_folder", { title });
}

/**
 * Restart the Python sidecar so it rebinds to the now-current library. Call
 * this after switching or adding a library, then reload the window to pick up
 * the new library's index.
 */
export async function restartBackend(): Promise<void> {
  return invoke<void>("restart_backend");
}
