import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { thumbUrl } from "@/lib/photoApi";

/**
 * A small static map showing where a photo was taken, with the photo itself
 * pinned at the spot. Tiles come straight from OpenStreetMap (no API key, in
 * keeping with the offline geocoder), composed by hand: we project the
 * coordinate to Web Mercator pixels, then lay down just the tiles that cover
 * the box so the point sits dead centre. The whole map is a button; clicking it
 * searches the gallery for everything taken in the same place.
 */

const TILE = 256; // OSM tile edge in px
const ZOOM = 14; // neighbourhood-level: streets and a sense of place

/** Web Mercator: a coordinate to absolute pixel position at a zoom level. */
function project(lat: number, lon: number, z: number): { x: number; y: number } {
  const scale = Math.pow(2, z) * TILE;
  const x = ((lon + 180) / 360) * scale;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * scale;
  return { x, y };
}

interface MapEmbedProps {
  lat: number;
  lon: number;
  /** Photo to pin at the spot. */
  photoId: string;
  /** Human place string, used as the accessible label. */
  label: string;
  onClick: () => void;
}

export default function MapEmbed({ lat, lon, photoId, label, onClick }: MapEmbedProps) {
  const boxRef = useRef<HTMLButtonElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  // Tile math needs concrete pixel dimensions; the height is fixed by class and
  // the width fills the panel, so measure the box and recompute on resize.
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ w: el.clientWidth, h: el.clientHeight })
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const tiles = useMemo(() => {
    if (!size) return [];
    const { w, h } = size;
    const n = Math.pow(2, ZOOM);
    const { x, y } = project(lat, lon, ZOOM);
    // Top-left of the viewport in world pixels, so the point lands at centre.
    const ox = x - w / 2;
    const oy = y - h / 2;
    const out: { key: string; url: string; left: number; top: number }[] = [];
    for (let tx = Math.floor(ox / TILE); tx <= Math.floor((ox + w) / TILE); tx++) {
      for (let ty = Math.floor(oy / TILE); ty <= Math.floor((oy + h) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue; // no vertical wrap
        const wx = ((tx % n) + n) % n; // wrap longitude across the date line
        out.push({
          key: `${tx}_${ty}`,
          url: `https://tile.openstreetmap.org/${ZOOM}/${wx}/${ty}.png`,
          left: tx * TILE - ox,
          top: ty * TILE - oy,
        });
      }
    }
    return out;
  }, [size, lat, lon]);

  return (
    <button
      ref={boxRef}
      type="button"
      onClick={onClick}
      aria-label={`Show photos taken in ${label}`}
      // title={`Show photos taken in ${label}`}
      className="group relative block h-44 w-full overflow-hidden rounded-xl bg-white/[0.04] outline-none ring-1 ring-white/10 transition-shadow hover:ring-white/30 focus-visible:ring-2 focus-visible:ring-white/70"
    >
      {tiles.map((t) => (
        <img
          key={t.key}
          src={t.url}
          alt=""
          draggable={false}
          loading="lazy"
          width={TILE}
          height={TILE}
          className="pointer-events-none absolute select-none"
          style={{ left: t.left, top: t.top }}
        />
      ))}

      {/* The pin: the photo itself, sitting above the spot with a tail tip that
          lands exactly on the geographic point at the box centre. */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 flex flex-col items-center"
        style={{ transform: "translate(-50%, -100%)" }}
      >
        <img
          src={thumbUrl(photoId)}
          alt=""
          draggable={false}
          className="h-11 w-11 rounded-lg object-cover ring-2 ring-white shadow-lg"
        />
        <div
          className="h-0 w-0"
          style={{
            borderLeft: "6px solid transparent",
            borderRight: "6px solid transparent",
            borderTop: "8px solid white",
            marginTop: 0,
          }}
        />
      </div>

      {/* OpenStreetMap asks that tiles carry attribution. */}
      <span className="pointer-events-none absolute bottom-0 right-0 rounded-tl-md bg-black/45 px-1.5 py-0.5 text-[10px] text-white/70">
        © OpenStreetMap
      </span>
    </button>
  );
}
