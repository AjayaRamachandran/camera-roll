import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ArrowLeft, Info, LayoutGrid } from "lucide-react";

import { Photo, isVideo, photoUrl, thumbUrl } from "@/lib/photoApi";
import { CellRect } from "./PhotoGrid";
import Filmstrip from "./Filmstrip";
import InfoPopover from "./InfoPopover";
import Refract from "./Refract";
import VideoScrubBar from "./VideoScrubBar";

interface PhotoDetailProps {
  photos: Photo[];
  startIndex: number;
  /** Screen rect of the grid cell the user opened, for the grow animation. */
  origin: CellRect;
  onClose: () => void;
  /** Reveal this photo within the full-library grid (by id), clearing search. */
  onShowFullGrid?: (photoId: string) => void;
  /** Return to the filtered results grid view. */
  onBackToResults?: () => void;
  /** Whether this detail view was opened from a filtered search result. */
  fromSearchResults?: boolean;
  /** Filter the gallery to a person, from a face in the info panel. */
  onSearchPerson?: (name: string) => void;
  /** Filter the gallery to a place, from the map in the info panel. */
  onSearchLocation?: (query: string) => void;
}

// Chrome insets so the photo never sits under the top controls or filmstrip.
const PAD_TOP = 52;
const PAD_BOTTOM = 88;
const PAD_X = 28;
const SWIPE_THRESHOLD = 80; // px of drag that commits to the next/prev photo
const ZOOM = 2.5; // scale factor for the double-click zoomed view
const MORPH =
  "left 340ms cubic-bezier(0.2,0,0,1), top 340ms cubic-bezier(0.2,0,0,1), width 340ms cubic-bezier(0.2,0,0,1), height 340ms cubic-bezier(0.2,0,0,1)";
