import { useEffect, useRef, useState } from "react";

import { Check, LibraryIcon, TextAlignJustify, Plus, Trash2 } from "lucide-react";

import Refract from "./Refract";
import { pickFolder, restartBackend } from "@/lib/api";
import {
  Library,
  addLibrary,
  getLibraries,
  removeLibrary,
  switchLibrary,
} from "@/lib/photoApi";

// Box geometry, in px. The closed orb and the open panel share their BOTTOM-LEFT
// corner (the anchor), so the panel grows up and to the right out of the orb.
// Positioned by CENTRE (translate(-50%,-50%)) so the morph rides Refract's
// liquid-glass spring, exactly like PeoplePopover (which grows down-left).
const CLOSED = 40;
const PANEL_W = 280;
const ROW_H = 40;
const PAD = 0;

// How long to hold a library row before the remove-confirmation modal opens.
const HOLD_MS = 550;

/**
 * Bottom-left library switcher: a glass orb that springs open into a list of
 * the photo libraries. The active one is tinted; picking another switches to
 * it, and the last row adds a new one. Both restart the backend and reload, so
 * the app reopens on the chosen library.
 *
 * Press and hold a library to remove it: that opens a confirmation modal which,
 * on confirm, deletes only that library's index data (thumbnails, mega-tiles,
 * face/people data). The source photo folder is never touched.
 */
