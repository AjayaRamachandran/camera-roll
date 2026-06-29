import { useEffect, useState } from "react";

import { Check, LibraryIcon, TextAlignJustify, Plus } from "lucide-react";

import Refract from "./Refract";
import { pickFolder, restartBackend } from "@/lib/api";
import { Library, addLibrary, getLibraries, switchLibrary } from "@/lib/photoApi";

// Box geometry, in px. The closed orb and the open panel share their BOTTOM-LEFT
// corner (the anchor), so the panel grows up and to the right out of the orb.
// Positioned by CENTRE (translate(-50%,-50%)) so the morph rides Refract's
// liquid-glass spring, exactly like PeoplePopover (which grows down-left).
const CLOSED = 40;
const PANEL_W = 280;
const ROW_H = 42;
const PAD = -4;

/**
 * Bottom-left library switcher: a glass orb that springs open into a list of
 * the photo libraries. The active one is tinted; picking another switches to
 * it, and the last row adds a new one. Both restart the backend and reload, so
 * the app reopens on the chosen library.
 */
export default function LibrarySwitcher() {
  const [open, setOpen] = useState(false);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [busy, setBusy] = useState(false);

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
                onClick={() => choose(lib)}
                title={lib.source}
                className={`flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left text-sm transition-colors ${
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
              className="flex items-center gap-2.5 rounded-2xl px-3 py-2.5 text-left text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Plus size={16} className="shrink-0 opacity-80" />
              <span>Add library...</span>
            </button>
          </div>
        </Refract>
      </div>
    </>
  );
}
