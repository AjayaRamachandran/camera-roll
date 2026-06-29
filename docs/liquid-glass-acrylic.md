# Liquid glass over Windows acrylic: the "ghosting" problem

This documents a structural limitation of the liquid-glass material (`Refract`)
on Windows, and the proposed approach for solving it. Read this before changing
anything about how `Refract` samples its backdrop.

## The problem

The liquid-glass effect works by sampling the **backdrop** of an element: CSS
`backdrop-filter` (blur) and the SVG `feDisplacementMap` (refraction) both read
the pixels that sit behind the glass element and transform them.

On Windows, the app window uses an **acrylic** surface: a blurred, tinted view
of whatever is behind the window. Crucially, that acrylic is composited by the
**operating system**, *behind* the transparent WebView. It is not part of the
web document, and it is not in any compositing layer the browser engine can see.

The consequence:

- Where a glass element sits over **actual DOM content**, there are real pixels
  to sample, so blur and displacement work.
- Where a glass element sits over **bare acrylic** (a region of the window with
  no DOM painted on it), the backdrop the filter sees is **empty/transparent**.
  There is nothing to blur and nothing to displace.

So any glass element that straddles the boundary — part over DOM, part over bare
acrylic — only gets the effect on the DOM portion. The acrylic portion is left
untouched. Instead of a clean refraction you get a **"ghosting"** seam: the
material clearly does something on one side and nothing on the other, which hurts
legibility and reads as unfinished.

No amount of tuning the blur radius, the displacement scale, or the displacement
map fixes this, because the issue is not the effect math — it is that **the
effect has no input pixels to operate on** over the acrylic.

## Proposed solution: a captured acrylic backplate

Give the filter something real to sample over the acrylic regions by feeding it
a screenshot of the acrylic surface.

1. **Capture.** On a slow cadence (~1 Hz), take a **downsampled** snapshot of the
   bare acrylic surface (the window's backdrop with no DOM chrome on it) and keep
   it in memory. It is heavily blurred content, so low resolution and a low
   refresh rate are fine and cheap.

2. **Place it underneath.** Render that snapshot as a layer **below everything
   else in the DOM**, registered to the window so it lines up with the real
   acrylic.

3. **Clip it to the glass.** Mask/clip the snapshot layer to the **union of all
   liquid-glass element shapes** (their "matte" — the rounded-rect footprints of
   every `Refract` instance). The snapshot is therefore only present directly
   beneath glass elements; everywhere else the real OS acrylic shows through
   untouched.

Net effect: beneath any glass element, the "acrylic" is now actual DOM pixels (a
screenshot), so `backdrop-filter` blur and `feDisplacementMap` refraction have
something to work on and behave the same as they do over real content. Outside
the glass, nothing changes — the live OS acrylic is still shown.

## Why this is sound

The acrylic is already a low-frequency, blurred image, so a stale, downsampled
copy is visually indistinguishable from the live surface once it is blurred and
refracted again by the glass. Clipping to the glass matte keeps the snapshot from
ever covering the genuine acrylic where no glass is present, so there is no cost
to the rest of the window.

## How it is implemented

**Rust (`src-tauri/src/acrylic_capture.rs`)**

- A background thread captures the desktop region behind the window's client
  area roughly once a second (and immediately after a move/resize, signalled by a
  `dirty` flag set from the window-event handler in `lib.rs`).
- The grab is a GDI `StretchBlt` straight into a small bitmap, so downsampling
  (longest edge clamped to `MAX_EDGE`) happens in GDI — no `image` crate, no
  manual resize. The result is JPEG-encoded (`jpeg-encoder`), base64'd, and
  emitted to the WebView on the `acrylic-frame` event as a `data:` URI.
- To capture what is *behind* our transparent window rather than the window
  itself, `WDA_EXCLUDEFROMCAPTURE` is set on the window **only** around each
  blit, with a single `DwmFlush` to force one composition before the grab, then
  cleared. So the window is excluded from any screen capture for ~one frame
  (~16 ms) per second instead of continuously — the user's own screenshots only
  catch a blank window if taken inside that brief window.

**Frontend (`src/components/AcrylicMatte.tsx`)**

- `AcrylicMatteProvider` (mounted at the app root in `App.tsx`) listens for
  `acrylic-frame` and paints the latest frame as a `position: fixed` layer at the
  very bottom of `#root` (below `frosted-tint`/`dither`), so the glass
  `backdrop-filter` samples it.
- The layer is clipped via an SVG `<clipPath clipPathUnits="userSpaceOnUse">` to
  the union of every glass element's rounded-rect footprint. Each `<Refract>`
  registers/updates its footprint (`useAcrylicMatte().setShape`) from the same
  `ResizeObserver` regen it already runs, and removes it on unmount. Rects are
  inflated by `INFLATE` px so the glass's own blur does not sample transparent
  past the matte edge and halo. With no glass on screen the clip is empty, so the
  backplate is invisible and the live OS acrylic shows everywhere.

## Notes / things to watch

- **Verify on first run** that the backplate does *not* contain our own window
  (i.e. that the GDI screen DC honors `WDA_EXCLUDEFROMCAPTURE`). If it does not,
  the fallback is Windows.Graphics.Capture, which definitely honors it.
- Multi-monitor: the blit uses the window's physical position directly against
  the screen DC; negative virtual-desktop coordinates should work but are worth a
  look on a second monitor.
- The capture is downsampled and ~1 Hz, so it is deliberately low-detail; this is
  fine because it is only ever shown blurred/refracted under glass.
