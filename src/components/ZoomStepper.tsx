import { ZoomIn, ZoomOut } from "lucide-react";

interface ZoomStepperProps {
  /** Available zoom levels (grid dimensions), ascending. */
  levels: number[];
  /** The currently active level. */
  value: number;
  onChange: (level: number) => void;
}

/**
 * Frosted-glass zoom control that sits at the bottom of the grid.
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

  return (
    <div className="pointer-events-auto absolute bottom-6 left-1/2 z-30 flex -translate-x-1/2 items-center gap-1 rounded-full frosted-glass px-1.5 py-1 font-sans">
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
    </div>
  );
}
