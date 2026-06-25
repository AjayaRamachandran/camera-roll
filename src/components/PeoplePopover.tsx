import { useEffect, useRef, useState } from "react";

import { User, Users, X } from "lucide-react";

import {
  Person,
  getPeople,
  mergePeople,
  personFaceUrl,
  setPersonName,
} from "@/lib/photoApi";
import Refract from "./Refract";

interface PeoplePopoverProps {
  /** Pick a person to filter the gallery by their photos. */
  onPick: (person: Person) => void;
}

/**
 * Box geometry, in px. Both the closed orb and the open panel share their
 * top-right corner (the anchor) at the anchor box's top-right corner: AX is the
 * right edge, AY the top edge (anchor-local coords). The glass is positioned by
 * its CENTRE (transform: translate(-50%,-50%)), exactly like the reference, so
 * the centre (left/top) can ride the overshoot --refract-spring-pos curve while
 * width/height ride the settle --refract-spring-bounds curve. The two are
 * decoupled, so the corner is only pinned at the endpoints and drifts mid-morph
 * -> "shoot, then expand."
 */
const CLOSED = 40;
const PANEL_W = 420;
const PANEL_H = 560;
const AX = CLOSED; // anchor right edge (= anchor box width)
const AY = 0; // anchor top edge

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
 * The People control: a glass icon button that, when clicked, springs open into
 * a glass popover of everyone recognized in the library. Because it is a single
 * <Refract> element that simply changes size, the open/close is the liquid-glass
 * morph (the same spring the search pill uses), not a separate modal popping in.
 *
 * Inside the popover, every recognized person is a circle of their face with the
 * name below. Click a face to filter the gallery to that person; click the name
 * to rename them (the name is saved separately from the auto-grouping, so it
 * sticks). Drag one face onto another to combine them into one person.
 *
 * Dragging is pointer-based rather than the native HTML5 drag, which is
 * unreliable in the WebView (it shows a "no drop" cursor and often refuses the
 * drop). A small avatar ghost follows the cursor and the hovered face is hit
 * tested with elementFromPoint.
 */
export default function PeoplePopover({ onPick }: PeoplePopoverProps) {
  const [open, setOpen] = useState(false);
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

  // Load the people list the first time the popover is opened.
  useEffect(() => {
    if (!open || people !== null) return;
    let cancelled = false;
    getPeople()
      .then((p) => !cancelled && setPeople(p))
      .catch(() => !cancelled && setPeople([]));
    return () => {
      cancelled = true;
    };
  }, [open, people]);

  // Escape closes the popover (unless a name is being edited).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && editingId === null) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, editingId]);

  // If the popover closes mid-drag, make sure we don't leave the grab cursor or
  // a running auto-scroll loop behind.
  useEffect(() => {
    if (open) return;
    document.body.style.cursor = "";
    if (autoScrollRaf.current != null) cancelAnimationFrame(autoScrollRaf.current);
  }, [open]);

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

  const pick = (person: Person) => {
    setOpen(false);
    onPick(person);
  };

  return (
    <>
      {/* Backdrop that closes the popover on an outside click. Mounted only
          while open; mounting/unmounting it never resizes the glass, so the
          morph spring is unaffected. */}
      {open && (
        <div
          className="fixed inset-0 z-40 pointer-events-auto"
          onClick={() => setOpen(false)}
        />
      )}

      {/* The glass control. A 40x40 orb when closed, springing open into the
          popover panel. It's one persistent <Refract> whose box changes, so the
          open/close is the liquid-glass morph. Lives inside a fixed 40x40 anchor
          so opening never reflows the controls row. Positioned by its CENTRE
          (translate(-50%,-50%)); see the geometry constants above. */}
      <div className="pointer-events-none relative z-50 h-10 w-10">
        <Refract
          className="pointer-events-auto absolute font-sans"
          style={{
            // Centre of the box. Both states share the top-right corner (AX,AY),
            // so it grows down-left and the resting panel stays aligned top-right.
            left: open ? AX - PANEL_W / 2 : AX - CLOSED / 2,
            top: open ? AY + PANEL_H / 2 : AY + CLOSED / 2,
            width: open ? PANEL_W : CLOSED,
            height: open ? PANEL_H : CLOSED,
            borderRadius: open ? 26 : 20,
            // Centre-anchor + hover lean/pop (the --nx/--ny/--sc vars are driven
            // by Refract's hover JS), mirroring the reference's transform.
            transform:
              "translate(-50%, -50%) translate(var(--nx), var(--ny)) scale(var(--sc))",
            // Arm the spring on the element itself so it's in effect the moment
            // `open` flips the box (Refract's reactive .refract-morph lands a
            // frame too late for a discrete toggle). This is the reference's
            // `.glass.morph` transition verbatim: centre (left/top) on the
            // overshoot curve, bounds (width/height/border-radius) on the settle
            // curve, SAME duration -- the "shoot then expand" is the curve shapes,
            // not delays. Inline style beats the .refract class rules.
            transition: [
              "left var(--refract-anim) var(--refract-spring-pos)",
              "top var(--refract-anim) var(--refract-spring-pos)",
              "width var(--refract-anim) var(--refract-spring-bounds)",
              "height var(--refract-anim) var(--refract-spring-bounds)",
              "border-radius var(--refract-anim) var(--refract-spring-bounds)",
              "transform calc(var(--refract-anim) * 0.36) ease",
              "--refract-gb calc(var(--refract-anim) * 0.24) ease",
              "color 0.14s ease",
            ].join(", "),
          }}
        >
          {/* Closed face: just the icon, centred. Fades AND blurs out as the
              panel opens, exactly like the reference's `.icon`. */}
          <button
            type="button"
            aria-label="People"
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
            <Users size={18} />
          </button>

          {/* Open face: header + the people grid. Fades in while sliding up from
              translateY(6px) (on the overshoot curve) and unblurring -- the
              reference's `.menu` content transition. */}
          <div
            className="absolute inset-0 flex flex-col overflow-hidden rounded-[26px]"
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
            <div className="flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-2 text-white/90">
                <Users size={18} />
                <h2 className="text-lg">People</h2>
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={() => setOpen(false)}
                className="grid place-items-center rounded-full p-1.5 text-white/80 transition-colors hover:bg-white/10 hover:text-white"
              >
                <X size={18} />
              </button>
            </div>

            <div
              ref={scrollRef}
              className="thin-scroll min-h-0 flex-1 select-none overflow-y-auto px-5 pb-6 pt-1"
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
                <div className="grid grid-cols-3 gap-x-4 gap-y-6">
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
                          pick(p);
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
        </Refract>
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
    </>
  );
}
