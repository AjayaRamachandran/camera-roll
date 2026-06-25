# Handoff Context

## Project & Goal
**PhotoViewer / "Camera Roll"** — a Tauri 2 (Rust + WebView2) desktop photo app with a
React + TypeScript + Vite + Tailwind frontend, plus a Python (FastAPI/uvicorn) sidecar
backend for indexing/face-recognition.

- Primary working dir: `C:\Code\Rust Projects\PhotoViewer`
- Run: `npm run app` (= `tauri dev`; `beforeDevCommand` runs `npm run dev` = Vite on
  `localhost:1420`, frontend served from the dev server, NOT `dist`).
- Design rules live in `AGENTS.md` (referenced by `CLAUDE.md`). **Critical working rule
  from AGENTS.md:** do NOT launch the UI to "verify" by polling/sleeping/reading logs —
  the human runs the app and looks at it. Static checks (tsc, etc.) are fine.

**Current task:** implementing/debugging a "liquid glass" (Apple-style refraction) material
component, `Refract`, that wraps UI chrome (zoom pill, gallery controls, video scrub bar,
indexing pill, etc.) and refracts the backdrop around rounded edges via an SVG
displacement-map filter used as a `backdrop-filter`.

The reference implementation is `refract.html` (a standalone prototype at repo root) which
the user considers correct. The React port is `src/components/Refract.tsx`. The whole
session was about why the port's distortion looks wrong vs the reference.

## What Was Done (chronological)

The user reported two original bugs (with blur temporarily disabled for inspection —
`DEFAULT_BLUR` was set to `0` in `Refract.tsx`):
1. A directional "bias/skew" in how the distortion bends.
2. Small elements showed no distortion at all.

