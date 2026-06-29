import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";

/**
 * AcrylicMatte: gives the liquid-glass material something real to refract over
 * the bare Windows acrylic surface.
 *
 * The problem (see docs/liquid-glass-acrylic.md): `backdrop-filter` and the SVG
 * displacement map only have pixels to work on where the DOM has painted. The OS
 * acrylic is composited *behind* the transparent window, so over bare-acrylic
 * regions the glass has nothing to blur or bend — you get a "ghosting" seam.
 *
 * The fix: the Rust side captures a small screenshot of the desktop behind the
 * window (~1 Hz) and emits it on the `acrylic-frame` event. We paint that frame
 * as a layer at the very bottom of the app — pre-blurred so it reads as acrylic
 * — **clipped to the union of every glass element's footprint** (its "matte").
 * Directly under glass the backdrop is now real pixels the filter can sample;
 * everywhere else the frame is clipped away and the live OS acrylic shows
 * through untouched.
 *
 * Tracking: each <Refract> registers its DOM element. A single rAF loop here
 * reads every registered element's live rect each frame, so the matte follows
 * moves, resizes, morphs and scroll alike (a ResizeObserver per element would
 * miss position-only changes, leaving stale footprints behind).
 */

interface MatteShape {
  /** Viewport coordinates (getBoundingClientRect space). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Painted corner radius, clamped to min(W/2, H/2). */
  r: number;
}

interface MatteApi {
  register: (id: string, el: HTMLElement) => void;
  unregister: (id: string) => void;
}

// No-op default so a <Refract> used outside a provider still renders (it just
// won't contribute to the matte). Keeps the component usable in isolation.
const MatteContext = createContext<MatteApi>({
  register: () => {},
  unregister: () => {},
});

export function useAcrylicMatte() {
  return useContext(MatteContext);
}

/**
 * Pre-blur applied to the backplate so it reads as acrylic rather than a sharp
 * screenshot. The glass then adds its own blur on top, the same way it would
 * frost the real acrylic. Tune to taste against the surrounding OS acrylic.
 */
const ACRYLIC_PREBLUR = 10;

const CLIP_ID = "acrylic-matte-clip";

export function AcrylicMatteProvider({ children }: { children: ReactNode }) {
  const elems = useRef<Map<string, HTMLElement>>(new Map());
  const rafId = useRef<number | undefined>(undefined);
  const lastKey = useRef<string>("");

  const [shapes, setShapes] = useState<MatteShape[]>([]);
  const [frameUri, setFrameUri] = useState<string>("");

  // Read every registered element's live footprint once per frame. Only push to
  // state when the rounded set actually changes, so an idle screen does no work.
  const tick = useCallback(() => {
    const arr: MatteShape[] = [];
    for (const el of elems.current.values()) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      const W = r.width;
      const H = r.height;
      if (W < 2 || H < 2) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      const b = parseFloat(cs.borderTopLeftRadius) || 0;
      arr.push({ x: r.left, y: r.top, w: W, h: H, r: Math.min(b, W / 2, H / 2) });
    }
    const key = arr
      .map((s) =>
        [s.x, s.y, s.w, s.h, s.r].map((n) => Math.round(n)).join(",")
      )
      .join("|");
    if (key !== lastKey.current) {
      lastKey.current = key;
      setShapes(arr);
    }
    rafId.current = elems.current.size > 0 ? requestAnimationFrame(tick) : undefined;
  }, []);

  const ensureLoop = useCallback(() => {
    if (rafId.current === undefined) rafId.current = requestAnimationFrame(tick);
  }, [tick]);

  const register = useCallback(
    (id: string, el: HTMLElement) => {
      elems.current.set(id, el);
      ensureLoop();
    },
    [ensureLoop]
  );

  const unregister = useCallback((id: string) => {
    elems.current.delete(id);
    // The loop notices size === 0 on its next tick, clears the matte, and stops.
  }, []);

  useEffect(() => {
    return () => {
      if (rafId.current !== undefined) cancelAnimationFrame(rafId.current);
    };
  }, []);

  // Downsampled desktop-behind-window frames from the Rust capture loop.
  useEffect(() => {
    const unlistenP = listen<{ uri: string }>("acrylic-frame", (e) => {
      if (e.payload?.uri) setFrameUri(e.payload.uri);
    });
    return () => {
      unlistenP.then((un) => un()).catch(() => {});
    };
  }, []);

  const api = useMemo<MatteApi>(() => ({ register, unregister }), [register, unregister]);

  return (
    <MatteContext.Provider value={api}>
      {/* Backplate: the captured acrylic, clipped to the glass matte, painted at
          the very bottom (below frosted-tint/dither) so the glass
          backdrop-filter samples it. With no shapes the clipPath is empty =>
          fully clipped => invisible, which is what we want when no glass is up. */}
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 0,
          pointerEvents: "none",
          backgroundImage: frameUri ? `url("${frameUri}")` : undefined,
          backgroundSize: "100% 100%",
          backgroundRepeat: "no-repeat",
          filter: `blur(${ACRYLIC_PREBLUR}px)`,
          clipPath: `url(#${CLIP_ID})`,
          WebkitClipPath: `url(#${CLIP_ID})`,
        }}
      />
      <svg
        width="0"
        height="0"
        aria-hidden="true"
        style={{ position: "absolute", pointerEvents: "none" }}
      >
        <defs>
          <clipPath id={CLIP_ID} clipPathUnits="userSpaceOnUse">
            {shapes.map((s, i) => (
              <rect
                key={i}
                x={s.x}
                y={s.y}
                width={s.w}
                height={s.h}
                rx={s.r}
                ry={s.r}
              />
            ))}
          </clipPath>
        </defs>
      </svg>
      {children}
    </MatteContext.Provider>
  );
}
