import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { DEFAULT_BLUR } from "./Refract";
// Shader source lives in its own .vert/.frag files so editors give it GLSL
// syntax highlighting. Vite's `?raw` suffix imports each as a plain string.
import VERT from "./shaders/reflect.vert?raw";
import FRAG from "./shaders/reflect.frag?raw";
import SHADOW_VERT from "./shaders/shadow.vert?raw";
import SHADOW_FRAG_SRC from "./shaders/shadow.frag?raw";

/**
 * CameraReflection: gives the liquid-glass material a live environment to
 * reflect, so the glass catches the room's light the way real glass does.
 *
 * The idea (and why this is WebGL, not another SVG filter): each glass surface
 * already has a displacement map whose R/G channels encode, per pixel, a
 * *direction* (neutral grey = no direction, the rim = a strong outward push).
 * For a reflection we do NOT offset the neighbouring pixel the way
 * feDisplacementMap would. Instead we read that direction as a position: neutral
 * grey samples the CENTER of the camera image, and the strongest rim direction
 * samples out to a radius of (smaller camera dimension / 2) from that center, in
 * the indicated direction. That is an environment-map lookup, which a plain 2D
 * displacement filter cannot express, so we run it in a fragment shader.
 *
 * One full-screen WebGL canvas sits above the glass with CSS mix-blend-mode
 * screen. Each frame it uploads the mirrored, blurred camera frame, then draws
 * one quad per registered glass surface (masked to its rounded silhouette),
 * sampling the camera through that surface's direction field. Screen-blending it
 * over the page lays the reflection on top of the refraction beneath.
 *
 * The camera is best-effort: if it is unavailable or access is declined, the
 * canvas simply never draws and the glass looks exactly as it did before.
 */

interface ReflectionApi {
  register: (id: string, el: HTMLElement) => void;
  /** Hand over this surface's fresh direction field + painted corner radius. */
  setMap: (id: string, mapCanvas: HTMLCanvasElement, radius: number) => void;
  /** Hand over the per-element canvas the light-driven shadow is painted into. */
  setShadowCanvas: (id: string, canvas: HTMLCanvasElement | null) => void;
  unregister: (id: string) => void;
}

// No-op default so a <Refract> used outside a provider still renders (it just
// won't get reflections). Keeps the component usable in isolation.
const ReflectionContext = createContext<ReflectionApi>({
  register: () => {},
  setMap: () => {},
  setShadowCanvas: () => {},
  unregister: () => {},
});

export function useCameraReflection() {
  return useContext(ReflectionContext);
}

/** Base square the camera frame would reduce to at full detail. Power-of-two. */
const CAM_BASE_SIZE = 256;

/**
 * The reflection is softened past the base glass frost by two independent
 * multipliers that COMPOUND. Total softening is roughly their product, while the
 * only resolution loss is the downsample factor.
 *
 * DOWNSAMPLE_MULTIPLE (more performant): shrink the camera frame by this factor
 * and let LINEAR filtering stretch it back up. The smaller frame is a free blur
 * and cuts per-frame draw + upload cost, but each step of it also loses detail.
 *
 * BLUR_MULTIPLE: blur the (already shrunk) frame by this multiple of the glass
 * blur. A true gaussian, so it softens without shedding resolution.
 *
 * Example: DOWNSAMPLE 4 + BLUR 4 => ~16x softening with only 4x resolution loss,
 * which smooths sensor noise that a pure 16x downsample would leave flickering.
 */
const DOWNSAMPLE_MULTIPLE = 4;
const BLUR_MULTIPLE = 2;

/** Square the camera frame is actually reduced to. */
const CAM_SIZE = Math.max(
  16,
  Math.round(CAM_BASE_SIZE / DOWNSAMPLE_MULTIPLE)
);

/** Blur applied to the shrunk camera frame, in that frame's pixels. The upscale
 *  back to screen magnifies it by the downsample factor, so the perceived blur
 *  is BLUR_MULTIPLE * DOWNSAMPLE_MULTIPLE * glass blur. */
const CAM_BLUR = DEFAULT_BLUR * BLUR_MULTIPLE;

/** Black point (0..255). The camera is level-stretched so anything below this
 *  crushes to black and the range above is rescaled back up to full, isolating
 *  the room's real highlights as the thing the glass reflects. */
const BLACK_POINT = 180;

/** Color saturation after the black-point crush (1 = untouched). 0.5 halves it,
 *  keeping the reflection a soft, near-neutral highlight rather than a color cast. */
const SATURATION = 0.6;

