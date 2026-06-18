//! Native, OS-accelerated frosted-glass background.
//!
//! This module is the heart of the "blurred cutout of the current screen"
//! requirement. Rather than capturing the screen and blurring pixels ourselves
//! (slow, and would need a library like OpenCV), we ask the operating system's
//! compositor to do it. On Windows that is **Acrylic** (DWM), applied via the
//! `window-vibrancy` crate — a thin, Rust-native binding over the OS APIs.
//!
//! The result: whatever is physically behind the window is blurred and tinted
//! in real time by the GPU/compositor, with effectively zero cost to us. The
//! webview is kept fully transparent (see global.css) so the blur shows through,
//! and a CSS noise layer adds dithering on top to hide banding.

use tauri::WebviewWindow;

/// Apply the frosted-glass effect to a window. Safe to call once per window,
/// right after it is created. Failures are logged but never fatal — the app
/// still runs, just without the blur (e.g. on an unsupported OS build).
pub fn apply_frost(window: &WebviewWindow) {
    #[cfg(target_os = "windows")]
    {
        use window_vibrancy::{apply_acrylic, apply_blur};

        // IMPORTANT: we pass `None` (no tint) on purpose. On Windows 11 the OS
        // compositor ignores the acrylic tint color anyway, so the base/tint of
        // the frosted glass is applied in CSS instead, where we have full
        // control over color and opacity. See `.frosted-tint` in frosted.css.
        // Rust's only job here is to turn on the native blur.
        const TINT: Option<(u8, u8, u8, u8)> = None;

        // Acrylic is the richer effect (blurs the *desktop* behind the window).
        // If it is unavailable on this Windows build, fall back to the simpler
        // Aero "blur behind" so we still get a frosted look.
        if let Err(acrylic_err) = apply_acrylic(window, TINT) {
            eprintln!("[window_effects] acrylic unavailable ({acrylic_err}); trying blur");
            if let Err(blur_err) = apply_blur(window, TINT) {
                eprintln!("[window_effects] blur also unavailable: {blur_err}");
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
        if let Err(e) = apply_vibrancy(
            window,
            NSVisualEffectMaterial::HudWindow,
            None,
            None,
        ) {
            eprintln!("[window_effects] macOS vibrancy unavailable: {e}");
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        // Linux: blur depends on the compositor (e.g. KWin/picom) and has no
        // portable API. The window stays transparent; the dither layer still
        // renders. Nothing to do here.
        let _ = window;
    }
}
