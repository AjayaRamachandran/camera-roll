import { useEffect, useState } from "react";

import { ChevronLeft, ChevronRight, Settings } from "lucide-react";

import Refract from "./Refract";
import { GLASS_PRESETS, useLiquidGlass } from "./LiquidGlassConfig";

// Box geometry, in px. The closed orb and the open panel share their BOTTOM-RIGHT
// corner (the anchor), so the panel grows up and to the left out of the orb.
// Positioned by CENTRE (translate(-50%,-50%)) so the morph rides Refract's
// liquid-glass spring, exactly like LibrarySwitcher (which grows up-right).
const CLOSED = 40;
const PANEL_W = 256;
const PANEL_H = 208;

/**
 * Bottom-right settings control: a glass orb that springs open into a small
 * panel. For now it holds a single stepper that moves the whole app's liquid
 * glass between three appearances (clearer to more frosted); the change is live,
 * so every pane of glass restyles as you step.
 */
export default function SettingsButton() {
  const [open, setOpen] = useState(false);
  const { presetIndex, setPresetIndex, reflections, setReflections } =
    useLiquidGlass();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const preset = GLASS_PRESETS[presetIndex];
  const atStart = presetIndex <= 0;
  const atEnd = presetIndex >= GLASS_PRESETS.length - 1;

  const step = (delta: number) => {
    const next = presetIndex + delta;
    if (next < 0 || next > GLASS_PRESETS.length - 1) return;
    setPresetIndex(next);
  };

  const stepButton =
    "grid place-items-center rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30";

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 pointer-events-auto"
          onClick={() => setOpen(false)}
        />
      )}

      <div className="pointer-events-none absolute bottom-6 right-5 z-50 h-10 w-10">
        <Refract
          className="pointer-events-auto absolute font-sans"
          style={{
            // Both states share the bottom-right corner (right edge CLOSED,
            // bottom edge CLOSED), so the panel grows up and to the left.
            left: open ? CLOSED - PANEL_W / 2 : CLOSED / 2,
            top: open ? CLOSED - PANEL_H / 2 : CLOSED / 2,
            width: open ? PANEL_W : CLOSED,
            height: open ? PANEL_H : CLOSED,
            borderRadius: open ? 22 : 20,
            transform:
              "translate(-50%, -50%) translate(var(--nx), var(--ny)) scale(var(--sc))",
          }}
        >
          {/* Closed face: the settings icon. Fades + blurs out as the panel opens. */}
          <button
            type="button"
            aria-label="Appearance settings"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="absolute inset-0 grid place-items-center text-white/85 hover:text-white"
            style={{
              opacity: open ? 0 : 1,
              filter: open ? "blur(var(--refract-fade-blur))" : "blur(0px)",
              pointerEvents: open ? "none" : "auto",
              transition:
                "opacity var(--refract-fade-anim) var(--refract-fade-ease), filter var(--refract-fade-anim) var(--refract-fade-ease)",
            }}
          >
            <Settings size={18} />
          </button>

          {/* Open face. The content lives in a FIXED-size box CENTERED in a clip
              layer that tracks the morphing container, so its centroid rides the
              box centre exactly like the other glass controls: as the box springs
              open the content is revealed symmetrically from the middle (not
              wiped in from a corner), and because the box is a fixed size its
              layout is computed once at the panel size and never reflows while
              the container animates. The clip layer carries no backdrop-filter,
              so overflow:hidden is safe here (unlike on the glass surface), and
              it stays inside the box so the shadow spill is untouched. */}
          <div
            className="absolute inset-0 overflow-hidden"
            style={{
              borderRadius: "inherit",
              pointerEvents: open ? "auto" : "none",
            }}
          >
          <div
            className="absolute left-1/2 top-1/2 flex flex-col justify-center gap-3 px-4 py-4"
            style={{
              width: PANEL_W,
              height: PANEL_H,
              opacity: open ? 1 : 0,
              transform: open
                ? "translate(-50%, -50%)"
                : "translate(-50%, calc(-50% + 6px))",
              filter: open ? "blur(0px)" : "blur(var(--refract-fade-blur))",
              transition: [
                "opacity var(--refract-fade-anim) var(--refract-fade-ease)",
                "transform var(--refract-fade-anim) var(--refract-spring-pos)",
                "filter var(--refract-fade-anim) var(--refract-fade-ease)",
              ].join(", "),
            }}
          >
            <span className="text-sm text-white/60">Liquid Glass</span>

            <div className="flex items-center justify-between">
              <button
                type="button"
                aria-label="Less frosted"
                onClick={() => step(-1)}
                disabled={atStart}
                className={stepButton}
              >
                <ChevronLeft size={18} />
              </button>

              <span className="min-w-0 flex-1 text-center text-base text-white/90">
                {preset.name}
              </span>

              <button
                type="button"
                aria-label="More frosted"
                onClick={() => step(1)}
                disabled={atEnd}
                className={stepButton}
              >
                <ChevronRight size={18} />
              </button>
            </div>

            <div className="flex items-center justify-center gap-1.5">
              {GLASS_PRESETS.map((p, idx) => (
                <button
                  key={p.name}
                  type="button"
                  aria-label={p.name}
                  aria-pressed={idx === presetIndex}
                  onClick={() => setPresetIndex(idx)}
                  className={`h-[3px] w-3.5 rounded-full transition-colors ${
                    idx === presetIndex
                      ? "bg-white/90"
                      : "bg-white/30 hover:bg-white/50"
                  }`}
                />
              ))}
            </div>

            {/* Divider between the glass appearance controls and reflections. */}
            <div className="h-px w-full bg-white/10 my-2 mt-3" />

            {/* Reflections toggle. Sits below the frost controls; when on, the
                reflection strength follows the glass blur set above. */}
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-white/90">
                  Reflections{" "}
                  <span className="text-white/40">(Experimental)</span>
                </div>
                <div className="mt-0.5 text-xs leading-snug text-white/45">
                  Uses the front camera to mimic reflections on top of the
                  existing refractions
                </div>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={reflections}
                aria-label="Reflections"
                onClick={() => setReflections(!reflections)}
                className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
                  reflections ? "bg-white/80" : "bg-white/20"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
                    reflections ? "translate-x-0" : "-translate-x-3.75"
                  }`}
                />
              </button>
            </div>
          </div>
          </div>
        </Refract>
      </div>
    </>
  );
}
