//! Acrylic backplate capture.
//!
//! Why this exists: the liquid-glass material (`Refract` on the frontend) refracts
//! and blurs its *backdrop*. But on Windows the window's acrylic surface is
//! composited by the OS *behind* the transparent WebView, so it is not part of
//! the web document — `backdrop-filter` and the SVG displacement map have no
//! pixels to operate on there, which produces a "ghosting" seam. See
//! `docs/liquid-glass-acrylic.md` for the full write-up.
//!
//! The fix: roughly once a second, grab a small screenshot of the desktop that
//! sits *behind* our window (that is the same content the OS acrylic is blurring)
//! and ship it to the WebView, which paints it — clipped to the glass shapes —
//! as a real backdrop the filter can sample.
//!
//! Two Windows-specific tricks make this work:
//!   * To capture what is *behind* our (transparent) window rather than the
//!     window itself, we set `WDA_EXCLUDEFROMCAPTURE` on the window for the
//!     duration of the blit, so DWM composites the capture as if we weren't
//!     there. We toggle it **only** around each grab (a single composition, via
//!     `DwmFlush`), so the window is excluded from the user's own screenshots
//!     for ~16 ms per second rather than continuously.
//!   * The blit is a `StretchBlt` straight into a small bitmap, so downsampling
//!     happens in GDI — no manual pixel resizing, no `image` crate.

#[cfg(windows)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(windows)]
use std::sync::Arc;

#[cfg(windows)]
use tauri::{Emitter, Manager, WebviewWindow};

/// Tauri event name the downsampled acrylic frames are emitted on. The frontend
/// (`AcrylicMatteContext`) listens for this and updates the backplate image.
#[cfg(windows)]
pub const FRAME_EVENT: &str = "acrylic-frame";

/// Longest target edge of the downsampled capture, in pixels. The image is only
/// ever shown heavily blurred/refracted under glass, so this can be tiny.
#[cfg(windows)]
const MAX_EDGE: i32 = 384;

/// Idle refresh interval. The acrylic is low-frequency, so 1 Hz is plenty.
#[cfg(windows)]
const REFRESH_MS: u128 = 1000;

/// Poll granularity. The loop wakes this often to check the `dirty` flag (set on
/// window move/resize) so a moved window re-registers quickly, then falls back to
/// the slow `REFRESH_MS` cadence when idle.
#[cfg(windows)]
const TICK_MS: u64 = 80;

/// Payload sent to the frontend per frame.
#[cfg(windows)]
#[derive(Clone, serde::Serialize)]
struct FramePayload {
    /// `data:image/jpeg;base64,...` URI of the downsampled desktop-behind-window.
    uri: String,
}

/// Start the capture loop on a background thread.
///
/// `dirty` is shared with the window-event handler in `lib.rs`: it is set to
/// `true` on move/resize so the next tick recaptures immediately (keeping the
/// backplate registered with the live acrylic) instead of waiting out the full
/// refresh interval.
#[cfg(windows)]
pub fn start(window: WebviewWindow, dirty: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        use std::time::Instant;
        let mut last = Instant::now()
            .checked_sub(std::time::Duration::from_millis(REFRESH_MS as u64))
            .unwrap_or_else(Instant::now);

        loop {
            std::thread::sleep(std::time::Duration::from_millis(TICK_MS));

            // Stop the thread if the window is gone.
            if window.app_handle().get_webview_window(window.label()).is_none() {
                return;
            }

            let forced = dirty.swap(false, Ordering::Relaxed);
            if !forced && last.elapsed().as_millis() < REFRESH_MS {
                continue;
            }
            last = Instant::now();

            // Don't bother while minimized; nothing to refract.
            if matches!(window.is_minimized(), Ok(true)) {
                continue;
            }

            if let Some(uri) = capture_once(&window) {
                let _ = window.emit(FRAME_EVENT, FramePayload { uri });
            }
        }
    });
}

/// No-op on non-Windows targets (the acrylic problem is Windows-specific; on
/// macOS the vibrancy material is sampled correctly by the compositor).
#[cfg(not(windows))]
pub fn start(_window: tauri::WebviewWindow, _dirty: std::sync::Arc<std::sync::atomic::AtomicBool>) {}

