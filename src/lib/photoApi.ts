/**
 * Client for the Python photo backend.
 *
 * The backend serves the index plus every image (thumbnails, mega-tiles, and
 * full originals) over its local HTTP port. Because the app runs with CSP
 * disabled, the webview can fetch these URLs directly, so there is no need to
 * proxy each image through Rust.
 */

// Must match PORT in server/main.py / python_server.rs.
const BASE = "http://127.0.0.1:8756";

/** One photo as stored in the index. */
export interface Photo {
  id: string;
  /** Absolute path to the original on disk. */
  path: string;
  /** Thumbnail filename inside the thumbnails folder. */
  thumb: string;
  /** "photo" or "video". Older indexes omit it; treat missing as a photo. */
  kind?: "photo" | "video";
  /** Length in seconds, videos only. */
  duration?: number | null;
  width: number;
  height: number;
  /** ISO-8601 capture time the list is sorted by. */
  taken: string;
  /** Where `taken` came from: "exif" or "file". */
  taken_source: string;
  ext: string;
  /** Which mega-tile this photo lives in. */
  tile: number;
  /** Cell index (0..tile_grid^2-1) within that mega-tile. */
  cell: number;
}

export interface IndexData {
  /** Grid dimension for each zoom level, ascending (e.g. [5, 10, 20]). */
  tile_grids: number[];
  thumb_size: number;
  tile_px: number;
  count: number;
  photos: Photo[];
}

export interface IndexStatus {
  state: "idle" | "scanning" | "done" | "error" | "needs_setup";
  total: number;
  done: number;
  message: string;
  count: number;
}

/** First-run setup state: what (if anything) the user must do before browsing. */
export interface SetupState {
  needs_setup: boolean;
  /** "index_root" (pick a data folder) or "library" (add photos), else null. */
  step: "index_root" | "library" | null;
  indexes_root: string | null;
}

/** One photo library the app knows about. */
export interface Library {
  /** Absolute path to the source photo folder. */
  source: string;
  /** Display name (the folder's name). */
  name: string;
  /** Whether this is the library currently being viewed. */
  current: boolean;
}

/** Progress of background indexing that runs after the library is ready. */
export interface SecondaryStatus {
  /** Worker state: idle | indexing | paused-for-scan | error. */
  state: string;
  /** "foreground" (fast, halts the app) or "background" (quiet, single thread). */
  mode: "foreground" | "background";
  /** A message when `state` is "error" (e.g. face models missing), else null. */
  error: string | null;
  /** 0..100. At or above 100 means finished. */
  percent: number;
  /** Work units completed so far. */
  done_units: number;
  /** Total work units across all index types. 0 means no photos to index. */
  total_units: number;
  /** Estimated seconds remaining, or null when unknown / not running. */
  eta_seconds: number | null;
  /** Cumulative time spent indexing across sessions, in seconds. */
  time_spent_seconds: number;
  /** Per-feature breakdown (backend-defined; not surfaced in the UI yet). */
  per_type: Record<string, unknown>;
}

/** A recognized person, as shown in the People view. */
export interface Person {
  id: number;
  /** Display name: the user's alias, or a default like "Person 3". */
  name: string;
  /** How many distinct photos this person appears in. */
  count: number;
  /** Whether the user has given this person a name. */
  has_alias: boolean;
}

