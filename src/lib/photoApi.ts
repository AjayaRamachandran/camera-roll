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
  state: "idle" | "scanning" | "done" | "error";
  total: number;
  done: number;
  message: string;
  count: number;
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

/** URL for a composed mega-tile image at a given zoom level (grid dimension). */
export const megatileUrl = (grid: number, tile: number) =>
  `${BASE}/megatile/${grid}/${tile}`;
/** URL for a single 64x64 thumbnail. */
export const thumbUrl = (id: string) => `${BASE}/thumb/${id}`;
/** URL for a display-ready full-resolution image. */
export const photoUrl = (id: string) => `${BASE}/photo/${id}`;
