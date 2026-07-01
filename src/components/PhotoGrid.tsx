import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { IndexData, getLibraries, isVideo, megatileUrl } from "@/lib/photoApi";
import PlayBadge from "./PlayBadge";
import ZoomStepper from "./ZoomStepper";

/** Screen rectangle of a single grid cell, used to animate the open transition. */
export interface CellRect {
  left: number;
  top: number;
  size: number;
}

interface PhotoGridProps {
  index: IndexData;
  /** Optional photo index to scroll into view when the full library is shown. */
  focusIndex?: number | null;
  /** Opens the photo at `photoIndex`, growing from the clicked cell. */
  onOpen: (photoIndex: number, origin: CellRect) => void;
}

const ZOOM_MS = 340;
const ZOOM_EASE = "cubic-bezier(0.2,0,0,1)";

/** What to apply (imperatively) right after a zoom level switches. */
interface PendingZoom {
  ratio: number;
  origin: { x: number; y: number };
  scrollTop: number;
}

/**
 * The photo grid.
 *
 * Each mega-tile spans the full window width and stacks vertically. The active
 * zoom level (grid dimension) controls how many photos each tile packs; the
 * stepper at the bottom switches levels. Only rows in view are in the DOM.
 *
 * The native scrollbar is hidden and replaced with a thin overlay thumb that
 * fades in while scrolling and on hover. Because there is no scrollbar gutter,
 * tiles truly fill edge to edge.
 *
 * Switching levels keeps the photo under the viewport center anchored in place
 * and runs a scale animation out of that photo. The same anchor logic runs on
 * window resize so the viewed content stays put with no jitter.
 */
