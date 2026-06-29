import { ZoomIn, ZoomOut } from "lucide-react";

import Refract from "./Refract";

interface ZoomStepperProps {
  /** Available zoom levels (grid dimensions), ascending. */
  levels: number[];
  /** The currently active level. */
  value: number;
  onChange: (level: number) => void;
}

/**
 * Liquid-glass zoom control that sits at the bottom of the grid.
 *
 * Lower levels show larger photos (fewer on screen); higher levels pack more
 * photos in. The two buttons step one level at a time, and the track segments
 * between them jump straight to a level and show where you are.
 */
export default function ZoomStepper({ levels, value, onChange }: ZoomStepperProps) {
  const i = levels.indexOf(value);
  const largerPhotos = () => i > 0 && onChange(levels[i - 1]);
  const morePhotos = () => i < levels.length - 1 && onChange(levels[i + 1]);

  const stepButton =
    "grid place-items-center rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:pointer-events-none disabled:opacity-30";

  // Centered with inset-x-0 + mx-auto rather than -translate-x-1/2, because
  // Refract drives its own `transform` for the hover lean/pop.
  return (
    <Refract className="pointer-events-auto absolute bottom-4 inset-x-0 mx-auto z-30 flex w-fit items-center gap-1.5 rounded-full px-2 py-1.5 font-sans">
      <button
        type="button"
        aria-label="Show larger photos"
        onClick={largerPhotos}
        disabled={i <= 0}
        className={stepButton}
      >
        <ZoomIn size={16} />
      </button>

      <div className="flex items-center gap-1.5 px-1.5">
        {levels.map((level, idx) => (
          <button
            key={level}
            type="button"
            aria-label={`Zoom level ${idx + 1} of ${levels.length}`}
            aria-pressed={idx === i}
            onClick={() => onChange(level)}
            className={`h-3.5 w-[3px] rounded-full transition-colors ${
              idx === i ? "bg-white/90" : "bg-white/30 hover:bg-white/50"
            }`}
          />
        ))}
      </div>

      <button
        type="button"
        aria-label="Show more photos"
        onClick={morePhotos}
        disabled={i >= levels.length - 1}
        className={stepButton}
      >
        <ZoomOut size={16} />
      </button>
    </Refract>
  );
}
