import { SecondaryStatus, formatEta } from "@/lib/photoApi";
import Refract from "./Refract";

interface FaceIndexingScreenProps {
  status: SecondaryStatus | null;
  /** Open the rest of the app and let indexing continue quietly. */
  onRunInBackground: () => void;
}

/**
 * The screen shown on launch while the library is being indexed (faces grouped
 * into people, photos reverse-geocoded into places), before the gallery opens.
 * It runs at full speed (every core) so a fresh library finishes fast. "Run in
 * background" opens the app right away and lets the rest finish quietly.
 */
export default function FaceIndexingScreen({
  status,
  onRunInBackground,
}: FaceIndexingScreenProps) {
  const total = status?.total_units ?? 0;
  const done = status?.done_units ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const eta = formatEta(status?.eta_seconds ?? null);

  // First run: the face models download once before face grouping can start.
  // Show that as its own step so progress isn't stuck while bytes come down.
  const models = status?.models;
  const downloading =
    models?.state === "downloading" || models?.state === "extracting";
  const dlPct =
    models && models.total > 0
      ? Math.min(100, Math.round((models.downloaded / models.total) * 100))
      : 0;

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex w-80 flex-col items-center gap-4 text-center">
        <p className="text-base text-(--frost-text)">
          {downloading ? "Setting up face search" : "Indexing your library"}
        </p>

        <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-white/70 transition-[width] duration-300"
            style={{
              width: downloading
                ? models && models.total > 0
                  ? `${dlPct}%`
                  : "35%"
                : total > 0
                  ? `${pct}%`
                  : "35%",
            }}
          />
        </div>

        {downloading ? (
          <p className="text-xs text-(--frost-text-dim)">
            {models && models.total > 0
              ? `Downloading ${dlPct}%`
              : "Downloading"}
          </p>
        ) : (
          <>
            {total > 0 && (
              <p className="text-xs text-(--frost-text-dim)">
                {done} of {total}
              </p>
            )}
            {eta && <p className="text-sm text-(--frost-text-dim)">{eta}</p>}
          </>
        )}

        <Refract
          as="button"
          type="button"
          onClick={onRunInBackground}
          className="mt-2 rounded-full px-4 py-2 text-sm text-white/90 hover:text-white"
        >
          Run in background
        </Refract>
      </div>
    </div>
  );
}
