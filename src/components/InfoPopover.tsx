import { useEffect, useState } from "react";

import { Check, Copy, HelpCircle, Search, User } from "lucide-react";

import {
  formatDuration,
  getPeople,
  getPhotoFaces,
  isVideo,
  mergePeople,
  Person,
  Photo,
  PhotoFace,
  photoFaceUrl,
} from "@/lib/photoApi";

interface InfoPopoverProps {
  photo: Photo;
  /** Filter the gallery to a person (closes the viewer and runs the search). */
  onSearchPerson?: (name: string) => void;
}

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

/** A labeled metadata row. Value uses Google Sans Code (technical values). */
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
export default function InfoPopover({ photo, onSearchPerson }: InfoPopoverProps) {
  const [copied, setCopied] = useState(false);
  const [faces, setFaces] = useState<PhotoFace[] | null>(null);

  // The face whose "?" badge was clicked, plus where to anchor the popover.
  const [assignFor, setAssignFor] = useState<{
    face: PhotoFace;
    top: number;
    right: number;
  } | null>(null);
  const [assignQuery, setAssignQuery] = useState("");
  const [people, setPeople] = useState<Person[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFaces(null);
    setAssignFor(null);
    getPhotoFaces(photo.id)
      .then((f) => !cancelled && setFaces(f))
      .catch(() => !cancelled && setFaces([]));
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

  const openAssign = (face: PhotoFace, e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setAssignQuery("");
    setAssignFor({ face, top: r.bottom + 6, right: window.innerWidth - r.right });
    if (people === null) {
      getPeople()
        .then(setPeople)
        .catch(() => setPeople([]));
    }
  };

  // File the unknown face's whole cluster under the chosen person.
  const assignTo = async (targetId: number) => {
    if (!assignFor || busy) return;
    setBusy(true);
    try {
      await mergePeople(assignFor.face.person_id, targetId);
      setFaces(await getPhotoFaces(photo.id));
      setPeople(null); // counts changed; reload next time
    } catch {
      /* leave as-is on failure */
    } finally {
      setBusy(false);
      setAssignFor(null);
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
                    <button
                      type="button"
                      aria-label="Sort this face"
                      onClick={(e) => openAssign(f, e)}
                      className="absolute -bottom-0.5 -right-0.5 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-white ring-1 ring-white/40 transition-colors hover:bg-black/90"
                    >
                      <HelpCircle size={13} />
                    </button>
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

      <div className="flex flex-col gap-3">
        <Field label="Name" value={fileName(photo.path)} />
        <Field label="Taken" value={formatTaken(photo.taken)} />
        <Field label="Dimensions" value={`${photo.width} x ${photo.height}`} />
        <Field
          label="Kind"
          value={photo.ext.replace(".", "").toUpperCase()}
          className="font-code"
        />
        {isVideo(photo) && photo.duration != null && (
          <Field
            label="Length"
            value={formatDuration(photo.duration)}
            className="font-code"
          />
        )}

        <div className="flex flex-col gap-1">
          <span className="text-(--frost-text-dim) text-xs">Location</span>
          <div className="flex items-start gap-2">
            <span className="font-code text-xs text-(--frost-text) break-all flex-1">
              {photo.path}
            </span>
            <button
              onClick={copyPath}
              aria-label="Copy file location"
              className="shrink-0 rounded-md p-1.5 hover:bg-white/10 transition-colors"
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
            </button>
          </div>
        </div>
      </div>

      {/* Assign popover: pick a known person to file this face's cluster under. */}
      {assignFor && (
        <>
          <div
            className="fixed inset-0 z-[65]"
            onClick={() => setAssignFor(null)}
          />
          <div
            className="fixed z-[70] flex w-60 flex-col rounded-2xl frosted-glass font-sans"
            style={{ top: assignFor.top, right: assignFor.right, maxHeight: "60vh" }}
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
                    <span className="shrink-0 font-code text-xs text-white/40">
                      {p.count}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
