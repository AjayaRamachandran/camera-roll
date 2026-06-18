/**
 * FrostedBackground
 *
 * Renders the dithering layer that sits *on top of* the native OS acrylic blur.
 * It paints nothing of its own except a faint, click-through noise texture whose
 * only job is to hide gradient banding (see src/styles/frosted.css for the why).
 *
 * It is deliberately dumb and stateless — the real blur lives in the OS
 * compositor, configured once on the Rust side (src-tauri/src/window_effects.rs).
 *
 * If you ever want to toggle/tune the dither at runtime, this is the place to do
 * it: e.g. set `style={{ "--dither-opacity": 0.06 } as React.CSSProperties}`.
 */
export default function FrostedBackground() {
  return (
    <>
      {/* Base color/tint of the frosted glass. Done here in CSS (not in Rust)
          because Windows 11 ignores the acrylic tint passed natively. */}
      <div className="frosted-tint" aria-hidden="true" />
      {/* Dithering noise on top of the tint to hide banding. */}
      <div className="frosted-dither" aria-hidden="true" />
    </>
  );
}