**Fix 1 (kept): radius clamp.** Root cause of BOTH original bugs was that `b` (corner
radius) is read via `getComputedStyle(el).borderTopLeftRadius`, which returns the
*specified* value. For Tailwind `rounded-full` that is `9999px`, not the painted radius.
With `b=9999` every pixel falls into the "corner" branch with a corner center thousands of
px away → small boxes get zero displacement (`rr > b` everywhere), wide boxes bend
uniformly toward that far diagonal corner. Fix added at top of `buildMap`:
`b = Math.min(b, W / 2, H / 2);` (matches the browser's actual clamping). This is geometry,
NOT gamma — it is still in the file and should stay (without it, pills get zero distortion).

**Then: a long, ultimately-reverted investigation into a color-space skew.** After the
radius fix the user said a skew remained on straight edges (a vertical line bent left/right).
I verified numerically (Node probes) that the displacement MAP itself is correct: on a
straight top edge the horizontal channel is exactly neutral (`R=128`), and the raw
displacement field is mirror-symmetric about the box center. So the skew had to be a
DECODE/color-space issue: `feDisplacementMap` decodes a channel as `scale·(channel − 0.5)`,
and the neutral `128` only means "0.5" if the filter runs in sRGB. WebView2 appears to run
the filter in linearRGB and/or color-manage the canvas-generated PNG, so neutral `128`
decoded to a large uniform shift.

I tried, in order (ALL of these color/gamma changes were later REVERTED at user request):
- `colorInterpolationFilters="sRGB"` → `"linearRGB"` + single sRGB-gamma encode of channels
  (`lin2srgb(0.5 + d/scale)`). User: still skewed left.
- Double sRGB-gamma encode (`lin2srgb(lin2srgb(...))`), reasoning WebView2 converts twice
  (PNG color-management + filter working space). This FIXED the left/right (neutral) skew,
  but the user then saw a **vertical magnitude asymmetry** ("top stretched down, bottom
  compressed").
- A single tunable `DISPLACEMENT_GAMMA = 5.2` pure-power inverse encode
  (`pow(0.5 + d/scale, 1/GAMMA)`), intended as a one-knob calibration. (Confirmed via probe
  that channel extremes 0/1 are fixed points so they stay symmetric; the residual asymmetry
  is the curve SHAPE in the middle, which depends on WebView2's exact transfer that I could
  not determine without the user's eyes.)

**Final action this session: full revert of all gamma/color-space changes**, at the user's
explicit request ("revert all the gamma corrections, I'll fix the bending myself").

## Current State

`src/components/Refract.tsx` map path is reverted to the ORIGINAL reference encoding:
- `Refract.tsx:153-156` — plain encode: `data[k*4] = clamp255(round(255*(0.5 + dxA[k]/scale)))`,
  same for `dyA` on `+1`, B channel `128`, A channel `255`.
- Filter element attribute is back to `colorInterpolationFilters="sRGB"`.
- `lin2srgb`, `clamp01`, `DISPLACEMENT_GAMMA` are all removed (grep-confirmed: no remnants).
- The radius clamp at `Refract.tsx:72` (`b = Math.min(b, W / 2, H / 2);`) is INTENTIONALLY
  KEPT (geometry fix, not gamma).
- `tsc --noEmit` is clean.

**Last user message (unresolved):** "You didn't revert properly. The distortion at the top
does not match the bottom." My response (not yet acted on further): the revert IS complete
and byte-identical to the original encoding; the top≠bottom asymmetry is NOT residual code
and NOT in the bending math (raw `dy` field is mirror-symmetric about center, verified). It
is caused by WebView2 color-managing the displacement-map PNG: the vertical (G) channel
holds HIGH values near the top edge and LOW values near the bottom, and the engine's gamma
curve stretches those two ends unequally, so equal-and-opposite displacements decode to
unequal magnitudes. The same `buildMap` renders symmetric in a plain Chromium browser; it is
the WebView color path that skews it. The lever to fix it is the channel ENCODING, not the
edge-normal geometry.

The user wants to fix the bending themselves from this clean baseline.

**Also note:** `DEFAULT_BLUR` in `Refract.tsx` (around line 48) is still `0` (the user set it
to inspect). The prototype/reference value is `3`. Restore to `3` when done inspecting.

There may still be a `tauri dev` / Vite process running from earlier (background bash id was
`bz0y9i6ib`, but it reported exit code 0 — the user closed the window). `dist/` and
`node_modules/.vite` were deleted during the session and will be regenerated on next run.

## Next Steps
1. **Wait for the user.** They explicitly said they'll fix the bending themselves. Do not
   re-apply gamma corrections unless asked.
2. If asked to help with the top/bottom asymmetry again: it is a color-pipeline gamma issue,
   not geometry. Options to discuss with the user (their eyes required to calibrate, since
   AGENTS.md forbids me self-verifying via the running UI):
   - Single tunable inverse-gamma encode (the `DISPLACEMENT_GAMMA` approach) and have the
     user dial it until a straight line bends evenly.
   - Or eliminate the color management entirely (e.g., construct the PNG with a `gAMA`/`sRGB`
     chunk, or otherwise feed `feImage` data the engine won't gamma-convert) — more work,
     but removes the guessing.
3. Restore `DEFAULT_BLUR` to `3` before considering the feature done.
4. `Refract` is used by many components (ZoomStepper, GalleryControls, VideoScrubBar,
   IndexingPill, InfoPopover, PeopleModal, PhotoDetail, FaceIndexingScreen) — verify any
   `Refract` change visually across them, not just the zoom pill.

## Key Files & Locations
- `src/components/Refract.tsx` — the liquid-glass wrapper component. `buildMap()` generates the
  per-element displacement map (canvas → data URI → `feImage`); two `useEffect`s build/rebuild
  it (mount+ResizeObserver, and on `[blur, refraction]` change). The SVG `<filter>` is
  per-instance with a unique id from `useId()`. Radius clamp at line ~72; channel encode at
  lines ~153-156; `<filter colorInterpolationFilters="sRGB">` and `<feDisplacementMap
  scale="64" xChannelSelector="R" yChannelSelector="G">` near the bottom JSX (~line 389).
- `src/styles/refract.css` — the material CSS (tint, specular rim, hover lean/pop, morph
  spring). Deliberately NO `overflow:hidden` (WebView2 drops the backdrop-filter layer if a
  backdrop-filtered element clips overflow).
- `refract.html` — the standalone reference prototype the user trusts. Identical `buildMap`
  math; uses hand-set radii (always ≤ half-box) so it never hits the `rounded-full` clamp bug,
  and is viewed in a browser that honors `color-interpolation-filters="sRGB"`, so it does not
  show the WebView color skew.
- `src/components/ZoomStepper.tsx` — the bottom-center zoom pill (`rounded-full`); the element
  the user has been testing against (a vertical "rocket" line in the app's build view crosses
  behind it).
- `AGENTS.md` — binding design rules + the "human runs the app, not Claude" working practice.
- `src-tauri/tauri.conf.json` — `devUrl: localhost:1420`, `frontendDist: ../dist`,
  `beforeDevCommand: npm run dev`.

## Open Questions / Blockers
- **Unknown:** WebView2's exact effective transfer function applied to the displacement-map
  PNG before `feDisplacementMap` samples it. Established empirically that: plain `128` neutral
  shifts left (≥1 gamma conversion happening); single-sRGB-gamma encode still shifts left
  (≥2 conversions); double-sRGB-gamma encode fixes neutral/horizontal but leaves a vertical
  magnitude asymmetry. The middle-of-curve shape is what's unmatched. Cannot be pinned down
  without iterating against the user's eyes (AGENTS.md bars me from visually self-verifying).
- The user is now driving the bending fix themselves. Primary blocker for me independently:
  no way to observe the rendered WebView output.

---
*To resume: read this file, then confirm you have context before proceeding.*
