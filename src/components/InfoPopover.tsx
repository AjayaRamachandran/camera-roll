import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Check, Copy, FolderOpen, HelpCircle, Search, User } from "lucide-react";

import { revealInExplorer } from "@/lib/api";
import Refract from "./Refract";
import MapEmbed from "./MapEmbed";

import {
  formatDuration,
  getPeople,
  getPhotoFaces,
  getPhotoLocation,
  isVideo,
  mergePeople,
  Person,
  Photo,
  PhotoFace,
  PhotoLocation,
  photoFaceUrl,
} from "@/lib/photoApi";

interface InfoPopoverProps {
  photo: Photo;
  /** Filter the gallery to a person (closes the viewer and runs the search). */
  onSearchPerson?: (name: string) => void;
  /** Filter the gallery to a place (closes the viewer and runs the search). */
  onSearchLocation?: (query: string) => void;
}

/* Geometry of the "sort this face" control, which is one glass element that
   transitions between two states: a small orb (the "?" badge) and the panel it
   morphs into. Both share their top-right corner with the badge, so the panel
   grows down-left out of the orb. */
const ASSIGN_ORB = 22; // closed badge orb size (px); matches the in-flow badge
const ASSIGN_W = 240; // open panel width
const ASSIGN_H = 340; // open panel height

/** Pull the file name off an absolute Windows path. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Human-friendly capture date, e.g. "June 12, 2026 at 3:41 PM". */
function formatTaken(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A labeled metadata row. Value uses the monospace face (technical values). */
function Field({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: any;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-(--frost-text-dim) text-xs">{label}</span>
      <span
        className={
          "text-[13px] text-(--frost-text) wrap-break-word " + className
        }
      >
        {value}
      </span>
    </div>
  );
}

/** A circular crop of one face in the photo, with a neutral icon fallback. */
function FaceAvatar({ photoId, index }: { photoId: string; index: number }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="grid h-14 w-14 place-items-center rounded-full bg-white/10 text-white/55">
        <User size={20} />
      </div>
    );
  }
  return (
    <img
      src={photoFaceUrl(photoId, index)}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
      className="h-14 w-14 rounded-full object-cover"
    />
  );
}

/**
 * Metadata panel docked on the right of the detail view. Shows the people found
 * in the photo (click a face to see all their photos; faces that still need
 * sorting carry a question mark you can use to file them under a known person),
 * then the capture fields and the full path with a one-tap copy.
 */
