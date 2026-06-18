import { useCallback, useEffect, useRef, useState } from "react";

import { Info, LayoutGrid } from "lucide-react";

import { Photo, photoUrl, thumbUrl } from "@/lib/photoApi";
import { CellRect } from "./PhotoGrid";
import Filmstrip from "./Filmstrip";
import InfoPopover from "./InfoPopover";

interface PhotoDetailProps {
  photos: Photo[];
  startIndex: number;
  /** Screen rect of the grid cell the user opened, for the grow animation. */
  origin: CellRect;
  onClose: () => void;
}

// Chrome insets so the photo never sits under the top controls or filmstrip.
const PAD_TOP = 52;
const PAD_BOTTOM = 88;
const PAD_X = 28;
const SWIPE_THRESHOLD = 80; // px of drag that commits to the next/prev photo
const ZOOM = 2.5; // scale factor for the double-click zoomed view
const MORPH = "left 340ms cubic-bezier(0.2,0,0,1), top 340ms cubic-bezier(0.2,0,0,1), width 340ms cubic-bezier(0.2,0,0,1), height 340ms cubic-bezier(0.2,0,0,1)";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Fit a photo's aspect ratio into the available (padded) window area. */
function fitRect(photo: Photo, vw: number, vh: number): Rect {
  const availW = vw - 2 * PAD_X;
  const availH = vh - PAD_TOP - PAD_BOTTOM;
  const aspect = photo.width && photo.height ? photo.width / photo.height : 1;
  let w = availW;
  let h = w / aspect;
  if (h > availH) {
    h = availH;
    w = h * aspect;
  }
  return {
    width: w,
    height: h,
    left: (vw - w) / 2,
    top: PAD_TOP + (availH - h) / 2,
  };
}

type Phase = "opening" | "open" | "closing";

/**
 * Full-screen photo view. Opens by growing the thumbnail out of its grid cell
 * and crossfading into the real photo, then supports swiping between photos,
 * a running filmstrip, and a metadata popover.
 */