/// Grab one downsampled frame of the desktop behind the window and return it as
/// a base64 JPEG data URI. Returns `None` on any failure (geometry unavailable,
/// off-screen, GDI error) — a dropped frame is harmless.
#[cfg(windows)]
fn capture_once(window: &WebviewWindow) -> Option<String> {
    use base64::Engine;
    use jpeg_encoder::{ColorType, Encoder};
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::DwmFlush;
    use windows_sys::Win32::Graphics::Gdi::{
        CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
        ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER,
        BI_RGB, DIB_RGB_COLORS, HGDIOBJ, SRCCOPY, STRETCH_HALFTONE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    // --- source rectangle: the window's client area, in physical screen px ---
    let pos = window.inner_position().ok()?;
    let size = window.inner_size().ok()?;
    let src_w = size.width as i32;
    let src_h = size.height as i32;
    if src_w < 2 || src_h < 2 {
        return None;
    }
    let src_x = pos.x;
    let src_y = pos.y;

    // --- destination size: downsample so the longest edge is <= MAX_EDGE ---
    let longest = src_w.max(src_h);
    let (dst_w, dst_h) = if longest <= MAX_EDGE {
        (src_w, src_h)
    } else {
        let s = MAX_EDGE as f64 / longest as f64;
        (
            ((src_w as f64 * s).round() as i32).max(2),
            ((src_h as f64 * s).round() as i32).max(2),
        )
    };

    // Robust against version skew between tauri's `windows` HWND and ours:
    // round-trip through isize whether `.0` is a pointer or an integer.
    let raw = window.hwnd().ok()?;
    let hwnd: HWND = (raw.0 as isize) as *mut c_void;

    unsafe {
        let screen_dc = GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return None;
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        let bmp = CreateCompatibleBitmap(screen_dc, dst_w, dst_h);
        if mem_dc.is_null() || bmp.is_null() {
            if !bmp.is_null() {
                DeleteObject(bmp as HGDIOBJ);
            }
            if !mem_dc.is_null() {
                DeleteDC(mem_dc);
            }
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return None;
        }
        let old = SelectObject(mem_dc, bmp as HGDIOBJ);
        SetStretchBltMode(mem_dc, STRETCH_HALFTONE);

        // Exclude ourselves from capture for exactly one composition, blit the
        // now-revealed desktop behind us, then restore normal capture.
        SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
        DwmFlush();
        let ok = StretchBlt(
            mem_dc, 0, 0, dst_w, dst_h, screen_dc, src_x, src_y, src_w, src_h, SRCCOPY,
        );
        SetWindowDisplayAffinity(hwnd, WDA_NONE);

        if ok == 0 {
            SelectObject(mem_dc, old);
            DeleteObject(bmp as HGDIOBJ);
            DeleteDC(mem_dc);
            ReleaseDC(std::ptr::null_mut(), screen_dc);
            return None;
        }

        // Read the pixels back as a top-down 32-bit DIB (BGRA). The bitmap must
        // not be selected into a DC during GetDIBits, so deselect it first.
        SelectObject(mem_dc, old);

        let mut bi: BITMAPINFO = std::mem::zeroed();
        bi.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: dst_w,
            biHeight: -dst_h, // negative => top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        };

        let mut buf = vec![0u8; (dst_w * dst_h * 4) as usize];
        let lines = GetDIBits(
            mem_dc,
            bmp,
            0,
            dst_h as u32,
            buf.as_mut_ptr() as *mut c_void,
            &mut bi,
            DIB_RGB_COLORS,
        );

        DeleteObject(bmp as HGDIOBJ);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);

        if lines == 0 {
            return None;
        }

        // Encode straight from BGRA — no channel reshuffle needed.
        let mut jpeg: Vec<u8> = Vec::new();
        let encoder = Encoder::new(&mut jpeg, 70);
        encoder
            .encode(&buf, dst_w as u16, dst_h as u16, ColorType::Bgra)
            .ok()?;

        let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
        Some(format!("data:image/jpeg;base64,{b64}"))
    }
}
