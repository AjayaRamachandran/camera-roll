import { useEffect, useState } from "react";

import { getSecondaryStatus, formatEta, SecondaryStatus } from "../lib/photoApi";
import Refract from "./Refract";

/**
 * Small liquid-glass pill that shows the progress of background indexing: a
 * short label and a done/total count, with a thin bar across the bottom edge
 * conveying the same progress. Hovering swaps the count for a human time
 * estimate. It self-fetches, fades in only while indexing is in progress, and
 * fades out the moment it finishes. It is laid out by GalleryControls, so it
 * positions itself relatively (no absolute placement here).
 *
 * Clicking the pill calls `onResume`, which kicks indexing back to full speed
 * and returns to the dedicated indexing screen — so the user can finish a run
 * fast without leaving and relaunching the app.
 */

const POLL_MS = 3000;
const FADE_MS = 320;

/** Poll background indexing progress on a light interval; stop once complete. */
function useSecondaryStatus(): SecondaryStatus | null {
  const [status, setStatus] = useState<SecondaryStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const s = await getSecondaryStatus();
        if (cancelled) return;
        setStatus(s);
        if (s.percent >= 100) return; // finished: stop polling
      } catch {
        // Endpoint may not be ready yet; keep trying quietly.
      }
      timer = window.setTimeout(tick, POLL_MS);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return status;
}

export default function IndexingPill({ onResume }: { onResume: () => void }) {
  const status = useSecondaryStatus();
  const running = status != null && status.total_units > 0 && status.percent < 100;

  // Drive opacity from `running`, but keep the element mounted through the
  // fade-out so it does not just disappear when indexing completes.
  const [show, setShow] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (running) {
      setMounted(true);
      const id = requestAnimationFrame(() => setShow(true));
      return () => cancelAnimationFrame(id);
    }
    setShow(false);
    if (!mounted) return;
    const t = window.setTimeout(() => setMounted(false), FADE_MS);
    return () => clearTimeout(t);
  }, [running, mounted]);

  if (!mounted || !status) return null;

  const pct = Math.max(0, Math.min(100, status.percent));
  const eta = formatEta(status.eta_seconds);
  const count = `${status.done_units} of ${status.total_units}`;
  // On hover show the time estimate; fall back to the count if no estimate yet.
  const showEta = hovered && eta != null;

  return (
    <Refract
      as="button"
      type="button"
      onClick={onResume}
      title="Resume full-speed indexing"
      aria-label="Resume full-speed indexing"
      className="pointer-events-auto block w-64 cursor-pointer rounded-full text-left font-sans top-1"
      style={{
        opacity: show ? 1 : 0,
        // Keep the glass hover (lean/brighten) animating alongside the fade.
        transition: "opacity 0.3s ease, transform 0.12s ease, --refract-gb 0.08s ease",
      }}
      aria-hidden={!show}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div className="flex items-baseline justify-between gap-3 px-3.5 pt-2.5 pb-1.5">
        <span className="text-md text-(--frost-text)">Indexing...</span>
        <span
          className={
            showEta
              ? "text-sm text-(--frost-text-dim)"
              : "text-sm text-(--frost-text-dim) tabular-nums"
          }
        >
          {showEta ? eta : count}
        </span>
      </div>

      {/* Bar sits flush against the bottom edge; its corners follow the pill. */}
      <div className="h-1 bg-white/10 overflow-hidden rounded-lg mx-4">
        <div
          className="h-full bg-white/70 transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </Refract>
  );
}