export default function InfoPopover({
  photo,
  onSearchPerson,
  onSearchLocation,
}: InfoPopoverProps) {
  const [copied, setCopied] = useState(false);
  const [faces, setFaces] = useState<PhotoFace[] | null>(null);
  const [location, setLocation] = useState<PhotoLocation | null>(null);

  // The face whose "?" badge was clicked, plus the badge's top-right corner in
  // viewport coords (the shared anchor the glass morph grows out of).
  const [assign, setAssign] = useState<{
    face: PhotoFace;
    ax: number; // badge right edge
    ay: number; // badge top edge
  } | null>(null);
  // Drives the morph: false = closed orb geometry, true = open panel geometry.
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignQuery, setAssignQuery] = useState("");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFaces(null);
    setLocation(null);
    setAssign(null);
    setAssignOpen(false);
    getPhotoFaces(photo.id)
      .then((f) => !cancelled && setFaces(f))
      .catch(() => !cancelled && setFaces([]));
    getPhotoLocation(photo.id)
      .then((l) => !cancelled && setLocation(l))
      .catch(() => !cancelled && setLocation(null));
    return () => {
      cancelled = true;
    };
  }, [photo.id]);

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(photo.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; nothing better to do here */
    }
  };

  const revealPath = async () => {
    try {
      await revealInExplorer(photo.path);
    } catch {
      /* explorer may be unavailable; nothing better to do here */
    }
  };

  const openAssign = (face: PhotoFace, e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAssignQuery("");
    setAssign({ face, ax: r.right, ay: r.top });
    setAssignOpen(false);
    // Flip to the open geometry once the closed orb has painted, so the native
    // glass spring morphs from the badge into the panel instead of snapping.
    requestAnimationFrame(() => requestAnimationFrame(() => setAssignOpen(true)));
    if (people === null) {
      getPeople()
        .then(setPeople)
        .catch(() => setPeople([]));
    }
  };

  // Morph the panel back into the orb, then unmount once the spring settles.
  const closeAssign = () => {
    setAssignOpen(false);
    window.setTimeout(() => setAssign(null), 360);
  };

  // File the unknown face's whole cluster under the chosen person.
  const assignTo = async (targetId: number) => {
    if (!assign || busy) return;
    setBusy(true);
    try {
      await mergePeople(assign.face.person_id, targetId);
      setFaces(await getPhotoFaces(photo.id));
      setPeople(null); // counts changed; reload next time
    } catch {
      /* leave as-is on failure */
    } finally {
      setBusy(false);
      closeAssign();
    }
  };

  const q = assignQuery.trim().toLowerCase();
  const matches = (people ?? []).filter((p) => p.name.toLowerCase().includes(q));

  return (
    <div
      className="h-full w-full overflow-y-auto px-5 pb-6 mt-7.5 text-(--frost-text) border-l border-white/[0.07]"
      style={{ paddingTop: "16px" }}
    >
      <h2 className="text-base font-medium mb-4">Photo details</h2>

      {faces && faces.length > 0 && (
        <div className="mb-5 flex flex-col gap-2">
          <span className="text-(--frost-text-dim) text-xs">People</span>
          <div className="flex flex-wrap gap-3">
            {faces.map((f) => (
              <div key={f.index} className="flex w-14 flex-col items-center gap-1">
                <div className="relative">
                  <button
                    type="button"
                    title={f.name}
                    aria-label={`Show photos of ${f.name}`}
                    onClick={() => onSearchPerson?.(f.name)}
                    className="block rounded-full outline-none transition-transform hover:scale-[1.05] focus-visible:ring-2 focus-visible:ring-white/70"
                  >
                    <FaceAvatar photoId={photo.id} index={f.index} />
                  </button>

                  {!f.known && (
                    <Refract
                      as="button"
                      type="button"
                      aria-label="Sort this face"
                      onClick={(e: React.MouseEvent) => openAssign(f, e)}
                      className="absolute -bottom-0.5 -right-0.5 grid h-[22px] w-[22px] place-items-center rounded-full text-white"
                      style={{
                        // Hidden while its panel is mounted: the morphing glass
                        // takes over from this exact spot, so to the eye the orb
                        // grows into the panel and shrinks back.
                        opacity: assign?.face.index === f.index ? 0 : 1,
                      }}
                    >
                      <HelpCircle size={13} />
                    </Refract>
                  )}
                </div>
                {f.known && (
                  <span className="w-full truncate text-center text-[11px] text-(--frost-text-dim)">
                    {f.name}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {location && (
        <div className="mb-5 flex flex-col gap-2">
          <span className="text-(--frost-text-dim) text-xs">Location</span>
          <MapEmbed
            lat={location.lat}
            lon={location.lon}
            photoId={photo.id}
            label={location.label}
            onClick={() => onSearchLocation?.(location.query)}
          />
          <span className="text-[13px] text-(--frost-text)">{location.label}</span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <Field label="Name" value={fileName(photo.path)} />
        <Field label="Taken" value={formatTaken(photo.taken)} />
        <Field label="Dimensions" value={`${photo.width} x ${photo.height}`} />
        <Field
          label="Kind"
          value={photo.ext.replace(".", "").toUpperCase()}
        />
        {isVideo(photo) && photo.duration != null && (
          <Field
            label="Length"
            value={formatDuration(photo.duration)}
          />
        )}

        <div className="flex flex-col gap-1">
          <span className="text-(--frost-text-dim) text-xs">File Path</span>
          <div className="flex items-start gap-2">
            <span className="text-sm text-(--frost-text) break-all flex-1">
              {photo.path}
            </span>
            <button
              onClick={copyPath}
              aria-label="Copy file location"
              className="shrink-0 rounded-md p-1.5 hover:bg-white/10 transition-colors"
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
            <button
              onClick={revealPath}
              aria-label="Show in file explorer"
              title="Show in file explorer"
              className="shrink-0 rounded-md p-1.5 hover:bg-white/10 transition-colors"
            >
              <FolderOpen size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* Assign control: the face's "?" orb morphs into a glass panel where you
          pick a known person to file this face's whole cluster under. It is a
          single glass element transitioning between states (the 22px orb and
          the panel), sharing its top-right corner with the badge so it grows
          out of it. Positioned by its centre (translate(-50%,-50%)) so the
          centre rides the spring while the corner stays pinned. Portaled to the
          document body because the info panel it lives in is `transform`ed,
          which would otherwise become the containing block for these fixed
          children and throw off the viewport coords we anchor to. */}
      {assign &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[65]" onClick={closeAssign} />
          <Refract
            className="fixed z-[70] font-sans"
            style={{
              // Both states share the top-right corner (assign.ax, assign.ay).
              left: assignOpen ? assign.ax - ASSIGN_W / 2 : assign.ax - ASSIGN_ORB / 2,
              top: assignOpen ? assign.ay + ASSIGN_H / 2 : assign.ay + ASSIGN_ORB / 2,
              width: assignOpen ? ASSIGN_W : ASSIGN_ORB,
              height: assignOpen ? ASSIGN_H : ASSIGN_ORB,
              borderRadius: assignOpen ? 18 : 11,
              transform:
                "translate(-50%, -50%) translate(var(--nx), var(--ny)) scale(var(--sc))",
            }}
          >
            {/* Closed face: the same "?" the badge showed, fading + blurring out. */}
            <div
              className="absolute inset-0 grid place-items-center text-white"
              style={{
                opacity: assignOpen ? 0 : 1,
                filter: assignOpen ? "blur(var(--refract-fade-blur))" : "blur(0px)",
                pointerEvents: "none",
                transition:
                  "opacity var(--refract-fade-anim) var(--refract-fade-ease), filter var(--refract-fade-anim) var(--refract-fade-ease)",
              }}
            >
              <HelpCircle size={13} />
            </div>

            {/* Open face: search + people list, sliding up and unblurring in. */}
            <div
              className="absolute inset-0 flex flex-col overflow-hidden rounded-[18px]"
              style={{
                opacity: assignOpen ? 1 : 0,
                transform: assignOpen ? "none" : "translateY(6px)",
                filter: assignOpen ? "blur(0px)" : "blur(var(--refract-fade-blur))",
                pointerEvents: assignOpen ? "auto" : "none",
                transition: [
                  "opacity var(--refract-fade-anim) var(--refract-fade-ease)",
                  "transform var(--refract-fade-anim) var(--refract-spring-pos)",
                  "filter var(--refract-fade-anim) var(--refract-fade-ease)",
                ].join(", "),
              }}
            >
              <div className="flex items-center gap-2 px-3 pt-3 pb-2">
                <Search size={15} className="text-white/50" />
                <input
                  autoFocus
                  value={assignQuery}
                  onChange={(e) => setAssignQuery(e.target.value)}
                  placeholder="Find a person"
                  className="w-full bg-transparent text-sm text-white/90 outline-none placeholder:text-white/40"
                />
              </div>
              <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
                {people === null ? (
                  <p className="px-2 py-3 text-xs text-white/45">Loading...</p>
                ) : matches.length === 0 ? (
                  <p className="px-2 py-3 text-xs text-white/45">No people found.</p>
                ) : (
                  matches.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      disabled={busy}
                      onClick={() => assignTo(p.id)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-white/90 transition-colors hover:bg-white/10 disabled:opacity-50"
                    >
                      <span className="truncate">{p.name}</span>
                      <span className="shrink-0 text-xs text-white/40">
                        {p.count} photos
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </Refract>
          </>,
          document.body
        )}
    </div>
  );
}
