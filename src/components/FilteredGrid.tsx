import { useLayoutEffect, useRef, useState } from "react";

import { Photo, isVideo, thumbUrl } from "@/lib/photoApi";
import { CellRect } from "./PhotoGrid";
import PlayBadge from "./PlayBadge";
import ZoomStepper from "./ZoomStepper";

interface FilteredGridProps {
  /** The photos to show (already filtered and ordered, newest first). */
  results: Photo[];
  /** Available column counts (grid dimensions), ascending. */
  levels: number[];
  /** Opens the photo at `photoIndex`, growing from the clicked cell. */
  onOpen: (photoIndex: number, origin: CellRect) => void;
}

/**
 * Grid for a filtered set of photos (search or a person's pictures).
 *
 * The main gallery composes prerendered mega-tiles, which can only represent
 * the full library in fixed order, so an arbitrary subset is rendered here as
 * individual thumbnail tiles instead. The layout, square cells, and zoom
 * stepper match the main grid so it reads as the same surface.
 */
export default function FilteredGrid({ results, levels, onOpen }: FilteredGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [cols, setCols] = useState(levels[0]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cellSize = width > 0 ? width / cols : 0;
  const badgeSize = Math.max(12, Math.min(30, cellSize * 0.16));
  const badgePad = Math.max(4, cellSize * 0.06);

  return (
    <div className="absolute inset-0">
      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-y-scroll overflow-x-hidden photo-grid-scroll"
      >
        <div
          className="grid w-full"
          style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}
        >
          {results.map((p, i) => (
            <button
              key={p.id}
              type="button"
              className="relative block aspect-square cursor-pointer"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                onOpen(i, { left: rect.left, top: rect.top, size: rect.width });
              }}
            >
              <img
                src={thumbUrl(p.id)}
                alt=""
                draggable={false}
                loading="lazy"
                className="absolute inset-0 h-full w-full select-none object-cover"
              />
              {isVideo(p) && (
                <div
                  className="pointer-events-none absolute"
                  style={{ left: badgePad, bottom: badgePad }}
                >
                  <PlayBadge size={badgeSize} />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {levels.length > 1 && (
        <ZoomStepper levels={levels} value={cols} onChange={setCols} />
      )}
    </div>
  );
}