/** Opacity of the secondary reflection (0..1). Real glass reflects once off the
 *  front surface and again off the back, the second bounce arriving flipped and
 *  fainter. We fake it by screen-blending a dimmed, 180-degree-flipped copy of
 *  the feed over itself. 0 disables it. */
const SECOND_REFLECTION_OPACITY = 0.8;

/** How much of the camera's central square we keep (1 = full square). A gentle
 *  crop frames the room in front of the screen rather than the far edges. */
const CROP_FRACTION = 1;

/** Overall reflection strength (0..1). Screen blend brightens fast, so this
 *  keeps it a highlight rather than a mirror. */
const REFLECT_INTENSITY = 0.9;

/** Direction sign. -1 samples the OPPOSITE of the rim's push (light coming from
 *  the far side, as the original spec described); flip to 1 to sample with it. */
const DIR_SIGN = -1;

// ---- Light-driven shadows ----
// A drop shadow is a matte convolved with a blur kernel. Here we convolve the
// (flipped, clamped) camera light field with each element's own rounded-rect
// matte used AS the kernel: the result is a shadow that falls on the side away
// from the brightest part of the room. It rides in each Refract's own shadow
// layer (z-index:-1), because glass elements live in many stacking contexts and
// no single under-canvas could sit behind all of them.

/** Resolution of the square light field the shadow convolves against. Small: the
 *  shadow is soft and low-frequency, so a coarse map is plenty and keeps the
 *  per-texel gather loop cheap. */
const LIGHT_SIZE = 48; /* LIGHT_SOURCE_SIZE */

/** Black point (0..255) for the shadow's light field. Higher than the
 *  reflection's so only genuine highlights cast a shadow; everything else is 0
 *  and skipped in the gather. */
const SHADOW_BLACK_POINT = 170;

/** Largest distance (css px) a fully off-center light pushes the shadow. */
const SHADOW_SPREAD = 36;

/** The shadow is blurry, so it is rendered at 1/N the footprint and stretched
 *  back up by CSS. Cuts fill cost sharply. */
const SHADOW_DOWNSCALE = 4;

/** Cap on either rendered dimension, so a huge element cannot blow up fill cost. */
const SHADOW_MAX_TEX = 160;

/** Scales the accumulated light-times-coverage into an alpha. Brighter rooms
 *  therefore cast darker shadows (the coupling the effect is named for). */
const SHADOW_STRENGTH = 0.04;

/** Ceiling on shadow darkness so it stays a shadow, not a black blob. */
const SHADOW_MAX_ALPHA = 0.6;

/** Shadows refresh slower than reflections; they change little frame to frame. */
const SHADOW_FPS = 30;

/** Sign of the light-to-shadow direction. -1 = shadow opposite the light (the
 *  H+V flip of the light field). Flip to 1 to throw the shadow toward the light. */
const SHADOW_FLIP = -1;

interface Entry {
  el: HTMLElement;
  mapCanvas: HTMLCanvasElement | null;
  radius: number;
  tex: WebGLTexture | null;
  dirty: boolean;
  shadowCanvas: HTMLCanvasElement | null;
  shadowCtx: CanvasRenderingContext2D | null;
}

// Shadow pass: a full-quad shader that convolves the light field with this
// element's rounded-rect matte (evaluated analytically, so no kernel texture).
// For each output pixel it gathers over the LIGHT_SIZE^2 light texels, shifting
// the matte opposite each lit texel's direction; the accumulated coverage is the
// shadow's alpha. Rendered into an offscreen GL canvas, then copied per element.
//
// The .frag declares `const int N = __LIGHT_SIZE__;` as a placeholder (GLSL loop
// bounds must be compile-time constants); we bake the real value in here so the
// file stays valid, highlightable GLSL rather than a template string.
const SHADOW_FRAG = SHADOW_FRAG_SRC.replace(/__LIGHT_SIZE__/g, String(LIGHT_SIZE));

function compile(gl: WebGLRenderingContext, type: number, src: string) {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  // A failed compile otherwise draws nothing with no hint why (the effect just
  // silently disappears), so log it for the developer console.
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("Shader failed to compile:", gl.getShaderInfoLog(sh), src);
  }
  return sh;
}

function makeTexture(gl: WebGLRenderingContext) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

