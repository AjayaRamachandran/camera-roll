import { useLayoutEffect, useRef, useState } from "react";

import { Check, Copy } from "lucide-react";

import { Photo, photoUrl } from "@/lib/photoApi";

/** Screen rect (viewport coords) of the photo as drawn in the detail view. */
export interface PhotoRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface InfoPopoverProps {
  photo: Photo;
  /** Where the photo is rendered on screen, so the glass can blur a copy of it
      that lines up exactly with what is behind the panel. */
  photoRect: PhotoRect;
}

/** Pull the file name off an absolute Windows path. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Human-friendly capture date, e.g. "June 12, 2026 at 3:41 PM". */
function formatTaken(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A labeled metadata row. Value uses Google Sans Code (technical values). */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[var(--frost-text-dim)] text-xs">{label}</span>
      <span className="font-code text-[13px] text-[var(--frost-text)] break-words">
        {value}
      </span>
    </div>
  );
}

/**
 * Metadata popover shown from the info icon in the detail view. Frosted panel,
 * a few capture fields, and the full path with a one-tap copy.
 */
export default function InfoPopover({ photo, photoRect }: InfoPopoverProps) {
  const [copied, setCopied] = useState(false);

  // Measure where the panel sits on screen so the blurred photo copy (which is
  // positioned in viewport coordinates) can be offset into the panel's local
  // space and line up pixel-for-pixel with the real photo behind it.
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState({ left: 0, top: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const r = panelRef.current?.getBoundingClientRect();
      if (r) setPanelPos({ left: r.left, top: r.top });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [photo, photoRect]);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(photo.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; nothing better to do here */
    }
  };

  return (
    <div
      ref={panelRef}
      className="frosted-panel relative overflow-hidden rounded-2xl p-4 w-80 text-[var(--frost-text)]"
    >
      {/* Blurred copy of the photo, drawn at the same viewport position as the
          real photo, then offset into panel-local space. `overflow: hidden` on
          .frosted-panel clips it to the panel. The slight scale hides the soft
          transparent halo blur leaves at the image edges. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <img
          src={photoUrl(photo.id)}
          alt=""
          draggable={false}
          className="absolute max-w-none object-contain"
          style={{
            left: photoRect.left - panelPos.left,
            top: photoRect.top - panelPos.top,
            width: photoRect.width,
            height: photoRect.height,
            filter: "blur(28px) saturate(140%)",
            transform: "scale(1.15)",
          }}
        />
      </div>
      {/* Frosted tint over the blurred photo: this is the "glass" color. */}
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden="true"
        style={{ background: "rgba(58, 58, 64, 0.45)" }}
      />

      <h2 className="relative text-sm font-medium mb-3">Photo details</h2>

      <div className="relative flex flex-col gap-3">
        <Field label="Name" value={fileName(photo.path)} />
        <Field label="Taken" value={formatTaken(photo.taken)} />
        <Field label="Dimensions" value={`${photo.width} x ${photo.height}`} />
        <Field label="Kind" value={photo.ext.replace(".", "").toUpperCase()} />

        <div className="flex flex-col gap-1">
          <span className="text-[var(--frost-text-dim)] text-xs">Location</span>
          <div className="flex items-start gap-2">
            <span className="font-code text-xs text-[var(--frost-text)] break-all flex-1">
              {photo.path}
            </span>
            <button
              onClick={copyPath}
              aria-label="Copy file location"
              className="shrink-0 rounded-md p-1.5 hover:bg-white/10 transition-colors"
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