// Docked info panel: width it claims on the right, and the shared easing for the
// nudge (image area shrinking, panel sliding in, top controls shifting left).
const INFO_WIDTH = 360;
const NUDGE = "340ms cubic-bezier(0.2,0,0,1)";

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
  onShowFullGrid,
  onBackToResults,
  fromSearchResults = false,
  onSearchPerson,
  onSearchLocation,
}: PhotoDetailProps) {
  const [index, setIndex] = useState(startIndex);
  const [phase, setPhase] = useState<Phase>("opening");
  const [showInfo, setShowInfo] = useState(false);
  // The <video> element of the current slide, when it is a video. A callback
  // ref keeps this pointed at whatever video is on screen, so the scrub bar
  // re-binds as you swipe between clips. Null whenever a photo is showing.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const currentIsVideo = isVideo(photos[index]);
  const startIsVideo = isVideo(photos[startIndex]);
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
  // Width left for the photo once the info panel is docked. Everything that
  // fits/positions the image works off this, so the photo shrinks to fit.
  const contentW = vw - (showInfo ? INFO_WIDTH : 0);
  const target = fitRect(photo, contentW, vh);

  // Preload the full images on either side so swiping never stutters waiting on
  // a decode. The browser caches them; mounting the neighbor slide is then free.
  useEffect(() => {
    const preloaded = [index - 2, index - 1, index + 1, index + 2]
      .filter((i) => i >= 0 && i < photos.length && !isVideo(photos[i]))
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
      setHeroRect(
        fitRect(photos[startIndex], window.innerWidth, window.innerHeight),
      );
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
        }),
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
    const r = fitRect(photo, contentW, vh);
    const maxX = Math.max(0, (r.width * ZOOM - contentW) / 2);
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

  // Center the track (slot for current photo) whenever index/size changes, or
  // when the steady view first mounts (phase -> "open"). Instant: a swipe-commit
  // lands here and must not animate back the other way.
  useLayoutEffect(() => {
    setTrack(-contentW, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vw, index, phase]);

  // Re-center with a transition when the info panel opens/closes, so the image
  // glides over as the panel makes room rather than jumping.
  useEffect(() => {
    setTrack(-contentW, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInfo]);

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
          panStart.current.y + (e.clientY - ptrStart.current.y),
        ),
      );
      return;
    }
    let d = e.clientX - startX.current;
    // Resist dragging past either end of the library.
    if ((d > 0 && !hasPrev) || (d < 0 && !hasNext)) d *= 0.35;
    dx.current = d;
    setTrack(-contentW + d, false);
  };
  const commitSwipe = (dir: 1 | -1) => {
    pendingDir.current = dir;
    // dir 1 = go to next (slide left), -1 = previous (slide right).
    setTrack(dir === 1 ? -2 * contentW : 0, true);
  };
  const onPointerUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    if (zoomed) return; // panning: nothing to commit
    const d = dx.current;
    if (d <= -SWIPE_THRESHOLD && hasNext) commitSwipe(1);
    else if (d >= SWIPE_THRESHOLD && hasPrev) commitSwipe(-1);
    else setTrack(-contentW, true); // snap back
  };
  const onTrackTransitionEnd = (e: React.TransitionEvent) => {
    // Only the track's own slide animation commits a navigation. Slide images
    // animate left/top/width/height/transform too, and those bubble up here;
    // acting on them would advance the index early (landing a photo off).
    if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
    if (pendingDir.current === 0) return;
    const dir = pendingDir.current;
    pendingDir.current = 0;
    setIndex((i) => Math.min(photos.length - 1, Math.max(0, i + dir)));
    // The index effect re-centers the track instantly to -vw.
  };

  // Wheel: horizontal scroll over the big image swipes like a trackpad.
  // One gesture only ever advances a single photo. A trackpad fling keeps
  // firing wheel events (plus momentum) long after the threshold is crossed,
  // so once we commit we stay locked until the gesture goes quiet.
  const wheelAccum = useRef(0);
  const wheelLocked = useRef(false);
  const wheelIdle = useRef<number | null>(null);
  const onWheel = (e: React.WheelEvent) => {
    if (phase !== "open" || zoomed) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
    if (delta === 0) return;

    // Reset the lock only after the gesture has fully settled (no horizontal
    // wheel events for a short window, momentum included). This MUST run even
    // while a swipe animation is mid-flight, otherwise the timer expires during
    // the slide and the trailing momentum from a fast fling commits a second
    // swipe. Every horizontal event keeps the current gesture alive.
    if (wheelIdle.current !== null) window.clearTimeout(wheelIdle.current);
    wheelIdle.current = window.setTimeout(() => {
      wheelLocked.current = false;
      wheelAccum.current = 0;
    }, 160);

    // Don't accumulate while a swipe is animating or while locked, but we still
    // refreshed the idle timer above so the lock holds until momentum stops.
    if (pendingDir.current !== 0 || wheelLocked.current) return;

    wheelAccum.current += delta;
    if (wheelAccum.current > 60 && hasNext) {
      wheelLocked.current = true;
      wheelAccum.current = 0;
      commitSwipe(1);
    } else if (wheelAccum.current < -60 && hasPrev) {
      wheelLocked.current = true;
      wheelAccum.current = 0;
      commitSwipe(-1);
    }
  };

  // When the view first opens, swallow any trackpad momentum that carried over
  // from scrolling the grid. Without this, the residual wheel events arrive the
  // instant we go interactive and immediately swipe to the next photo, so you
  // open photo N and land on N+1. The lock holds until the carried-over gesture
  // goes quiet (onWheel keeps pushing the idle timer out), or clears promptly if
  // there was no momentum at all.
  useEffect(() => {
    if (phase !== "open") return;
    wheelLocked.current = true;
    wheelAccum.current = 0;
    if (wheelIdle.current !== null) window.clearTimeout(wheelIdle.current);
    wheelIdle.current = window.setTimeout(() => {
      wheelLocked.current = false;
      wheelAccum.current = 0;
    }, 250);
  }, [phase]);

  // Keyboard: arrows navigate, Escape exits zoom (then closes), Alt+I toggles info.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (zoomed) {
          setZoomed(false);
          setPan({ x: 0, y: 0 });
        } else close();
      } else if (e.key === "ArrowRight" && hasNext) setIndex((i) => i + 1);
      else if (e.key === "ArrowLeft" && hasPrev) setIndex((i) => i - 1);
      else if (e.altKey && e.code === "KeyI") {
        e.preventDefault();
        setShowInfo((s) => !s);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, hasNext, hasPrev, zoomed]);

  // A slide: the full photo fitted, with its thumbnail as an instant placeholder.
  const slide = (i: number) => {
    const p = photos[i];
    if (!p)
      return <div className="h-screen shrink-0" style={{ width: contentW }} />;
    const r = fitRect(p, contentW, vh);
    // Only the current slide zooms/pans. Keep an identity transform on it even
    // when not zoomed so toggling animates the scale smoothly; panning drags
    // skip the transition so the image tracks the cursor.
    const isCurrent = i === index;
    const z = isCurrent && zoomed;
    const geom = {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
    };
    // Geometry transition mirrors the photo path so the info panel nudge glides.
    const geomTransition = isCurrent
      ? `left ${NUDGE}, top ${NUDGE}, width ${NUDGE}, height ${NUDGE}`
      : "none";

    let media: JSX.Element;
    if (isVideo(p)) {
      // The current clip is a real <video> the scrub bar drives; neighbors stay
      // as their poster frame so swiping previews them without extra decoders.
      media = isCurrent ? (
        <video
          ref={setVideoEl}
          src={photoUrl(p.id)}
          poster={thumbUrl(p.id)}
          autoPlay
          playsInline
          className="absolute object-contain"
          style={{
            ...geom,
            transform: `translate(${z ? pan.x : 0}px, ${z ? pan.y : 0}px) scale(${z ? ZOOM : 1})`,
            // Match the photo path: animate zoom + info-panel nudge, skip while
            // actively panning so the frame tracks the cursor.
            transition: !(zoomed && dragging.current)
              ? `transform 220ms cubic-bezier(0.2,0,0,1), left ${NUDGE}, top ${NUDGE}, width ${NUDGE}, height ${NUDGE}`
              : "none",
            cursor: zoomed ? "grab" : undefined,
          }}
        />
      ) : (
        <img
          src={thumbUrl(p.id)}
          alt=""
          draggable={false}
          className="absolute object-contain"
          style={{ ...geom, transition: geomTransition }}
        />
      );
    } else {
      media = (
        <img
          src={photoUrl(p.id)}
          alt=""
          draggable={false}
          className="absolute object-contain"
          style={{
            ...geom,
            transform: isCurrent
              ? `translate(${z ? pan.x : 0}px, ${z ? pan.y : 0}px) scale(${z ? ZOOM : 1})`
              : undefined,
            // Current image: animate both the zoom transform and, when the info
            // panel nudges it, the fitted geometry. Skip while actively panning.
            transition:
              isCurrent && !(zoomed && dragging.current)
                ? `transform 220ms cubic-bezier(0.2,0,0,1), left ${NUDGE}, top ${NUDGE}, width ${NUDGE}, height ${NUDGE}`
                : "none",
            cursor: zoomed && isCurrent ? "grab" : undefined,
          }}
        />
      );
    }

    return (
      <div
        className="h-screen shrink-0 relative"
        key={p.id}
        style={{ width: contentW, transition: `width ${NUDGE}` }}
      >
        {media}
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
            className="absolute left-0 top-0 bottom-0 overflow-hidden"
            style={{
              right: showInfo ? INFO_WIDTH : 0,
              transition: `right ${NUDGE}`,
            }}
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
              onTransitionEnd={onTrackTransitionEnd}
            >
              {slide(index - 1)}
              {slide(index)}
              {slide(index + 1)}
            </div>
          </div>

          {/* Back to search results: its own frosted pill in the top left,
              shown only when this photo was opened from a search result. */}
          {fromSearchResults && onBackToResults && (
            <Refract
              className="absolute z-30 flex items-center rounded-full px-1 py-1"
              style={{
                top: "calc(var(--titlebar-height, 36px) + 8px)",
                left: 12,
                transition: `transform 0.12s ease, --refract-gb 0.08s ease`,
              }}
            >
              <button
                type="button"
                aria-label="Back to search results"
                onClick={onBackToResults}
                className="grid place-items-center rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              >
                <ArrowLeft size={18} />
              </button>
            </Refract>
          )}

          {/* Top controls: info + grid, in a frosted pill like the zoom
              stepper. Offset below the window title bar. */}
          <Refract
            className="absolute z-30 flex items-center gap-1 rounded-full px-1 py-1"
            style={{
              top: "calc(var(--titlebar-height, 36px) + 8px)",
              right: (showInfo ? INFO_WIDTH : 0) + 12,
              // Keep the info-panel push plus the glass hover lean/brighten.
              transition: `right ${NUDGE}, transform 0.12s ease, --refract-gb 0.08s ease`,
            }}
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
              aria-label={
                fromSearchResults ? "Show this photo in all photos" : "Back to grid"
              }
              onClick={
                fromSearchResults ? () => onShowFullGrid?.(photo.id) : close
              }
              className="grid place-items-center rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <LayoutGrid size={18} />
            </button>
          </Refract>

          {/* Docked info panel: slides in from the right and claims its width,
              which shrinks the photo area (above) to match. */}
          <div
            className="absolute right-0 top-0 bottom-0 z-20"
            style={{
              width: INFO_WIDTH,
              transform: showInfo ? "translateX(0)" : "translateX(100%)",
              transition: `transform ${NUDGE}`,
              pointerEvents: showInfo ? "auto" : "none",
            }}
            aria-hidden={!showInfo}
          >
            <InfoPopover
              photo={photo}
              onSearchPerson={onSearchPerson}
              onSearchLocation={onSearchLocation}
            />
          </div>

          {/* Floating scrub controls for the current video, centered over the
              photo area and sitting just above the filmstrip. */}
          {currentIsVideo && (
            <div
              className="absolute z-30 flex justify-center"
              style={{
                left: 0,
                right: showInfo ? INFO_WIDTH : 0,
                bottom: 96,
                transition: `right ${NUDGE}`,
              }}
            >
              <VideoScrubBar video={videoEl} />
            </div>
          )}

          <Filmstrip
            photos={photos}
            current={index}
            rightInset={showInfo ? INFO_WIDTH : 0}
            onPick={(i) => setIndex(i)}
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
          {/* Videos have no full still to crossfade to; the thumbnail morphs
              into place and the real <video> takes over once the view opens. */}
          {!startIsVideo && (
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
          )}
        </div>
      )}
    </div>
  );
}