export default function PhotoDetail({
  photos,
  startIndex,
  origin,
  onClose,
}: PhotoDetailProps) {
  const [index, setIndex] = useState(startIndex);
  const [phase, setPhase] = useState<Phase>("opening");
  const [showInfo, setShowInfo] = useState(false);
  const [vw, setVw] = useState(window.innerWidth);
  const [vh, setVh] = useState(window.innerHeight);

  // Track window size so the fit math stays correct on resize/maximize.
  useEffect(() => {
    const onResize = () => {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const photo = photos[index];
  const target = fitRect(photo, vw, vh);

  // Preload the full images on either side so swiping never stutters waiting on
  // a decode. The browser caches them; mounting the neighbor slide is then free.
  useEffect(() => {
    const preloaded = [index - 2, index - 1, index + 1, index + 2]
      .filter((i) => i >= 0 && i < photos.length)
      .map((i) => {
        const im = new Image();
        im.src = photoUrl(photos[i].id);
        return im;
      });
    return () => {
      preloaded.forEach((im) => (im.src = ""));
    };
  }, [index, photos]);

  // ---- Open / close hero morph ------------------------------------------ //
  const [heroRect, setHeroRect] = useState<Rect>({
    left: origin.left,
    top: origin.top,
    width: origin.size,
    height: origin.size,
  });
  const [heroAnimating, setHeroAnimating] = useState(false);
  const [fullLoaded, setFullLoaded] = useState(false);

  // Kick the open morph on the next frame so the transition actually runs.
  useEffect(() => {
    if (phase !== "opening") return;
    const id = requestAnimationFrame(() => {
      setHeroAnimating(true);
      setHeroRect(fitRect(photos[startIndex], window.innerWidth, window.innerHeight));
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(() => {
    if (phase === "closing") return;
    // Morph back to the originating cell only when we are still on the photo we
    // opened; after swiping, just fade the whole view away.
    if (index === startIndex) {
      setPhase("closing");
      setHeroRect(target);
      requestAnimationFrame(() =>
        setHeroRect({
          left: origin.left,
          top: origin.top,
          width: origin.size,
          height: origin.size,
        })
      );
    } else {
      setPhase("closing");
      setTimeout(onClose, 200);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, index, startIndex, target, origin, onClose]);

  // ---- Zoom / pan -------------------------------------------------------- //
  // Double-click toggles a zoomed view of the current photo; while zoomed,
  // dragging pans instead of swiping. Pan is in screen px, applied as a
  // translate on top of the scale.
  const [zoomed, setZoomed] = useState(false);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panStart = useRef({ x: 0, y: 0 });
  const ptrStart = useRef({ x: 0, y: 0 });

  // Reset zoom whenever we move to a different photo.
  useEffect(() => {
    setZoomed(false);
    setPan({ x: 0, y: 0 });
  }, [index]);

  // Clamp a pan offset so the scaled image can't be dragged off its own edges.
  const clampPan = (x: number, y: number) => {
    const r = fitRect(photo, vw, vh);
    const maxX = Math.max(0, (r.width * ZOOM - vw) / 2);
    const maxY = Math.max(0, (r.height * ZOOM - vh) / 2);
    return {
      x: Math.min(maxX, Math.max(-maxX, x)),
      y: Math.min(maxY, Math.max(-maxY, y)),
    };
  };

  const toggleZoom = () => {
    setPan({ x: 0, y: 0 });
    setZoomed((z) => !z);
  };

  // ---- Swipe track ------------------------------------------------------- //
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startX = useRef(0);
  const dx = useRef(0);
  const pendingDir = useRef<0 | 1 | -1>(0);

  const setTrack = (translate: number, animate: boolean) => {
    const el = trackRef.current;
    if (!el) return;
    el.style.transition = animate
      ? "transform 300ms cubic-bezier(0.2,0,0,1)"
      : "none";
    el.style.transform = `translateX(${translate}px)`;
  };

  // Center the track (slot for current photo) whenever index/size changes.
  useEffect(() => {
    setTrack(-vw, false);
  }, [vw, index]);

  const hasPrev = index > 0;
  const hasNext = index < photos.length - 1;

  const onPointerDown = (e: React.PointerEvent) => {
    if (phase !== "open") return;
    dragging.current = true;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (zoomed) {
      ptrStart.current = { x: e.clientX, y: e.clientY };
      panStart.current = pan;
      return;
    }
    startX.current = e.clientX;
    dx.current = 0;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    if (zoomed) {
      setPan(
        clampPan(
          panStart.current.x + (e.clientX - ptrStart.current.x),
          panStart.current.y + (e.clientY - ptrStart.current.y)
        )
      );
      return;
    }
    let d = e.clientX - startX.current;
    // Resist dragging past either end of the library.
    if ((d > 0 && !hasPrev) || (d < 0 && !hasNext)) d *= 0.35;
    dx.current = d;
    setTrack(-vw + d, false);
  };
  const commitSwipe = (dir: 1 | -1) => {
    pendingDir.current = dir;
    // dir 1 = go to next (slide left), -1 = previous (slide right).
    setTrack(dir === 1 ? -2 * vw : 0, true);
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (zoomed) return; // panning: nothing to commit
    const d = dx.current;
    if (d <= -SWIPE_THRESHOLD && hasNext) commitSwipe(1);
    else if (d >= SWIPE_THRESHOLD && hasPrev) commitSwipe(-1);
    else setTrack(-vw, true); // snap back
  };
  const onTrackTransitionEnd = () => {
    if (pendingDir.current === 0) return;
    const dir = pendingDir.current;
    pendingDir.current = 0;
    setIndex((i) => Math.min(photos.length - 1, Math.max(0, i + dir)));
    // The index effect re-centers the track instantly to -vw.
  };

  // Wheel: horizontal scroll over the big image swipes like a trackpad.
  const wheelAccum = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    if (phase !== "open" || pendingDir.current !== 0 || zoomed) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
    if (delta === 0) return;
    wheelAccum.current += delta;
    if (wheelAccum.current > 60 && hasNext) {
      wheelAccum.current = 0;
      commitSwipe(1);
    } else if (wheelAccum.current < -60 && hasPrev) {
      wheelAccum.current = 0;
      commitSwipe(-1);
    }
  };

  // Keyboard: arrows navigate, Escape exits zoom (then closes), i toggles info.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (zoomed) {
          setZoomed(false);
          setPan({ x: 0, y: 0 });
        } else close();
      } else if (e.key === "ArrowRight" && hasNext) setIndex((i) => i + 1);
      else if (e.key === "ArrowLeft" && hasPrev) setIndex((i) => i - 1);
      else if (e.key.toLowerCase() === "i") setShowInfo((s) => !s);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, hasNext, hasPrev, zoomed]);

  // A slide: the full photo fitted, with its thumbnail as an instant placeholder.
  const slide = (i: number) => {
    const p = photos[i];
    if (!p) return <div className="w-screen h-screen shrink-0" />;
    const r = fitRect(p, vw, vh);
    // Only the current slide zooms/pans. Keep an identity transform on it even
    // when not zoomed so toggling animates the scale smoothly; panning drags
    // skip the transition so the image tracks the cursor.
    const isCurrent = i === index;
    const z = isCurrent && zoomed;
    return (
      <div className="w-screen h-screen shrink-0 relative" key={p.id}>
        <img
          src={photoUrl(p.id)}
          alt=""
          draggable={false}
          className="absolute object-contain"
          style={{
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
            transform: isCurrent
              ? `translate(${z ? pan.x : 0}px, ${z ? pan.y : 0}px) scale(${z ? ZOOM : 1})`
              : undefined,
            transition:
              isCurrent && !(zoomed && dragging.current)
                ? "transform 220ms cubic-bezier(0.2,0,0,1)"
                : "none",
            cursor: zoomed && isCurrent ? "grab" : undefined,
          }}
        />
      </div>
    );
  };

  // The hero morph shows on open, and on close only when we are morphing back
  // to the originating cell (same photo). A swiped-then-closed exit just fades.
  const heroVisible =
    phase === "opening" || (phase === "closing" && index === startIndex);

  return (
    <div
      className="detail-backdrop"
      style={{
        opacity: phase === "closing" ? 0 : 1,
        transition: "opacity 320ms ease",
      }}
      onClick={(e) => {
        // Click on the empty backdrop (not the photo or chrome) closes.
        if (e.target === e.currentTarget) close();
      }}
    >
      {/* Steady, interactive view (mounted once the open morph finishes). */}
      {phase !== "opening" && (
        <>
          <div
            className="absolute inset-0 overflow-hidden"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={toggleZoom}
            onWheel={onWheel}
          >
            <div
              ref={trackRef}
              className="flex h-full"
              style={{ transform: `translateX(${-vw}px)` }}
              onTransitionEnd={onTrackTransitionEnd}
            >
              {slide(index - 1)}
              {slide(index)}
              {slide(index + 1)}
            </div>
          </div>

          {/* Top controls: info + back-to-grid, in a frosted pill like the zoom
              stepper. Offset below the window title bar. */}
          <div
            className="absolute right-3 z-10 flex items-center gap-1 rounded-full frosted-glass px-1.5 py-1"
            style={{ top: "calc(var(--titlebar-height, 36px) + 8px)" }}
          >
            <button
              type="button"
              aria-label="Photo details"
              onClick={() => setShowInfo((s) => !s)}
              className="grid place-items-center rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Info size={18} />
            </button>
            <button
              type="button"
              aria-label="Back to grid"
              onClick={close}
              className="grid place-items-center rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <LayoutGrid size={18} />
            </button>
          </div>

          {showInfo && (
            <div
              className="absolute right-3 z-20"
              style={{ top: "calc(var(--titlebar-height, 36px) + 48px)" }}
            >
              <InfoPopover photo={photo} photoRect={target} />
            </div>
          )}

          <Filmstrip
            photos={photos}
            current={index}
            onPick={(i) => {
              setShowInfo(false);
              setIndex(i);
            }}
          />
        </>
      )}

      {/* Hero morph layer for the open/close grow + crossfade. */}
      {heroVisible && (
        <div
          className="hero-layer"
          style={{
            left: heroRect.left,
            top: heroRect.top,
            width: heroRect.width,
            height: heroRect.height,
            transition: heroAnimating ? MORPH : "none",
          }}
          onTransitionEnd={(e) => {
            if (e.propertyName !== "width") return;
            if (phase === "opening") setPhase("open");
            else if (phase === "closing") onClose();
          }}
        >
          <img
            src={thumbUrl(photos[startIndex].id)}
            alt=""
            draggable={false}
            className="hero-img object-cover"
            style={{
              opacity: fullLoaded ? 0 : 1,
              transition: "opacity 260ms ease",
            }}
          />
          <img
            src={photoUrl(photos[startIndex].id)}
            alt=""
            draggable={false}
            onLoad={() => setFullLoaded(true)}
            className="hero-img object-contain"
            style={{
              opacity: fullLoaded ? 1 : 0,
              transition: "opacity 260ms ease",
            }}
          />
        </div>
      )}
    </div>
  );
}
