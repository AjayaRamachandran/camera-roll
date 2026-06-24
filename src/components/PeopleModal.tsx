import { useEffect, useRef, useState } from "react";

import { User, X } from "lucide-react";

import {
  Person,
  getPeople,
  mergePeople,
  personFaceUrl,
  setPersonName,
} from "@/lib/photoApi";

interface PeopleModalProps {
  /** Pick a person to filter the gallery by their photos. */
  onPick: (person: Person) => void;
  onClose: () => void;
}

/** A circular face avatar that falls back to a neutral icon if it can't load. */
function PersonAvatar({ id, name }: { id: number; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="grid h-20 w-20 place-items-center rounded-full bg-white/10 text-white/55">
        <User size={28} />
      </div>
    );
  }
  return (
    <img
      src={personFaceUrl(id)}
      alt={name}
      draggable={false}
      onError={() => setFailed(true)}
      className="h-20 w-20 rounded-full object-cover"
    />
  );
}

/**
 * The People view: every recognized person as a circle of their face with the
 * name below. Click a face to filter the gallery to that person; click the name
 * to rename them (the name is saved separately from the auto-grouping, so it
 * sticks). Drag one face onto another to combine them into one person.
 *
 * Dragging is pointer-based rather than the native HTML5 drag, which is
 * unreliable in the WebView (it shows a "no drop" cursor and often refuses the
 * drop). A small avatar ghost follows the cursor and the hovered face is hit
 * tested with elementFromPoint.
 */
