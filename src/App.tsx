import { useEffect, useState } from "react";

import FrostedBackground from "./components/FrostedBackground";
import TitleBar from "./components/TitleBar";
import LoadingLibrary from "./components/LoadingLibrary";
import PhotoGrid, { CellRect } from "./components/PhotoGrid";
import PhotoDetail from "./components/PhotoDetail";
import { getIndex, getStatus, IndexData, IndexStatus } from "./lib/photoApi";

/**
 * App shell.
 *
 * Structure that is always present:
 *   1. <FrostedBackground/> dither over the OS acrylic blur.
 *   2. <TitleBar/>          custom frameless title bar.
 *
 * The content area shows the library: a preparing screen while the backend
 * indexes photos, then the mega-tile grid, with the detail view layered on top
 * when a photo is opened.
 */
export default function App() {
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [index, setIndex] = useState<IndexData | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<{ photoIndex: number; origin: CellRect } | null>(
    null
  );

  // Poll the backend until indexing settles, then load the index once.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const s = await getStatus();
        if (cancelled) return;
        setStatus(s);

        if (s.state === "error") {
          setError(s.message || "Something went wrong while preparing your photos.");
          return; // stop polling
        }

        // Library is ready (done, or idle with photos already indexed).
        if ((s.state === "done" || s.state === "idle") && s.count > 0) {
          const data = await getIndex();
          if (!cancelled) setIndex(data);
          return; // stop polling
        }
        if (s.state === "done" && s.count === 0) {
          setError("No photos were found in your library folder.");
          return;
        }
      } catch {
        // Backend may still be booting; keep trying quietly.
      }
      timer = window.setTimeout(tick, 600);
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const ready = index !== null;

  return (
    <>
      <FrostedBackground />
      <TitleBar />

      <main className="app-content" data-tauri-drag-region={!ready ? true : undefined}>
        {!ready ? (
          <LoadingLibrary status={status} error={error} />
        ) : (
          // While viewing a photo the grid is hidden (not unmounted) so the
          // empty frosted background shows behind the photo and the scroll
          // position is preserved for when the viewer closes.
          <div
            className="absolute inset-0"
            style={{ visibility: selected ? "hidden" : "visible" }}
          >
            <PhotoGrid
              index={index}
              onOpen={(photoIndex, origin) => setSelected({ photoIndex, origin })}
            />
          </div>
        )}
      </main>

      {ready && selected && (
        <PhotoDetail
          photos={index.photos}
          startIndex={selected.photoIndex}
          origin={selected.origin}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