export function CameraReflectionProvider({ children }: { children: ReactNode }) {
  const entries = useRef<Map<string, Entry>>(new Map());
  const glRef = useRef<WebGLRenderingContext | null>(null);
  // Textures whose entry was removed; deleted on the next frame on the GL thread.
  const deadTex = useRef<WebGLTexture[]>([]);

  const register = useCallback((id: string, el: HTMLElement) => {
    const existing = entries.current.get(id);
    if (existing) existing.el = el;
    else
      entries.current.set(id, {
        el,
        mapCanvas: null,
        radius: 0,
        tex: null,
        dirty: false,
        shadowCanvas: null,
        shadowCtx: null,
      });
  }, []);

  const setShadowCanvas = useCallback(
    (id: string, canvas: HTMLCanvasElement | null) => {
      const e = entries.current.get(id);
      if (!e) return;
      e.shadowCanvas = canvas;
      e.shadowCtx = canvas ? canvas.getContext("2d") : null;
    },
    []
  );

  const setMap = useCallback(
    (id: string, mapCanvas: HTMLCanvasElement, radius: number) => {
      const e = entries.current.get(id);
      if (!e) return;
      e.mapCanvas = mapCanvas;
      e.radius = radius;
      e.dirty = true;
    },
    []
  );

  const unregister = useCallback((id: string) => {
    const e = entries.current.get(id);
    if (e?.tex) deadTex.current.push(e.tex);
    entries.current.delete(id);
  }, []);

  useEffect(() => {
    const canvas = document.createElement("canvas");
    Object.assign(canvas.style, {
      position: "fixed",
      inset: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      zIndex: "2147483000",
      mixBlendMode: "screen",
    } as CSSStyleDeclaration);
    canvas.setAttribute("aria-hidden", "true");
    document.body.appendChild(canvas);

    const gl = canvas.getContext("webgl", {
      premultipliedAlpha: false,
      alpha: true,
      antialias: false,
    });
    if (!gl) {
      canvas.remove();
      return;
    }
    glRef.current = gl;

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    // Two triangles over the unit square (0,0)-(1,1).
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
      gl.STATIC_DRAW
    );
    const aUnit = gl.getAttribLocation(prog, "aUnit");
    gl.enableVertexAttribArray(aUnit);
    gl.vertexAttribPointer(aUnit, 2, gl.FLOAT, false, 0, 0);

    const uPos = gl.getUniformLocation(prog, "uPos");
    const uMap = gl.getUniformLocation(prog, "uMap");
    const uCam = gl.getUniformLocation(prog, "uCam");
    const uBox = gl.getUniformLocation(prog, "uBox");
    const uRadius = gl.getUniformLocation(prog, "uRadius");
    const uIntensity = gl.getUniformLocation(prog, "uIntensity");
    const uDirSign = gl.getUniformLocation(prog, "uDirSign");
    const uBlackPoint = gl.getUniformLocation(prog, "uBlackPoint");
    const uSaturation = gl.getUniformLocation(prog, "uSaturation");

    gl.uniform1i(uMap, 0);
    gl.uniform1i(uCam, 1);
    gl.uniform1f(uIntensity, REFLECT_INTENSITY);
    gl.uniform1f(uDirSign, DIR_SIGN);
    gl.uniform1f(uBlackPoint, BLACK_POINT / 255);
    gl.uniform1f(uSaturation, SATURATION);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    // Camera texture + the 2D scratch canvas that mirrors/blurs each frame.
    const camTex = makeTexture(gl);
    const camScratch = document.createElement("canvas");
    camScratch.width = CAM_SIZE;
    camScratch.height = CAM_SIZE;
    const camCtx = camScratch.getContext("2d");

    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    let stream: MediaStream | null = null;
    let rafId: number | undefined;
    let cancelled = false;
    let camReady = false;

    // ---- Shadow pass: its own offscreen GL canvas so it never disturbs the
    // reflection canvas. Rendered at a fixed max size; each element uses a
    // viewport sub-rect, so the drawing buffer is never reallocated. ----
    const shadowGLCanvas = document.createElement("canvas");
    shadowGLCanvas.width = SHADOW_MAX_TEX;
    shadowGLCanvas.height = SHADOW_MAX_TEX;
    const sgl = shadowGLCanvas.getContext("webgl", {
      premultipliedAlpha: false,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true, // so drawImage can read the result out
    });
    const lightScratch = document.createElement("canvas");
    lightScratch.width = LIGHT_SIZE;
    lightScratch.height = LIGHT_SIZE;
    const lightCtx = lightScratch.getContext("2d");
    let lastShadow = 0;
    let sUElem: WebGLUniformLocation | null = null;
    let sURadius: WebGLUniformLocation | null = null;
    let sUBlackPoint: WebGLUniformLocation | null = null;
    let lightTex: WebGLTexture | null = null;

    if (sgl) {
      const sProg = sgl.createProgram()!;
      sgl.attachShader(sProg, compile(sgl, sgl.VERTEX_SHADER, SHADOW_VERT));
      sgl.attachShader(sProg, compile(sgl, sgl.FRAGMENT_SHADER, SHADOW_FRAG));
      sgl.linkProgram(sProg);
      sgl.useProgram(sProg);

      const sQuad = sgl.createBuffer();
      sgl.bindBuffer(sgl.ARRAY_BUFFER, sQuad);
      sgl.bufferData(
        sgl.ARRAY_BUFFER,
        new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]),
        sgl.STATIC_DRAW
      );
      const sAUnit = sgl.getAttribLocation(sProg, "aUnit");
      sgl.enableVertexAttribArray(sAUnit);
      sgl.vertexAttribPointer(sAUnit, 2, sgl.FLOAT, false, 0, 0);

      sUElem = sgl.getUniformLocation(sProg, "uElem");
      sURadius = sgl.getUniformLocation(sProg, "uRadius");
      sUBlackPoint = sgl.getUniformLocation(sProg, "uBlackPoint");
      sgl.uniform1i(sgl.getUniformLocation(sProg, "uLight"), 0);
      sgl.uniform1f(sgl.getUniformLocation(sProg, "uSpread"), SHADOW_SPREAD);
      sgl.uniform1f(sUBlackPoint, SHADOW_BLACK_POINT / 255);
      sgl.uniform1f(sgl.getUniformLocation(sProg, "uStrength"), SHADOW_STRENGTH);
      sgl.uniform1f(sgl.getUniformLocation(sProg, "uMaxAlpha"), SHADOW_MAX_ALPHA);
      sgl.uniform1f(sgl.getUniformLocation(sProg, "uFlip"), SHADOW_FLIP);
      sgl.enable(sgl.BLEND);
      sgl.blendFunc(sgl.SRC_ALPHA, sgl.ONE_MINUS_SRC_ALPHA);

      lightTex = makeTexture(sgl);
    }

    const renderShadows = (now: number) => {
      if (!sgl || !sUElem || !lightCtx || !lightTex) return;
      if (now - lastShadow < 1000 / SHADOW_FPS) return;
      if (video.readyState < 2 || video.videoWidth < 2) return;
      lastShadow = now;

      // Refresh the light field: a plain downsample of the feed (the H+V flip is
      // a sign in the shader). Uploaded unmirrored so directions stay physical.
      const vw2 = video.videoWidth;
      const vh2 = video.videoHeight;
      const side = Math.min(vw2, vh2) * CROP_FRACTION;
      const sx = (vw2 - side) / 2;
      const sy = (vh2 - side) / 2;
      lightCtx.clearRect(0, 0, LIGHT_SIZE, LIGHT_SIZE);
      // Mirror horizontally so the light field matches the room as seen on screen
      // (the raw webcam feed is left-right reversed).
      lightCtx.save();
      lightCtx.translate(LIGHT_SIZE, 0);
      lightCtx.scale(-1, 1);
      lightCtx.drawImage(video, sx, sy, side, side, 0, 0, LIGHT_SIZE, LIGHT_SIZE);
      lightCtx.restore();
      sgl.activeTexture(sgl.TEXTURE0);
      sgl.bindTexture(sgl.TEXTURE_2D, lightTex);
      sgl.texImage2D(
        sgl.TEXTURE_2D,
        0,
        sgl.RGBA,
        sgl.RGBA,
        sgl.UNSIGNED_BYTE,
        lightScratch
      );

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      for (const e of entries.current.values()) {
        if (!e.shadowCtx || !e.shadowCanvas || !e.el.isConnected) continue;
        const r = e.el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;

        const paddedW = r.width + 2 * SHADOW_SPREAD;
        const paddedH = r.height + 2 * SHADOW_SPREAD;
        let rw = Math.max(1, Math.round(paddedW / SHADOW_DOWNSCALE));
        let rh = Math.max(1, Math.round(paddedH / SHADOW_DOWNSCALE));
        const cap = Math.min(1, SHADOW_MAX_TEX / Math.max(rw, rh));
        rw = Math.max(1, Math.round(rw * cap));
        rh = Math.max(1, Math.round(rh * cap));

        // Render the element's shadow into the bottom-left rw x rh corner of the
        // offscreen buffer, at the given black point. The presented image has row
        // 0 at top, so the rendered corner ends up at source y = MAX - rh.
        const renderPass = (blackPoint: number) => {
          sgl.viewport(0, 0, rw, rh);
          sgl.clearColor(0, 0, 0, 0);
          sgl.clear(sgl.COLOR_BUFFER_BIT);
          sgl.uniform1f(sUBlackPoint, blackPoint / 255);
          sgl.uniform2f(sUElem, r.width, r.height);
          sgl.uniform1f(sURadius, Math.min(e.radius, r.width / 2, r.height / 2));
          sgl.drawArrays(sgl.TRIANGLES, 0, 6);
        };

        // Dark shadow: render at its own black point, copy out as-is.
        renderPass(SHADOW_BLACK_POINT);
        const dc = e.shadowCanvas;
        if (dc.width !== rw || dc.height !== rh) {
          dc.width = rw;
          dc.height = rh;
        }
        e.shadowCtx.clearRect(0, 0, rw, rh);
        e.shadowCtx.drawImage(
          shadowGLCanvas,
          0,
          SHADOW_MAX_TEX - rh,
          rw,
          rh,
          0,
          0,
          rw,
          rh
        );
      }
    };

    const drawCamera = () => {
      if (!camCtx || video.readyState < 2) return false;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (vw < 2 || vh < 2) return false;
      const side = Math.min(vw, vh) * CROP_FRACTION;
      const sx = (vw - side) / 2;
      const sy = (vh - side) / 2;
      camCtx.clearRect(0, 0, CAM_SIZE, CAM_SIZE);

      // Primary reflection: the mirrored, blurred feed.
      camCtx.save();
      camCtx.filter = `blur(${CAM_BLUR}px)`;
      camCtx.translate(CAM_SIZE, 0); // mirror horizontally
      camCtx.scale(-1, 1);
      camCtx.drawImage(video, sx, sy, side, side, 0, 0, CAM_SIZE, CAM_SIZE);
      camCtx.restore();

      // Secondary (back-surface) reflection: the same feed flipped both axes,
      // dimmed, screen-blended on top. Relative to the mirrored primary that is a
      // vertical flip (the horizontal flip cancels the primary's mirror).
      if (SECOND_REFLECTION_OPACITY > 0) {
        camCtx.save();
        camCtx.globalCompositeOperation = "screen";
        camCtx.globalAlpha = SECOND_REFLECTION_OPACITY;
        camCtx.filter = `blur(${CAM_BLUR}px)`;
        camCtx.translate(0, CAM_SIZE); // flip vertically
        camCtx.scale(1, -1);
        camCtx.drawImage(video, sx, sy, side, side, 0, 0, CAM_SIZE, CAM_SIZE);
        camCtx.restore();
      }
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, camTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, camScratch);
      return true;
    };

    const frame = (now: number) => {
      rafId = requestAnimationFrame(frame);

      for (const t of deadTex.current) gl.deleteTexture(t);
      deadTex.current.length = 0;

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const bw = Math.round(vw * dpr);
      const bh = Math.round(vh * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      gl.viewport(0, 0, bw, bh);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      if (!camReady) camReady = drawCamera();
      else drawCamera();

      // Shadows run on their own throttle and their own offscreen context.
      renderShadows(now);

      if (!camReady || entries.current.size === 0) return;

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, camTex);

      for (const e of entries.current.values()) {
        if (!e.mapCanvas || !e.el.isConnected) continue;
        const r = e.el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        if (r.right < 0 || r.bottom < 0 || r.left > vw || r.top > vh) continue;

        if (!e.tex) e.tex = makeTexture(gl);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, e.tex);
        if (e.dirty) {
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            e.mapCanvas
          );
          e.dirty = false;
        }

        // Rect -> clip space (y=0 at top of box maps to the box's top edge).
        const clipX = (r.left / vw) * 2 - 1;
        const clipYTop = 1 - (r.top / vh) * 2;
        const clipW = (r.width / vw) * 2;
        const clipH = -((r.height / vh) * 2);
        gl.uniform4f(uPos, clipX, clipYTop, clipW, clipH);
        gl.uniform2f(uBox, r.width, r.height);
        gl.uniform1f(uRadius, Math.min(e.radius, r.width / 2, r.height / 2));
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          stream = null;
          return;
        }
        video.srcObject = stream;
        await video.play().catch(() => {});
      } catch {
        // No camera, or access declined. The canvas keeps clearing to nothing.
      }
    })();

    rafId = requestAnimationFrame(frame);

    return () => {
      cancelled = true;
      if (rafId !== undefined) cancelAnimationFrame(rafId);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      glRef.current = null;
      canvas.remove();
      sgl?.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  const api = useMemo<ReflectionApi>(
    () => ({ register, setMap, setShadowCanvas, unregister }),
    [register, setMap, setShadowCanvas, unregister]
  );

  return (
    <ReflectionContext.Provider value={api}>
      {children}
    </ReflectionContext.Provider>
  );
}
