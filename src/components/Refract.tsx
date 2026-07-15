import {
  CSSProperties,
  ElementType,
  HTMLAttributes,
  ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useAcrylicMatte } from "./AcrylicMatte";

/**
 * Refract: a wrapper that gives any element the liquid-glass material.
 *
 * Wrap something in <Refract> and it becomes a pane of curved glass: a
 * translucent tint, a bright specular rim, and a backdrop that refracts
 * (bends) around the rounded edges. It also leans toward the cursor and
 * brightens on hover, and springs smoothly when it changes size between states
 * (e.g. an icon button that expands into a dropdown).
 *
 * State transitions are native: the spring lives in the base `.refract` rule
 * (see src/styles/refract.css), so to morph a glass surface between two states
 * you just toggle its geometry (width / height / border-radius / left / top /
 * right / bottom) and the transition animates it. No flags or imperative calls.
 * This component's only job during a morph is to regenerate the displacement
 * map each frame (via the ResizeObserver below) so the lensing tracks the box.
 *
 * How the refraction works: a displacement map is generated per element and fed
 * to an SVG filter used as a `backdrop-filter`. The map has to match the
 * element's exact box (size + corner radius), so each Refract owns its OWN
 * <filter> with a unique id (see `filterId`). That is what lets many glass
 * surfaces share a screen without clashing over a single global filter.
 *
 * Customizable per instance (all optional, with sensible defaults):
 *   blur        base backdrop blur in px (scaled up for larger boxes)
 *   tint        background tint opacity, 0..1
 *   refraction  optical strength of the edge lensing
 *
 * The material/animation rules live in src/styles/refract.css.
 */

export interface RefractProps extends HTMLAttributes<HTMLElement> {
  /** Element to render as the glass surface. Defaults to a <div>. */
  as?: ElementType;
  /** Base backdrop blur in px. Scaled up for larger boxes. Default 3. */
  blur?: number;
  /** Background tint opacity, 0..1. Default 0.1. */
  tint?: number;
  /** Optical strength of the edge refraction. Default 0.08. */
  refraction?: number;
  /** Forwarded to the element when rendered as a <button>. */
  type?: "button" | "submit" | "reset";
  /**
   * Debug: render the generated displacement map as a scaled, pixelated <img>
   * overlay near this element, updating live on every regen (resize / morph /
   * knob change). R = horizontal bend, G = vertical bend; neutral 50% grey =
   * zero displacement, so you can read the left/right and top/bottom bias of the
   * map directly. Off in normal use.
   */
  debugMap?: boolean;
  children?: ReactNode;
}

const DEFAULT_BLUR = 3;
const DEFAULT_TINT = 0.3;
const DEFAULT_REFRACTION = 0.1;

/** Reference box length the blur is calibrated against (the prototype orb). */
const BLUR_REF = 64;

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * Build the displacement map for a box of `W` x `H` with corner radius `b` and
 * optical strength `a`. Returns a data URI for the map image plus the
 * displacement `scale` the SVG filter should use. Lifted from the prototype:
 * the map encodes, per pixel, how far to bend the backdrop, ramping up sharply
 * within `b` of each edge so the lensing hugs the rounded rim.
 */
