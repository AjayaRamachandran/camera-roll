import { IndexStatus } from "@/lib/photoApi";

interface LoadingLibraryProps {
  status: IndexStatus | null;
  error?: string;
}

/**
 * The first-run / refresh screen shown while photos are being prepared. Plain
 * language only, no implementation detail leaking through (see AGENTS.md).
 */
export default function LoadingLibrary({ status, error }: LoadingLibraryProps) {
  const total = status?.total ?? 0;
  const done = status?.done ?? 0;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 w-80 text-center">
        {error ? (
          <>
            <p className="text-(--frost-text) text-base">
              We could not open your photos
            </p>
            <p className="text-(--frost-text-dim) text-sm">{error}</p>
          </>
        ) : (
          <>
            <p className="text-(--frost-text) text-base">
              Getting your photos ready
            </p>

            <div className="w-full h-1 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full bg-white/70 rounded-full transition-[width] duration-300"
                style={{ width: total > 0 ? `${pct}%` : "35%" }}
              />
            </div>

            {total > 0 && (
              <p className="font-code text-xs text-(--frost-text-dim)">
                {done} of {total}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