export default function LibrarySwitcher() {
  const [open, setOpen] = useState(false);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [busy, setBusy] = useState(false);
  // The library queued for removal (drives the confirmation modal), or null.
  const [pendingRemove, setPendingRemove] = useState<Library | null>(null);

  // Press-and-hold tracking. `holdTimer` fires the modal after HOLD_MS; the
  // resulting click is then suppressed so the hold does not also switch library.
  const holdTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);

  const refresh = () => {
    getLibraries()
      .then(setLibraries)
      .catch(() => setLibraries([]));
  };

  useEffect(refresh, []);

  // Re-read the list each time the menu opens, so a library added in another
  // way still shows up.
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Apply a library change: rebind the backend to it, then reload into the
  // normal preparing screen for the newly active library.
  const applyChange = async (run: () => Promise<void>) => {
    setBusy(true);
    try {
      await run();
      await restartBackend();
      window.location.reload();
    } catch {
      setBusy(false);
    }
  };

  const choose = (lib: Library) => {
    if (busy) return;
    if (lib.current) {
      setOpen(false);
      return;
    }
    applyChange(() => switchLibrary(lib.source));
  };

  const addNew = async () => {
    if (busy) return;
    const path = await pickFolder("Choose a photo folder");
    if (!path) return;
    applyChange(() => addLibrary(path));
  };

  // Press-and-hold to remove. Starting the timer on pointer-down; if it survives
  // HOLD_MS the modal opens and the trailing click is suppressed. Any pointer
  // release/leave cancels it, so a normal tap still just switches library.
  const cancelHold = () => {
    if (holdTimer.current !== null) {
      window.clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  const startHold = (lib: Library) => {
    if (busy) return;
    // Clear any stale suppress flag from a prior hold whose click never landed
    // on the row (e.g. it hit the modal that opened on top).
    suppressClick.current = false;
    cancelHold();
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      suppressClick.current = true;
      setPendingRemove(lib);
    }, HOLD_MS);
  };

  const onRowClick = (lib: Library) => {
    cancelHold();
    if (suppressClick.current) {
      suppressClick.current = false;
      return; // this click completed a hold; don't also switch
    }
    choose(lib);
  };

  const confirmRemove = () => {
    const lib = pendingRemove;
    if (!lib || busy) return;
    if (lib.current) {
      // Removing the active library: the backend falls back to another (or the
      // setup screen), which only takes effect after a restart + reload.
      applyChange(() => removeLibrary(lib.source));
    } else {
      // A background library: just drop it and refresh the list in place, no
      // disruptive reload since the viewed library is unchanged.
      setBusy(true);
      removeLibrary(lib.source)
        .then(() => {
          setPendingRemove(null);
          refresh();
        })
        .finally(() => setBusy(false));
    }
  };

  useEffect(() => cancelHold, []);

  // One row per library plus the "Add a library" row; height fits the rows.
  const panelH = (libraries.length + 1) * ROW_H + PAD;

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-40 pointer-events-auto"
          onClick={() => setOpen(false)}
        />
      )}

      <div className="pointer-events-none absolute bottom-6 left-5 z-50 h-10 w-10">
        <Refract
          className="pointer-events-auto absolute font-sans"
          style={{
            // Both states share the bottom-left corner (left edge 0, bottom edge
            // CLOSED), so the panel grows up and to the right.
            left: open ? PANEL_W / 2 : CLOSED / 2,
            top: open ? CLOSED - panelH / 2 : CLOSED / 2,
            width: open ? PANEL_W : CLOSED,
            height: open ? panelH : CLOSED,
            borderRadius: open ? 22 : 20,
            transform:
              "translate(-50%, -50%) translate(var(--nx), var(--ny)) scale(var(--sc))",
          }}
        >
          {/* Closed face: the library icon. Fades + blurs out as the panel opens. */}
          <button
            type="button"
            aria-label="Switch library"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="absolute inset-0 grid place-items-center text-white/85 hover:text-white"
            style={{
              opacity: open ? 0 : 1,
              filter: open ? "blur(6px)" : "blur(0px)",
              pointerEvents: open ? "none" : "auto",
              transition:
                "opacity calc(var(--refract-anim) * 0.6) ease, filter calc(var(--refract-anim) * 0.6) ease",
            }}
          >
            <TextAlignJustify size={18} />
          </button>

          {/* Open face: the list of libraries plus the add row. */}
          <div
            className="absolute inset-0 flex flex-col justify-end overflow-hidden rounded-[22px] p-2"
            style={{
              opacity: open ? 1 : 0,
              transform: open ? "none" : "translateY(6px)",
              filter: open ? "blur(0px)" : "blur(6px)",
              pointerEvents: open ? "auto" : "none",
              transition: [
                "opacity calc(var(--refract-anim) * 0.6) ease",
                "transform calc(var(--refract-anim) * 0.6) var(--refract-spring-pos)",
                "filter calc(var(--refract-anim) * 0.6) ease",
              ].join(", "),
            }}
          >
            {libraries.map((lib) => (
              <button
                key={lib.source}
                type="button"
                onClick={() => onRowClick(lib)}
                onPointerDown={() => startHold(lib)}
                onPointerUp={cancelHold}
                onPointerLeave={cancelHold}
                onPointerCancel={cancelHold}
                onContextMenu={(e) => e.preventDefault()}
                title={`${lib.source}\nPress and hold to remove`}
                className={`flex select-none items-center gap-2.5 rounded-2xl px-3 h-11 text-left text-sm transition-colors ${
                  lib.current
                    ? "bg-white/15 text-white"
                    : "text-white/80 hover:bg-white/10 hover:text-white"
                }`}
              >
                <LibraryIcon size={16} className="shrink-0 opacity-80" />
                <span className="min-w-0 flex-1 truncate">{lib.name}</span>
                {lib.current && <Check size={16} className="shrink-0" />}
              </button>
            ))}

            <button
              type="button"
              onClick={addNew}
              className="flex items-center gap-2.5 rounded-2xl px-3 h-11 text-left text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Plus size={16} className="shrink-0 opacity-80" />
              <span>Add library...</span>
            </button>
          </div>
        </Refract>
      </div>

      {/* Remove-library confirmation. Deletes the index data only; the source
          photo folder is left untouched. */}
      {pendingRemove && (
        <div className="fixed inset-0 z-[60] grid place-items-center pointer-events-auto">
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => !busy && setPendingRemove(null)}
          />
          <Refract
            tint={0.5}
            className="relative w-[340px] max-w-[calc(100vw-2rem)] rounded-3xl p-5 font-sans text-white"
          >
            <div className="mb-3 flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-red-500/15 text-red-400">
                <Trash2 size={18} />
              </div>
              <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
                Remove “{pendingRemove.name}”?
              </h2>
            </div>
            <p className="mb-5 text-sm leading-relaxed text-white/60">
              This deletes the thumbnails, mega-tiles, and face &amp; people data
              for this library. Your original photos are{" "}
              <span className="font-medium text-white/80">not</span> touched.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setPendingRemove(null)}
                className="rounded-xl px-4 py-2 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-50"
              >
                Cancel
              </button>
              <Refract
                as="button"
                type="button"
                refraction={0.18}
                aria-disabled={busy}
                onClick={confirmRemove}
                // Inline background overrides the glass's neutral tint (set in
                // .refract) with a strong red, keeping the rim + refraction.
                style={{ background: "rgba(220, 38, 38, 0.3)" }}
                className={`rounded-xl px-4 py-2 text-sm font-medium text-white ${
                  busy ? "pointer-events-none opacity-50" : ""
                }`}
              >
                {busy ? "Removing…" : "Remove"}
              </Refract>
            </div>
          </Refract>
        </div>
      )}
    </>
  );
}
