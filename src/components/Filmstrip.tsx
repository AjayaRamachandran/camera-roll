import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Photo, thumbUrl } from "@/lib/photoApi";

interface FilmstripProps {
  photos: Photo[];
  current: number;
  /** Jump to a photo immediately (no transition), per the design. */
  onPick: (index: number) => void;
}

const ITEM = 56; // on-screen width of one filmstrip thumbnail (square)

/**
 * The running thumbnail rail under the big photo. Shows what came before and
 * after; scrolling left/right or clicking jumps straight to that photo without
 * a transition. Items are virtualized so even a huge library stays light.
 */
export default function Filmstrip({ photos, current, onPick }: FilmstripProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewport, setViewport] = useState(0);
  const userScrolling = useRef(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewport(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setScrollLeft(el.scrollLeft);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Keep the current photo centered when it changes (e.g. via swipe). Instant,
  // so it never reads as an animated "switch".
  useEffect(() => {
    const el = ref.current;
    if (!el || viewport === 0) return;
    if (userScrolling.current) return;
    el.scrollLeft = current * ITEM + ITEM / 2 - viewport / 2;
  }, [current, viewport]);

  const total = photos.length * ITEM;
  const first = Math.max(0, Math.floor(scrollLeft / ITEM) - 2);
  const last = Math.min(
    photos.length - 1,
    Math.ceil((scrollLeft + viewport) / ITEM) + 2
  );

  const items: JSX.Element[] = [];
  for (let i = first; i <= last; i++) {
    const p = photos[i];
    if (!p) continue;
    items.push(
      <img
        key={p.id}
        src={thumbUrl(p.id)}
        alt=""
        draggable={false}
        className={`filmstrip-item absolute top-1 cursor-pointer rounded-md object-cover ${
          i === current ? "is-current" : ""
        }`}
        style={{ left: i * ITEM + 4, width: ITEM - 8, height: ITEM - 8 }}
        onClick={() => onPick(i)}
      />
    );
  }

  return (
    <div
      ref={ref}
      className="filmstrip absolute bottom-0 left-0 right-0"
      style={{ height: ITEM }}
      onPointerDown={() => (userScrolling.current = true)}
      onPointerUp={() => (userScrolling.current = false)}
    >
      <div className="relative h-full" style={{ width: total }}>
        {items}
      </div>
    </div>
  );
}