export default function PeopleModal({ onPick, onClose }: PeopleModalProps) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const cancelRef = useRef(false);

  // Drag-to-merge state. The refs hold live values for the window listeners
  // (which close over stale React state); the state drives the visual feedback.
  const [dragSource, setDragSource] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const [merging, setMerging] = useState(false);
  const sourceRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const overIdRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const ghostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastPtr = useRef({ x: 0, y: 0 });
  const autoScrollRaf = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    getPeople()
      .then((p) => !cancelled && setPeople(p))
      .catch(() => !cancelled && setPeople([]));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && editingId === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editingId, onClose]);

  // If the modal unmounts mid-drag, make sure we don't leave the grab cursor or
  // a running auto-scroll loop behind.
  useEffect(
    () => () => {
      document.body.style.cursor = "";
      if (autoScrollRaf.current != null) cancelAnimationFrame(autoScrollRaf.current);
    },
    []
  );

  // Drop one face onto another to fold them into a single person, then reload
  // the (now shorter) list with updated counts.
  const doMerge = async (source: number, target: number) => {
    if (source === target || merging) return;
    setMerging(true);
    try {
      await mergePeople(source, target);
      setPeople(await getPeople());
    } catch {
      // Leave the list as-is on failure; the user can retry.
    } finally {
      setMerging(false);
    }
  };

  // Distance from a scroll edge (px) where dragging starts auto-scrolling, and
  // the fastest it scrolls per frame at the very edge.
  const EDGE = 64;
  const MAX_SCROLL = 18;

  // Update which face the pointer is over. Re-run whenever the pointer moves OR
  // the list scrolls under a still pointer, so the hovered face stays correct.
  const updateHover = () => {
    const { x, y } = lastPtr.current;
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const cell = el?.closest<HTMLElement>("[data-person-id]");
    const oid = cell ? Number(cell.dataset.personId) : null;
    if (overIdRef.current !== oid) {
      overIdRef.current = oid;
      setOverId(oid);
    }
  };

  // While dragging near the top/bottom edge of the list, keep scrolling so a
  // face far above or below can be reached. Runs every frame; speed ramps up
  // the closer the pointer is to the edge.
  const autoScrollTick = () => {
    const sc = scrollRef.current;
    if (!sc || !draggingRef.current) {
      autoScrollRaf.current = null;
      return;
    }
    const rect = sc.getBoundingClientRect();
    const y = lastPtr.current.y;
    let speed = 0;
    if (y < rect.top + EDGE) {
      speed = -MAX_SCROLL * Math.min(1, (rect.top + EDGE - y) / EDGE);
    } else if (y > rect.bottom - EDGE) {
      speed = MAX_SCROLL * Math.min(1, (y - (rect.bottom - EDGE)) / EDGE);
    }
    if (speed !== 0) {
      sc.scrollTop += speed;
      updateHover();
    }
    autoScrollRaf.current = requestAnimationFrame(autoScrollTick);
  };

  const startDrag = (e: React.PointerEvent, id: number) => {
    if (e.button !== 0) return;
    sourceRef.current = id;
    draggingRef.current = false;
    const startX = e.clientX;
    const startY = e.clientY;

    const move = (ev: PointerEvent) => {
      lastPtr.current = { x: ev.clientX, y: ev.clientY };
      // Only treat it as a drag once the pointer travels a little, so a plain
      // click still selects the person.
      if (!draggingRef.current) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;
        draggingRef.current = true;
        setDragSource(id);
        document.body.style.cursor = "grabbing";
        if (autoScrollRaf.current == null) {
          autoScrollRaf.current = requestAnimationFrame(autoScrollTick);
        }
      }
      const g = ghostRef.current;
      if (g) {
        g.style.transform = `translate(${ev.clientX}px, ${ev.clientY}px) translate(-50%, -50%)`;
      }
      updateHover();
    };

    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      if (autoScrollRaf.current != null) {
        cancelAnimationFrame(autoScrollRaf.current);
        autoScrollRaf.current = null;
      }
      const wasDragging = draggingRef.current;
      const src = sourceRef.current;
      const target = overIdRef.current;
      draggingRef.current = false;
      sourceRef.current = null;
      overIdRef.current = null;
      setDragSource(null);
      setOverId(null);
      if (wasDragging) {
        // Suppress the click that the browser fires after the drag's pointerup.
        suppressClickRef.current = true;
        if (src != null && target != null && target !== src) doMerge(src, target);
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const finishEdit = async (id: number) => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setEditingId(null);
      return;
    }
    const name = draft.trim();
    setEditingId(null);
    try {
      const newName = await setPersonName(id, name);
      setPeople((ps) =>
        ps
          ? ps.map((p) =>
              p.id === id ? { ...p, name: newName, has_alias: name.length > 0 } : p
            )
          : ps
      );
    } catch {
      // Keep the old name on failure; the user can try again.
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-8"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-2xl frosted-glass font-sans">
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-lg text-white/90">People</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="grid place-items-center rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
          >
            <X size={18} />
          </button>
        </div>

        <div
          ref={scrollRef}
          className="thin-scroll min-h-0 flex-1 select-none overflow-y-auto rounded-b-2xl px-5 pb-6"
        >
          {people === null ? (
            <p className="py-10 text-center text-sm text-white/50">
              Looking for people in your photos...
            </p>
          ) : people.length === 0 ? (
            <p className="py-10 text-center text-sm text-white/50">
              No people found yet. They'll appear here as your photos are scanned.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-4 gap-y-6">
              {people.map((p) => (
                <div
                  key={p.id}
                  data-person-id={p.id}
                  className="flex flex-col items-center"
                >
                  <button
                    type="button"
                    aria-label={`Show photos of ${p.name}`}
                    onPointerDown={(e) => startDrag(e, p.id)}
                    onClick={() => {
                      if (suppressClickRef.current) {
                        suppressClickRef.current = false;
                        return;
                      }
                      onPick(p);
                    }}
                    className={`touch-none cursor-grab rounded-full outline-none transition-transform focus-visible:ring-2 focus-visible:ring-white/70 ${
                      dragSource === p.id ? "opacity-40" : "hover:scale-[1.04]"
                    } ${overId === p.id ? "scale-[1.08] ring-2 ring-white/90" : ""}`}
                  >
                    <PersonAvatar id={p.id} name={p.name} />
                  </button>

                  {editingId === p.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        else if (e.key === "Escape") {
                          cancelRef.current = true;
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      onBlur={() => finishEdit(p.id)}
                      className="mt-2 w-24 border-b border-white/30 bg-transparent text-center text-sm text-white/90 outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(p.has_alias ? p.name : "");
                        setEditingId(p.id);
                      }}
                      className="mt-2 max-w-[7rem] truncate text-sm text-white/85 transition-colors hover:text-white"
                    >
                      {p.name}
                    </button>
                  )}

                  <span className="mt-0.5 text-xs text-white/40 font-code">
                    {p.count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* The avatar ghost that follows the cursor while dragging. Positioned via
          a ref (no re-render per move); pointer-events-none so it never blocks
          the elementFromPoint hit test underneath. */}
      <div
        ref={ghostRef}
        className="pointer-events-none fixed left-0 top-0 z-[60]"
        style={{ opacity: dragSource != null ? 1 : 0 }}
      >
        {dragSource != null && (
          <img
            src={personFaceUrl(dragSource)}
            alt=""
            draggable={false}
            className="h-16 w-16 rounded-full object-cover shadow-xl ring-2 ring-white/80"
          />
        )}
      </div>
    </div>
  );
}