export interface AppConfig {
  photo_root: string;
  index_dir: string;
  thumb_size: number;
  tile_grids: number[];
  tile_px: number;
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const getConfig = () => getJSON<AppConfig>("/config");
export const getIndex = () => getJSON<IndexData>("/index");
export const getStatus = () => getJSON<IndexStatus>("/index/status");

/** Whether the user still needs to choose a data folder or add a library. */
export const getSetup = () => getJSON<SetupState>("/setup");

/** Every library the app knows about, with the active one flagged. */
export const getLibraries = () =>
  getJSON<{ current: string | null; libraries: Library[] }>("/libraries").then(
    (r) => r.libraries
  );

async function postJSON(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
}

/** Set the folder where all index data is kept (first-run step one). */
export const setIndexesRoot = (path: string) =>
  postJSON("/libraries/root", { path });

/** Register a photo folder and make it the active library. */
export const addLibrary = (path: string) => postJSON("/libraries", { path });

/** Select an already-registered library to view. */
export const switchLibrary = (source: string) =>
  postJSON("/libraries/switch", { source });
export const getSecondaryStatus = () =>
  getJSON<SecondaryStatus>("/index/secondary/status");

/** Drop background indexing to a single quiet thread (used by "Run in background"). */
export const setBackgroundIndexing = () =>
  fetch(`${BASE}/index/secondary/background`, { method: "POST" }).then(() => undefined);

/**
 * Push indexing back to full speed (a thread per core). Returns the fresh status
 * so the caller can re-show the indexing screen without waiting for the next poll.
 */
export const setForegroundIndexing = () =>
  fetch(`${BASE}/index/secondary/foreground`, { method: "POST" }).then(
    (r) => r.json() as Promise<SecondaryStatus>
  );

/** The recognized people, most photographed first. */
export const getPeople = () =>
  getJSON<{ people: Person[] }>("/people").then((r) => r.people);

/** Set (or clear, when blank) a person's name. Returns the resulting name. */
export async function setPersonName(id: number, name: string): Promise<string> {
  const res = await fetch(`${BASE}/people/${id}/name`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`set name -> HTTP ${res.status}`);
  return (await res.json()).name as string;
}

/** Photos matching a search term (people for now), newest first, capped at 200. */
export const searchPhotos = (query: string) =>
  getJSON<{ photos: Photo[] }>(`/search?q=${encodeURIComponent(query)}`).then(
    (r) => r.photos
  );

/** Fold one person into another (`source` is absorbed by `target`). */
export async function mergePeople(source: number, target: number): Promise<void> {
  const res = await fetch(`${BASE}/people/merge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, target }),
  });
  if (!res.ok) throw new Error(`merge -> HTTP ${res.status}`);
}

/** URL for a person's circular avatar (a cropped headshot). */
export const personFaceUrl = (id: number) => `${BASE}/people/${id}/face`;

/** One face detected in a specific photo, and the person it belongs to. */
export interface PhotoFace {
  /** Detection index within the photo (used to crop this exact face). */
  index: number;
  person_id: number;
  /** Display name of the person (alias, or default "Person N"). */
  name: string;
  /** How many photos that person appears in. */
  count: number;
  /** Whether the person is named or common enough to show in the People view. */
  known: boolean;
}

/** The faces detected in a photo. */
export const getPhotoFaces = (photoId: string) =>
  getJSON<{ faces: PhotoFace[] }>(`/photo/${photoId}/faces`).then((r) => r.faces);

/** URL for a circular crop of one detected face within a photo. */
export const photoFaceUrl = (photoId: string, index: number) =>
  `${BASE}/photo/${photoId}/face/${index}`;

/** Where a photo was taken, when it carries usable GPS. */
export interface PhotoLocation {
  lat: number;
  lon: number;
  /** Human place string, e.g. "Boston, Massachusetts". */
  label: string;
  /** Search term that surfaces every photo from the same place. */
  query: string;
}

/** The geocoded place for a photo, or null when it has no known location. */
export const getPhotoLocation = (photoId: string) =>
  getJSON<{ location: PhotoLocation | null }>(
    `/photo/${photoId}/location`
  ).then((r) => r.location);

/** URL for a composed mega-tile image at a given zoom level (grid dimension). */
export const megatileUrl = (grid: number, tile: number) =>
  `${BASE}/megatile/${grid}/${tile}`;
/** URL for a single 64x64 thumbnail. */
export const thumbUrl = (id: string) => `${BASE}/thumb/${id}`;
/** URL for a display-ready full-resolution image, or the original video file. */
export const photoUrl = (id: string) => `${BASE}/photo/${id}`;

/** Whether this item is a video (older indexes only stored photos). */
export const isVideo = (p: Photo) => p.kind === "video";

/** Seconds as m:ss (e.g. 83 -> "1:23"), for video durations and scrubbing. */
export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * A remaining-time estimate as a short, human phrase (e.g. "about 3 minutes
 * left"). Returns null when there is nothing meaningful to show, so callers can
 * just omit the line. Kept separate from formatDuration, which is technical.
 */
export function formatEta(seconds: number | null): string | null {
  if (seconds == null || !isFinite(seconds) || seconds <= 0) return null;
  // Only claim "almost done" when the run is genuinely seconds from finishing,
  // otherwise it lingers for minutes while real work remains. Below a minute we
  // show a coarse seconds estimate (rounded to 5s so it doesn't flicker).
  if (seconds < 5) return "almost done";
  if (seconds < 60) {
    const secs = Math.max(5, Math.round(seconds / 5) * 5);
    return `~ ${secs} sec left`;
  }
  const mins = Math.round(seconds / 60);
  if (mins <= 1) return "~ 1 min left";
  return `~ ${mins} min left`;
}
