import { useEffect, useState } from "react";

import { AcrylicMatteProvider } from "./components/AcrylicMatte";
import FrostedBackground from "./components/FrostedBackground";
import TitleBar from "./components/TitleBar";
import LoadingLibrary from "./components/LoadingLibrary";
import LibrarySetup from "./components/LibrarySetup";
import LibrarySwitcher from "./components/LibrarySwitcher";
import PhotoGrid, { CellRect } from "./components/PhotoGrid";
import FilteredGrid from "./components/FilteredGrid";
import GalleryControls from "./components/GalleryControls";
import FaceIndexingScreen from "./components/FaceIndexingScreen";
import PhotoDetail from "./components/PhotoDetail";
import {
  getIndex,
  getSecondaryStatus,
  getSetup,
  getStatus,
  IndexData,
  IndexStatus,
  Person,
  Photo,
  searchPhotos,
  SecondaryStatus,
  SetupState,
  setBackgroundIndexing,
  setForegroundIndexing,
} from "./lib/photoApi";

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
  // First-run setup gate. `null` while we ask the backend; once known, either
  // the setup flow runs or the normal library flow proceeds. `setupNonce` is
  // bumped to re-ask after the user completes a step.
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [setupNonce, setSetupNonce] = useState(0);

  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [index, setIndex] = useState<IndexData | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<{
    photoIndex: number;
    origin: CellRect;
    source: "full" | "filter";
  } | null>(null);
  const [galleryView, setGalleryView] = useState<"full" | "filter">("full");
  const [fullGridFocusIndex, setFullGridFocusIndex] = useState<number | null>(
    null,
  );

  // Search / People filtering. `filter` is the applied result set (null = the
  // full library); `searchText` / `searchOpen` drive the search field, which is
  // controlled here so picking a person can fill it and run the search at once.
  const [searchText, setSearchText] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [filter, setFilter] = useState<{ results: Photo[] } | null>(null);

  const submitSearch = async (text: string) => {
    const q = text.trim();
    if (!q) {
      setFilter(null);
      setGalleryView("full");
      return;
    }
    try {
      const results = await searchPhotos(q);
      setFilter({ results });
      setGalleryView("filter");
    } catch {
      setFilter({ results: [] });
      setGalleryView("filter");
    }
  };

  const clearSearch = () => {
    setSearchText("");
    setSearchOpen(false);
    setFilter(null);
    setGalleryView("full");
  };

  const runSearchForName = (name: string) => {
    setSearchText(name);
    setSearchOpen(true);
    submitSearch(name);
  };

  const pickPerson = (person: Person) => {
    runSearchForName(person.name);
  };

  // On launch, people are indexed at full speed on a dedicated screen until the
  // user sends it to the background (or it finishes on its own). `backgrounded`
  // latches that decision so the gallery stays open from then on.
  const [secondary, setSecondary] = useState<SecondaryStatus | null>(null);
  const [backgrounded, setBackgrounded] = useState(false);

  const runInBackground = () => {
    setBackgrounded(true);
    setBackgroundIndexing().catch(() => {});
  };

  // Resume the full-speed indexing screen from the gallery: switch the worker
  // back to foreground and drop the `backgrounded` latch so the gating screen
  // shows again. We await the mode switch and seed `secondary` with its result
  // so the screen appears immediately, before the polling loop's next tick (and
  // so that loop doesn't briefly see "background" and re-latch).
  const resumeForeground = async () => {
    try {
      const s = await setForegroundIndexing();
      setSecondary(s);
    } catch {
      // If the switch fails, stay in the gallery rather than showing a blank
      // screen — the pill keeps polling and the user can try again.
      return;
    }
    setBackgrounded(false);
  };

  // Poll the people-indexing progress while it might still be gating the
  // gallery. Stop once the user backgrounds it, it finishes, or it stops running
  // in the foreground (e.g. the engine parked on an error).
  useEffect(() => {
    if (index === null || backgrounded) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await getSecondaryStatus();
        if (cancelled) return;
        setSecondary(s);
        if (
          s.percent >= 100 ||
          s.mode !== "foreground" ||
          s.state === "error"
        ) {
          setBackgrounded(true);
          return;
        }
      } catch {
        // Endpoint may not be ready yet; keep trying quietly.
      }
      timer = window.setTimeout(tick, 1000);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [index, backgrounded]);

  // Show the dedicated indexing screen only while it is actively gating: ready,
  // not yet backgrounded, running in the foreground with work left to do.
  const showFaceScreen =
    !backgrounded &&
    secondary != null &&
    secondary.mode === "foreground" &&
    secondary.total_units > 0 &&
    secondary.percent < 100 &&
    secondary.state !== "error";

  // Ask the backend whether first-run setup is still needed. Retries quietly
  // while the backend is booting; re-runs when `setupNonce` changes (after the
  // user picks the data folder, so the next step shows without a reload).
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await getSetup();
        if (!cancelled) setSetup(s);
        return;
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
  }, [setupNonce]);

  // Poll the backend until indexing settles, then load the index once. Gated on
  // setup being complete so it does not run during the first-run flow.
  useEffect(() => {
    if (!setup || setup.needs_setup) return;
    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const s = await getStatus();
        if (cancelled) return;
        setStatus(s);

        if (s.state === "error") {
          setError(
            s.message || "Something went wrong while preparing your photos.",
          );
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
  }, [setup]);

  const ready = index !== null;

  return (
    <AcrylicMatteProvider>
      <FrostedBackground />
      <TitleBar />

      <main
        className="app-content"
        data-tauri-drag-region={!ready ? true : undefined}
      >
        {setup?.needs_setup && setup.step ? (
          <LibrarySetup
            step={setup.step}
            onRootChosen={() => setSetupNonce((n) => n + 1)}
          />
        ) : !ready ? (
          <LoadingLibrary status={status} error={error} />
        ) : showFaceScreen ? (
          <FaceIndexingScreen
            status={secondary}
            onRunInBackground={runInBackground}
          />
        ) : (
          // While viewing a photo the grid is hidden (not unmounted) so the
          // empty frosted background shows behind the photo and the scroll
          // position is preserved for when the viewer closes.
          <div
            className="absolute inset-0"
            style={{ visibility: selected ? "hidden" : "visible" }}
          >
            {filter && galleryView === "filter" ? (
              filter.results.length > 0 ? (
                <FilteredGrid
                  results={filter.results}
                  levels={index.tile_grids}
                  onOpen={(photoIndex, origin) =>
                    setSelected({ photoIndex, origin, source: "filter" })
                  }
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center">
                  <p className="font-sans text-white/50">No matches</p>
                </div>
              )
            ) : (
              <PhotoGrid
                index={index}
                focusIndex={fullGridFocusIndex}
                onOpen={(photoIndex, origin) =>
                  setSelected({ photoIndex, origin, source: "full" })
                }
              />
            )}

            <GalleryControls
              query={searchText}
              searchOpen={searchOpen}
              onQueryChange={setSearchText}
              onSearchOpenChange={setSearchOpen}
              onSubmit={() => submitSearch(searchText)}
              onClear={clearSearch}
              onPickPerson={pickPerson}
              onResumeIndexing={resumeForeground}
            />

            <LibrarySwitcher />
          </div>
        )}
      </main>

      {ready && selected && (
        <PhotoDetail
          photos={
            filter && galleryView === "filter" ? filter.results : index.photos
          }
          startIndex={selected.photoIndex}
          origin={selected.origin}
          fromSearchResults={selected.source === "filter"}
          onClose={() => setSelected(null)}
          onShowFullGrid={(photoId) => {
            setSelected(null);
            // Locate the photo within the full library and reveal it there,
            // dropping the search so the whole grid is visible around it.
            const fullIndex = index.photos.findIndex((p) => p.id === photoId);
            clearSearch();
            setFullGridFocusIndex(fullIndex >= 0 ? fullIndex : null);
          }}
          onBackToResults={() => {
            setSelected(null);
            setGalleryView("filter");
          }}
          onSearchPerson={(name) => {
            setSelected(null);
            runSearchForName(name);
          }}
          onSearchLocation={(query) => {
            setSelected(null);
            runSearchForName(query);
          }}
        />
      )}
    </AcrylicMatteProvider>
  );
}