export default function PhotoGrid({
  index,
  focusIndex,
  onOpen,
}: PhotoGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  // Name of the library currently being viewed, shown in the top overlay.
  const [libraryName, setLibraryName] = useState("");
  useEffect(() => {
    getLibraries()
      .then((libs) => setLibraryName(libs.find((l) => l.current)?.name ?? ""))
      .catch(() => setLibraryName(""));
  }, []);

  const levels = index.tile_grids;
  const [grid, setGrid] = useState(levels[0]);
  const capacity = grid * grid;
  const nTiles = Math.ceil(index.count / capacity);

  // Refs so ResizeObserver callbacks see current values without stale closures.
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const prevWidthRef = useRef(0);

  // Zoom animation state.
  const [scale, setScale] = useState(1);
  const [scaleTransition, setScaleTransition] = useState(false);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const pending = useRef<PendingZoom | null>(null);

  // Overlay scrollbar visibility.
  const [isScrolling, setIsScrolling] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  // iOS-style: the bar thickens when the pointer nears the right edge, and
  // lightens when the pointer is directly over it (or dragging).
  const [nearEdge, setNearEdge] = useState(false);
  const [thumbHover, setThumbHover] = useState(false);
  const scrollTimerRef = useRef<number>();

  // How close (px) the pointer must get to the right edge to expand the bar.
  const NEAR_EDGE_PX = 56;

  // Each tile spans the full width; tiles stack one per row.
  const tileSize = width;
  const cellSize = tileSize / grid;
  const nRows = nTiles; // one tile per row
  const totalHeight = nRows * tileSize;

  // Measure the scroll container and anchor on resize.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const measure = () => {
      const newW = el.clientWidth;
      const newVP = el.clientHeight;
      const prevW = prevWidthRef.current;

      if (prevW > 0 && newW !== prevW) {
        const g = gridRef.current;
        const cap = g * g;
        const prevCS = prevW / g; // cellSize in old layout
        const st = el.scrollTop;

        // Find the photo under the viewport center in the old layout.
        const centerY = st + newVP / 2;
        const tileIdx = Math.max(0, Math.floor(centerY / prevW));
        const cr = Math.max(
          0,
          Math.min(g - 1, Math.floor((centerY - tileIdx * prevW) / prevCS)),
        );
        const focal = Math.min(
          index.count - 1,
          Math.max(0, tileIdx * cap + cr * g),
        );
        const focalScreenY = tileIdx * prevW + cr * prevCS + prevCS / 2 - st;

        // Place that photo at the same screen position in the new layout.
        const newCS = newW / g;
        const newTileIdx = Math.floor(focal / cap);
        const within = focal % cap;
        const nCr = Math.floor(within / g);
        const focalY = newTileIdx * newW + nCr * newCS + newCS / 2;
        const newNRows = Math.ceil(index.count / cap);
        const maxST = Math.max(0, newNRows * newW - newVP);
        const newST = Math.min(maxST, Math.max(0, focalY - focalScreenY));

        el.scrollTop = newST;
        setScrollTop(newST);
      }

      prevWidthRef.current = newW;
      setWidth(newW);
      setViewport(newVP);
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [index.count]);

  // Track scroll position and show the overlay scrollbar while scrolling.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      setScrollTop(el.scrollTop);
      setIsScrolling(true);
      clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = window.setTimeout(
        () => setIsScrolling(false),
        1500,
      );
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useLayoutEffect(() => {
    if (
      focusIndex === null ||
      focusIndex === undefined ||
      focusIndex < 0 ||
      focusIndex >= index.count
    ) {
      return;
    }
    const el = scrollRef.current;
    if (!el || tileSize <= 0 || viewport <= 0) return;

    const row = Math.floor(focusIndex / capacity);
    const within = focusIndex % capacity;
    const cr = Math.floor(within / grid);
    const targetY = row * tileSize + cr * cellSize + cellSize / 2;
    const maxScrollTop = Math.max(0, totalHeight - viewport);
    const nextScrollTop = Math.min(
      maxScrollTop,
      Math.max(0, targetY - viewport / 2),
    );

    if (Math.abs(el.scrollTop - nextScrollTop) > 1) {
      el.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
    }
  }, [
    focusIndex,
    index.count,
    capacity,
    cellSize,
    grid,
    tileSize,
    totalHeight,
    viewport,
  ]);

  // After a level switch, re-anchor the scroll and play the zoom.
  useLayoutEffect(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;

    const el = scrollRef.current;
    if (el) el.scrollTop = p.scrollTop;
    setScrollTop(p.scrollTop);
    setOrigin(p.origin);
    setScaleTransition(false);
    setScale(p.ratio);

    const id = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        setScaleTransition(true);
        setScale(1);
      }),
    );
    return () => cancelAnimationFrame(id);
  }, [grid]);

  const changeGrid = (next: number) => {
    if (next === grid || tileSize <= 0) return;

    const oldCell = cellSize;
    const newCell = tileSize / next;

    // Photo under the viewport center is the zoom anchor.
    const centerY = scrollTop + viewport / 2;
    const row = Math.floor(centerY / tileSize);
    const cr = Math.min(
      grid - 1,
      Math.floor((centerY - row * tileSize) / oldCell),
    );
    const cc = Math.min(grid - 1, Math.floor(width / 2 / oldCell));
    let focal = row * capacity + cr * grid + cc;
    focal = Math.min(index.count - 1, Math.max(0, focal));

    const focalScreenY =
      row * tileSize + cr * oldCell + oldCell / 2 - scrollTop;

    const newCap = next * next;
    const nTile = Math.floor(focal / newCap);
    const within = focal % newCap;
    const ncr = Math.floor(within / next);
    const ncc = within % next;
    const focalX = ncc * newCell + newCell / 2;
    const focalY = nTile * tileSize + ncr * newCell + newCell / 2;

    const newRows = Math.ceil(index.count / newCap);
    const maxScroll = Math.max(0, newRows * tileSize - viewport);
    const newScrollTop = Math.min(
      maxScroll,
      Math.max(0, focalY - focalScreenY),
    );

    pending.current = {
      ratio: oldCell / newCell,
      origin: { x: focalX, y: focalY },
      scrollTop: newScrollTop,
    };
    setGrid(next);
  };

  // Visible rows plus one buffer row on each side.
  const firstRow =
    tileSize > 0 ? Math.max(0, Math.floor(scrollTop / tileSize) - 1) : 0;
  const lastRow =
    tileSize > 0
      ? Math.min(nRows - 1, Math.ceil((scrollTop + viewport) / tileSize) + 1)
      : 0;

  // Date of the topmost visible cell-row. Each megatile stacks `grid` cell-rows
  // of `cellSize` each, so key off cell-rows (not whole tiles) to update as each
  // row scrolls past.
  let dateLabel = "";
  if (cellSize > 0 && index.count > 0) {
    const totalCellRows = Math.ceil(index.count / grid);
    const topCellRow = Math.min(
      totalCellRows - 1,
      Math.max(0, Math.floor(scrollTop / cellSize)),
    );
    const firstPhotoIdx = Math.min(index.count - 1, topCellRow * grid);
    const taken = index.photos[firstPhotoIdx]?.taken;
    if (taken) {
      const d = new Date(taken);
      if (!isNaN(d.getTime())) {
        dateLabel = d.toLocaleString(undefined, {
          month: "long",
          day: "numeric",
          year: "numeric",
        });
      }
    }
  }

  // Overlay scrollbar geometry.
  const showScrollbar = isScrolling || isHovered || isDragging;
  const thumbH =
    totalHeight > viewport
      ? Math.max(32, (viewport / totalHeight) * viewport)
      : 0;
  const thumbTop =
    totalHeight > viewport
      ? (scrollTop / (totalHeight - viewport)) * (viewport - thumbH)
      : 0;

  // Track pointer proximity to the right edge to expand the bar. Bail out of
  // the state update unless the near/far state actually flips, so plain mouse
  // movement over the grid doesn't re-render every frame.
  const onGridMouseMove = (e: React.MouseEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const near = rect.right - e.clientX < NEAR_EDGE_PX;
    setNearEdge((prev) => (prev === near ? prev : near));
  };

  // Expanded (thicker) when the pointer is near the edge, over the bar, or
  // dragging. Lightened only when the pointer is actually on the bar / dragging.
  const barActive = nearEdge || thumbHover || isDragging;
  const barLit = thumbHover || isDragging;

  const onThumbMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startST = scrollRef.current?.scrollTop ?? 0;
    const track = viewport - thumbH;
    setIsDragging(true);

    const onMove = (mv: MouseEvent) => {
      if (!scrollRef.current || track <= 0) return;
      const dy = mv.clientY - startY;
      const newST = Math.max(
        0,
        Math.min(
          totalHeight - viewport,
          startST + (dy * (totalHeight - viewport)) / track,
        ),
      );
      scrollRef.current.scrollTop = newST;
    };
    const onUp = () => {
      setIsDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // A small play marker overlaid on the bottom-left of every visible video
  // cell. The mega-tiles are flat composed images, so videos are marked here in
  // the DOM. These live inside the scaled container with the tiles, so they
  // grow/shrink with the zoom animation instead of drifting.
  const badgeSize = Math.max(12, Math.min(30, cellSize * 0.16));
  const badgePad = Math.max(4, cellSize * 0.06);
  const videoBadges: JSX.Element[] = [];
  if (tileSize > 0) {
    for (let row = firstRow; row <= lastRow; row++) {
      if (row >= nTiles) break;
      for (let cell = 0; cell < capacity; cell++) {
        const photoIndex = row * capacity + cell;
        if (photoIndex >= index.count) break;
        const p = index.photos[photoIndex];
        if (!p || !isVideo(p)) continue;
        const cr = Math.floor(cell / grid);
        const cc = cell % grid;
        videoBadges.push(
          <div
            key={p.id}
            className="pointer-events-none absolute"
            style={{
              left: cc * cellSize + badgePad,
              top: row * tileSize + (cr + 1) * cellSize - badgeSize - badgePad,
            }}
          >
            <PlayBadge size={badgeSize} />
          </div>,
        );
      }
    }
  }

  const tiles: JSX.Element[] = [];
  if (tileSize > 0) {
    for (let row = firstRow; row <= lastRow; row++) {
      if (row >= nTiles) break;
      tiles.push(
        <img
          key={row}
          src={megatileUrl(grid, row)}
          alt=""
          draggable={false}
          loading="lazy"
          className="absolute select-none"
          style={{
            left: 0,
            top: row * tileSize,
            width: tileSize,
            height: tileSize,
            imageRendering: "auto",
          }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const localX = e.clientX - rect.left;
            const localY = e.clientY - rect.top;
            const renderedCell = rect.width / grid;
            const c = Math.min(grid - 1, Math.floor(localX / renderedCell));
            const r = Math.min(grid - 1, Math.floor(localY / renderedCell));
            const cellIdx = r * grid + c;
            const photoIndex = row * capacity + cellIdx;
            if (photoIndex >= index.count) return;
            onOpen(photoIndex, {
              left: rect.left + c * renderedCell,
              top: rect.top + r * renderedCell,
              size: renderedCell,
            });
          }}
        />,
      );
    }
  }

  return (
    <div
      className="absolute inset-0"
      onMouseEnter={() => setIsHovered(true)}
      onMouseMove={onGridMouseMove}
      onMouseLeave={() => {
        setIsHovered(false);
        setNearEdge(false);
      }}
    >
      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-y-scroll overflow-x-hidden photo-grid-scroll"
      >
        <div
          className="relative w-full cursor-pointer"
          style={{
            height: totalHeight,
            transform: `scale(${scale})`,
            transformOrigin: `${origin.x}px ${origin.y}px`,
            transition: scaleTransition
              ? `transform ${ZOOM_MS}ms ${ZOOM_EASE}`
              : "none",
            willChange: scaleTransition ? "transform" : undefined,
          }}
          onTransitionEnd={(e) => {
            if (e.propertyName === "transform") setScaleTransition(false);
          }}
        >
          {tiles}
          {videoBadges}
        </div>
      </div>

      {thumbH > 0 && (
        <div
          className="absolute top-0 bottom-0 right-0 w-5 pointer-events-none"
          style={{
            opacity: showScrollbar ? 1 : 0,
            transition: "opacity 0.3s ease",
          }}
        >
          {/* Hit target: widens when the bar is active so it's easy to grab. */}
          <div
            className="absolute right-0 pointer-events-auto"
            style={{
              top: thumbTop,
              height: thumbH,
              width: barActive ? 20 : 12,
              cursor: isDragging ? "grabbing" : "grab",
              transition: "width 0.18s ease",
            }}
            onMouseEnter={() => setThumbHover(true)}
            onMouseLeave={() => setThumbHover(false)}
            onMouseDown={onThumbMouseDown}
          >
            {/* Visible bar: thickens when active, lightens when hovered/dragged. */}
            <div
              className="absolute right-1.5 top-0 h-full rounded-full"
              style={{
                width: barActive ? 7 : 3,
                background: barLit
                  ? "rgba(255, 255, 255, 0.7)"
                  : barActive
                    ? "rgba(255, 255, 255, 0.5)"
                    : "rgba(255, 255, 255, 0.38)",
                transition: "width 0.18s ease, background-color 0.18s ease",
              }}
            />
          </div>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 px-5 pt-6 pb-8 bg-linear-to-b from-black/45 to-transparent">
        <span className="block text-3xl font-bold">{libraryName}</span>
        {dateLabel && (
          <span className="mt-0.5 block text-lg font-bold text-white">
            {dateLabel}
          </span>
        )}
      </div>

      {levels.length > 1 && (
        <ZoomStepper levels={levels} value={grid} onChange={changeGrid} />
      )}
    </div>
  );
}