function buildMap(W: number, H: number, b: number, a: number) {
  // Clamp to the radius the browser actually paints. getComputedStyle returns
  // the *specified* radius, which for `rounded-full` (border-radius: 9999px) is
  // far larger than the box. Left unclamped, every pixel falls in the "corner"
  // branch with a corner center thousands of px away: small boxes get zero
  // displacement (rr > b everywhere) and wide boxes bend uniformly toward that
  // far corner instead of radially toward the nearest edge. The browser clamps
  // a uniform radius to min(W/2, H/2); match that.
  b = Math.min(b, W / 2, H / 2);

  const MAXD = 160;
  const sc = Math.min(1, MAXD / Math.max(W, H));
  const mw = Math.max(2, Math.round(W * sc));
  const mh = Math.max(2, Math.round(H * sc));
  const cv = document.createElement("canvas");
  cv.width = mw;
  cv.height = mh;
  const ctx = cv.getContext("2d");
  if (!ctx) return { uri: "", scale: 0 };
  const img = ctx.createImageData(mw, mh);
  const data = img.data;

  const g = (n: number) => {
    const t = a * (b - n);
    return Math.exp(t) - (t + 1);
  };
  const MAGIC = 400;
  const gRef = Math.exp(a * b) - (a * b + 1) || 1e-6;
  const coeff = (MAGIC * a) / gRef;

  const dxA = new Float32Array(mw * mh);
  const dyA = new Float32Array(mw * mh);
  let maxAbs = 1e-4;

  for (let j = 0; j < mh; j++) {
    for (let i = 0; i < mw; i++) {
      const cxp = (i + 0.5) * (W / mw);
      const cyp = (j + 0.5) * (H / mh);
      const dl = cxp;
      const dr = W - cxp;
      const dt = cyp;
      const db = H - cyp;
      const cornerX = cxp < b || cxp > W - b;
      const cornerY = cyp < b || cyp > H - b;

      let n: number;
      let nx = 0;
      let ny = 0;
      let valid = true;
      if (cornerX && cornerY) {
        const ccx = cxp < b ? b : W - b;
        const ccy = cyp < b ? b : H - b;
        const vx = cxp - ccx;
        const vy = cyp - ccy;
        const rr = Math.hypot(vx, vy);
        if (rr > b) {
          valid = false;
          n = b;
        } else if (rr < 1e-6) {
          n = b;
        } else {
          n = b - rr;
          nx = -vx / rr;
          ny = -vy / rr;
        }
      } else {
        const m = Math.min(dl, dr, dt, db);
        n = m;
        if (m === dl) nx = 1;
        else if (m === dr) nx = -1;
        else if (m === dt) ny = 1;
        else ny = -1;
      }

      let dx = 0;
      let dy = 0;
      if (valid && n < b) {
        const off = coeff * g(n);
        dx = nx * off;
        dy = ny * off;
      }
      const k = j * mw + i;
      dxA[k] = dx;
      dyA[k] = dy;
      if (Math.abs(dx) > maxAbs) maxAbs = Math.abs(dx);
      if (Math.abs(dy) > maxAbs) maxAbs = Math.abs(dy);
    }
  }
  const mapping = (x: number) => x;
  const scale = 2 * maxAbs;
  for (let k = 0; k < mw * mh; k++) {
    data[k * 4] = clamp255(Math.round(255 * (mapping(0.5 + dxA[k] / scale))));
    data[k * 4 + 1] = clamp255(Math.round(255 * (mapping(0.5 + dyA[k] / scale))));
    data[k * 4 + 2] = 128;
    data[k * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return { uri: cv.toDataURL(), scale };
}

export default function Refract({
  as,
  blur = DEFAULT_BLUR,
  tint = DEFAULT_TINT,
  refraction = DEFAULT_REFRACTION,
  className,
  style,
  debugMap = false,
  children,
  ...rest
}: RefractProps) {
  const Tag = (as ?? "div") as ElementType;

  // Latest generated displacement map, mirrored into state only when debugMap
  // is on so the preview <img> below re-renders live with each regen.
  const [debugUri, setDebugUri] = useState("");

  // useId can contain characters that are awkward in a CSS url(#...) / id, so
  // strip everything but id-safe characters. Unique per instance -> no clashes.
  const filterId = "refract-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");

  // Register this glass surface's footprint into the acrylic matte so the
  // captured backplate is painted (and only painted) beneath it. See
  // AcrylicMatte.tsx / docs/liquid-glass-acrylic.md.
  const matte = useAcrylicMatte();

  const elRef = useRef<HTMLElement>(null);
  const feImageRef = useRef<SVGFEImageElement>(null);
  const dispRef = useRef<SVGFEDisplacementMapElement>(null);

  // Latest prop values, so the resize/hover loops always read current settings
  // without re-subscribing the observers.
  const blurRef = useRef(blur);
  const refractionRef = useRef(refraction);
  blurRef.current = blur;
  refractionRef.current = refraction;

  useEffect(() => {
    const el = elRef.current;
    if (!el) return;

    // Blur grows with the box so a small pill and a big panel read as the same
    // "frostedness" (more blur when there's more glass).
    const applyBlur = (W: number, H: number) => {
      el.style.setProperty(
        "--blur",
        (blurRef.current * Math.sqrt((W + H) / 2 / BLUR_REF)).toFixed(2) + "px"
      );
    };

    const regenMap = () => {
      const r = el.getBoundingClientRect();
      const W = Math.max(2, Math.round(r.width));
      const H = Math.max(2, Math.round(r.height));
      const b = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0.001;
      const { uri, scale } = buildMap(W, H, b, refractionRef.current);
      const feImage = feImageRef.current;
      const disp = dispRef.current;
      if (feImage && uri) {
        feImage.setAttribute("width", String(W));
        feImage.setAttribute("height", String(H));
        feImage.setAttribute("href", uri);
        feImage.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", uri);
      }
      if (disp) disp.setAttribute("scale", scale.toFixed(2));
      if (debugMap && uri) setDebugUri(uri);
      applyBlur(W, H);
    };

    // rAF-throttle map regeneration: ResizeObserver can fire many times per
    // frame while an element morphs, and the canvas build is the expensive bit.
    let pending = false;
    const scheduleMap = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        regenMap();
      });
    };

    // The box can change for any reason (a state-transition morph, a layout
    // reflow, content resizing). Whatever the cause, regenerate the displacement
    // map so the lensing keeps matching the current box. The spring that
    // actually animates the morph is the native CSS transition on `.refract`.
    const ro = new ResizeObserver(() => scheduleMap());
    ro.observe(el);

    // First paint, then again after layout settles.
    requestAnimationFrame(regenMap);

    // Register this element so the matte's rAF loop tracks its live footprint
    // (position included), and drop it on unmount.
    matte.register(filterId, el);

    return () => {
      ro.disconnect();
      matte.unregister(filterId);
    };
  }, []);

  // Re-tint / re-blur / re-refract when the knobs change at runtime.
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = Math.max(2, Math.round(r.width));
    const H = Math.max(2, Math.round(r.height));
    const b = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0.001;
    const { uri, scale } = buildMap(W, H, b, refraction);
    const feImage = feImageRef.current;
    const disp = dispRef.current;
    if (feImage && uri) {
      feImage.setAttribute("width", String(W));
      feImage.setAttribute("height", String(H));
      feImage.setAttribute("href", uri);
      feImage.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", uri);
    }
    if (disp) disp.setAttribute("scale", scale.toFixed(2));
    if (debugMap && uri) setDebugUri(uri);
    el.style.setProperty("--blur", (blur * Math.sqrt((W + H) / 2 / BLUR_REF)).toFixed(2) + "px");
  }, [blur, refraction, debugMap]);

  // ---- cursor-reactive hover: lean toward the cursor, pop, and brighten ----
  const pmPending = useRef(false);
  const lastPM = useRef<{ clientX: number; clientY: number } | null>(null);

  const updateHover = () => {
    const el = elRef.current;
    const e = lastPM.current;
    if (!el || !e) return;
    const r = el.getBoundingClientRect();
    const W = r.width;
    const H = r.height;
    const ndx = (e.clientX - r.left - W / 2) / (W / 2); // -1..1 from centre
    const ndy = (e.clientY - r.top - H / 2) / (H / 2);
    const dist = Math.min(1, Math.hypot(ndx, ndy));
    const L = (W + H) / 2;

    // Hover pop scales inversely with size: a small orb pops ~7-10%, a big
    // panel ~1%. Nudge toward the cursor so it leans into the click.
    const p = Math.min(0.1, Math.max(0.01, 4.5 / L));
    const M = 4;
    el.style.setProperty("--nx", (ndx * M).toFixed(2) + "px");
    el.style.setProperty("--ny", (ndy * M).toFixed(2) + "px");
    el.style.setProperty("--sc", (1 + p).toFixed(4));
    // Brightest at the centre, fading to none at the edge.
    el.style.setProperty("--refract-gb", (1 + 0.18 * (1 - dist)).toFixed(3));
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLElement>) => {
    lastPM.current = { clientX: e.clientX, clientY: e.clientY };
    if (pmPending.current) return;
    pmPending.current = true;
    requestAnimationFrame(() => {
      pmPending.current = false;
      updateHover();
    });
  };

  const handlePointerLeave = () => {
    const el = elRef.current;
    if (!el) return;
    el.style.setProperty("--nx", "0px");
    el.style.setProperty("--ny", "0px");
    el.style.setProperty("--sc", "1");
    el.style.setProperty("--refract-gb", "1");
  };

  const filterValue = `blur(var(--blur)) saturate(2) brightness(calc(var(--refract-gb) * 1.2)) url(#${filterId})`;

  const mergedStyle: CSSProperties = {
    ["--sa" as string]: tint,
    backdropFilter: filterValue,
    WebkitBackdropFilter: filterValue,
    ...style,
  };

  return (
    <Tag
      ref={elRef}
      className={className ? `refract ${className}` : "refract"}
      style={mergedStyle}
      {...rest}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    >
      {/* Drop shadow: a blurred, filled layer behind the glass. It has to be a
          real painted element (not a box-shadow / filter: drop-shadow) because
          shadow primitives don't composite over the app's transparent acrylic
          window. inset:0 + border-radius:inherit makes it track the box and
          morph with it for free. See .refract-shadow in refract.css. */}
      <span className="refract-shadow" aria-hidden="true" />

      {/* Interior tint: blurred and retreated from the edges so it's opaque in
          the middle and fades out before the border. Wrapped in
          .refract-tint-clip so the blur bleed is clipped to the glass
          silhouette. See refract.css. */}
      <span className="refract-tint-clip" aria-hidden="true">
        <span className="refract-tint" aria-hidden="true" />
      </span>

      {/* Black left/right border complementing the white top/bottom rim on
          `.refract`. See .refract-rim in refract.css. */}
      <span className="refract-rim" aria-hidden="true" />

      {/* Per-instance displacement filter. The unique id is what keeps multiple
          glass surfaces from sharing (and corrupting) one another's map. */}
      <svg className="refract-filter" aria-hidden="true">
        <filter
          id={filterId}
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
          colorInterpolationFilters="sRGB"
        >
          <feImage ref={feImageRef} x="0" y="0" width="64" height="64" preserveAspectRatio="none" result="map" />
          <feDisplacementMap
            ref={dispRef}
            in="SourceGraphic"
            in2="map"
            scale="64"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>
      {debugMap && debugUri ? (
        <img
          src={debugUri}
          alt="displacement map"
          aria-hidden="true"
          style={{
            position: "fixed",
            top: 0,
            left: 128,
            width: 256,
            height: "auto",
            zIndex: 99999,
            imageRendering: "pixelated",
            border: "1px solid #0f0",
            background:
              "repeating-conic-gradient(#444 0% 25%, #666 0% 50%) 50% / 16px 16px",
            pointerEvents: "none",
          }}
        />
      ) : null}
      {children}
    </Tag>
  );
}
