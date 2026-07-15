"""
Camera Roll FastAPI server and indexing orchestration.

This module owns the index state and the HTTP API. The heavy image work lives in
imaging.py and runs across a single process pool that is reused for both the
thumbnail and mega-tile phases (creating the pool is the expensive part, so we
do it once per scan). main.py is a thin launcher that imports `app` from here.
"""

import hashlib
import io
import json
import os
import platform
import threading
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image, ImageOps

import ffmpeg_bootstrap
import imaging
import libraries
import secondary_index

# Pull the shared config/paths from the imaging module. The path-bound ones
# (PHOTO_ROOT, INDEX_DIR, ...) are None until a library is set up; the server
# then runs in "needs setup" mode and the scan/secondary passes stay parked.
INDEXES_ROOT = imaging.INDEXES_ROOT
PHOTO_ROOT = imaging.PHOTO_ROOT
INDEX_DIR = imaging.INDEX_DIR
THUMB_DIR = imaging.THUMB_DIR
TILE_DIR = imaging.TILE_DIR
INDEX_FILE = imaging.INDEX_FILE
THUMB_SIZE = imaging.THUMB_SIZE
TILE_GRIDS = imaging.TILE_GRIDS
PRIMARY_GRID = imaging.PRIMARY_GRID
TILE_PX = imaging.TILE_PX
IMAGE_EXTS = imaging.IMAGE_EXTS
VIDEO_EXTS = imaging.VIDEO_EXTS
MEDIA_EXTS = imaging.MEDIA_EXTS
WEB_DISPLAYABLE = imaging.WEB_DISPLAYABLE


# --------------------------------------------------------------------------- #
# In-memory index state
# --------------------------------------------------------------------------- #

_state_lock = threading.Lock()

PHOTOS: list[dict] = []
BY_ID: dict[str, dict] = {}
_loaded_thumb_size = None

STATUS = {"state": "idle", "total": 0, "done": 0, "message": ""}


def _set_status(**kw) -> None:
    with _state_lock:
        STATUS.update(kw)


def snapshot_photos() -> list[dict]:
    """A copy of the canonical photo list, for the secondary index worker.

    The list is copied under the lock; the dicts inside are treated read-only by
    callers, so a shallow copy is enough and keeps the lock held only briefly.
    """
    with _state_lock:
        return list(PHOTOS)


def load_index() -> None:
    global PHOTOS, BY_ID, _loaded_thumb_size
    if INDEX_FILE is None or not INDEX_FILE.exists():
        PHOTOS, BY_ID, _loaded_thumb_size = [], {}, None
        return
    try:
        with open(INDEX_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        PHOTOS = data.get("photos", [])
        BY_ID = {p["id"]: p for p in PHOTOS}
        _loaded_thumb_size = data.get("thumb_size")
    except Exception as exc:
        print(f"[backend] failed to read index, starting fresh: {exc}")
        PHOTOS, BY_ID, _loaded_thumb_size = [], {}, None


def save_index() -> None:
    payload = {
        "version": 4,
        "tile_grids": TILE_GRIDS,
        "thumb_size": THUMB_SIZE,
        "tile_px": TILE_PX,
        "count": len(PHOTOS),
        "photos": PHOTOS,
    }
    tmp = INDEX_FILE.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    os.replace(tmp, INDEX_FILE)


def _clear_dir(path, *patterns: str) -> None:
    for pat in patterns:
        for f in path.glob(pat):
            try:
                f.unlink()
            except OSError:
                pass


def _rebuild_megatiles(pool: ProcessPoolExecutor) -> None:
    """Recompose every zoom level's mega-tiles in parallel from the thumbnails."""
    # Sweep up any tiles left in the old flat layout (pre multi-level).
    _clear_dir(TILE_DIR, "tile_*.jpg", "tile_*.png")

    payloads = []
    for grid in TILE_GRIDS:
        _clear_dir(imaging.tile_dir(grid), "tile_*.jpg", "tile_*.png")
        capacity = grid * grid
        n_tiles = (len(PHOTOS) + capacity - 1) // capacity
        for t in range(n_tiles):
            chunk = PHOTOS[t * capacity : (t + 1) * capacity]
            names = []
            for i, photo in enumerate(chunk):
                # Record cell placement for the primary level only; the frontend
                # derives every other level's placement from photo order.
                if grid == PRIMARY_GRID:
                    photo["tile"] = t
                    photo["cell"] = i
                names.append(photo["thumb"])
            payloads.append((grid, t, names, len(chunk) == capacity))

    if payloads:
        list(pool.map(imaging.compose_tile, payloads, chunksize=2))


def scan_library() -> None:
    """Full incremental index pass. Runs on a background thread."""
    global PHOTOS, BY_ID, _loaded_thumb_size
    try:
        _set_status(state="scanning", done=0, total=0, message="Looking for photos")

        if not PHOTO_ROOT.exists():
            _set_status(state="error", message=f"Library folder not found: {PHOTO_ROOT}")
            return

        # If the thumbnail size changed (e.g. 64 -> 128), every cached thumbnail
        # is stale, so wipe and regenerate from scratch.
        if _loaded_thumb_size is not None and _loaded_thumb_size != THUMB_SIZE:
            print(f"[backend] thumb size {_loaded_thumb_size} -> {THUMB_SIZE}; rebuilding")
            with _state_lock:
                PHOTOS = []
                BY_ID = {}
            _clear_dir(THUMB_DIR, "*.jpg")
            _clear_dir(TILE_DIR, "tile_*.jpg", "tile_*.png")
            for grid in TILE_GRIDS:
                _clear_dir(imaging.tile_dir(grid), "tile_*.jpg", "tile_*.png")
            _loaded_thumb_size = THUMB_SIZE

        found = []
        for dirpath, _dirs, files in os.walk(PHOTO_ROOT):
            for name in files:
                if os.path.splitext(name)[1].lower() in MEDIA_EXTS:
                    found.append(os.path.join(dirpath, name))

        # First run with videos: if the library contains video files but the
        # video tools are not available yet, fetch ffmpeg in the background and
        # re-scan once it lands, so the videos get thumbnails with no manual
        # install. Photos index right away meanwhile; only videos wait for it.
        if not imaging.ffmpeg_ready() and any(
            os.path.splitext(f)[1].lower() in VIDEO_EXTS for f in found
        ):
            ffmpeg_bootstrap.ensure_ffmpeg_async(on_success=_rescan_after_ffmpeg)

        found_set = set(found)
        known = {p["path"]: p for p in PHOTOS}
        surviving = [p for p in PHOTOS if p["path"] in found_set]
        new_paths = [p for p in found if p not in known]

        _set_status(total=len(new_paths), done=0, message="Preparing your photos")

        # One pool, reused for both thumbnailing and tile composition.
        with ProcessPoolExecutor(max_workers=imaging.pool_workers()) as pool:
            new_records = []
            if new_paths:
                done = 0
                for rec in pool.map(imaging.make_thumbnail, new_paths, chunksize=4):
                    done += 1
                    if done % 25 == 0 or done == len(new_paths):
                        _set_status(done=done)
                    if rec is not None:
                        new_records.append(rec)

            merged = surviving + new_records
            merged.sort(key=lambda p: p.get("taken") or "")

            with _state_lock:
                PHOTOS = merged
                BY_ID = {p["id"]: p for p in PHOTOS}

            _set_status(message="Arranging your library")
            _rebuild_megatiles(pool)

        save_index()
        _loaded_thumb_size = THUMB_SIZE
        _set_status(state="done", message="", total=len(new_paths), done=len(new_paths))
        # Let the background face pass pick up anything new this scan added.
        secondary_index.notify_index_changed()
    except Exception as exc:
        print(f"[backend] scan failed: {exc}")
        _set_status(state="error", message=str(exc))


def _rescan_after_ffmpeg() -> None:
    """Re-scan once the first-run ffmpeg download finishes, so videos skipped for
    lack of it get indexed now.

    Incremental: already-indexed photos are kept (they are still "known"), only
    the videos are added; the fresh worker pool the scan spawns re-imports imaging
    and picks up the just-downloaded binaries. No-op while a scan is already
    running, so it never stacks a second pass on top of the first."""
    with _state_lock:
        if STATUS["state"] == "scanning":
            return
    threading.Thread(target=scan_library, daemon=True).start()


# --------------------------------------------------------------------------- #
# FastAPI app
# --------------------------------------------------------------------------- #

app = FastAPI(title="Camera Roll Backend", version="0.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    if not imaging.has_library():
        # No library selected yet: stay idle and let the frontend run the setup
        # flow. Paths bind on the next launch after a library is chosen.
        _set_status(state="needs_setup", message=imaging.setup_step() or "")
        return
    load_index()
    threading.Thread(target=scan_library, daemon=True).start()
    # Background face/people indexing. Runs independently of the main scan and
    # yields while it is running, so it never delays the gallery being ready.
    secondary_index.start()


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "python_version": platform.python_version(),
        "indexed": len(PHOTOS),
    }


@app.get("/config")
def get_config() -> dict:
    return {
        "photo_root": str(PHOTO_ROOT) if PHOTO_ROOT else None,
        "index_dir": str(INDEX_DIR) if INDEX_DIR else None,
        "thumb_size": THUMB_SIZE,
        "tile_grids": TILE_GRIDS,
        "tile_px": TILE_PX,
    }


# --------------------------------------------------------------------------- #
# Setup + library management
#
# Switching or adding a library writes the registry, but the path-bound globals
# only rebind at process startup, so the Rust shell restarts the sidecar after
# these calls. They therefore just record intent and return; the new library
# takes effect on the next boot.
# --------------------------------------------------------------------------- #

def _live_root():
    """The indexes root as currently recorded on disk.

    Resolved fresh (not the value bound at startup) so the first-run flow sees a
    just-chosen root take effect without a restart. Only the actual indexing
    needs the restart, since that is where paths bind.
    """
    return libraries.resolve_indexes_root(imaging.CONFIG)


@app.get("/setup")
def get_setup() -> dict:
    """What the user still needs to do before browsing, for the first-run flow."""
    root = _live_root()
    active = libraries.current_library(root) if root is not None else None
    if root is None:
        step = "index_root"
    elif active is None:
        step = "library"
    else:
        step = None
    return {
        "needs_setup": step is not None,
        "step": step,
        "indexes_root": str(root) if root else None,
    }


@app.get("/libraries")
def get_libraries() -> dict:
    """Every registered library plus which one is active, for the switcher."""
    return libraries.list_libraries(_live_root())


@app.post("/libraries/root")
def set_libraries_root(payload: dict) -> dict:
    """Choose the folder where all index data is kept (first-run step one)."""
    path = str(payload.get("path", "")).strip()
    if not path:
        raise HTTPException(status_code=400, detail="path required")
    libraries.set_indexes_root(path)
    return {"ok": True}


@app.post("/libraries")
def add_library(payload: dict) -> dict:
    """Register a photo folder and make it the active library."""
    path = str(payload.get("path", "")).strip()
    if not path:
        raise HTTPException(status_code=400, detail="path required")
    root = _live_root()
    if root is None:
        raise HTTPException(status_code=409, detail="indexes folder not set")
    lib = libraries.add_library(root, path, make_current=True)
    return {"ok": True, "library": {"source": lib["source"], "name": lib["name"]}}


@app.post("/libraries/switch")
def switch_library(payload: dict) -> dict:
    """Select an already-registered library to view."""
    source = str(payload.get("source", "")).strip()
    root = _live_root()
    if root is None:
        raise HTTPException(status_code=409, detail="indexes folder not set")
    lib = libraries.set_current(root, source)
    if lib is None:
        raise HTTPException(status_code=404, detail="unknown library")
    return {"ok": True}


@app.post("/libraries/remove")
def remove_library(payload: dict) -> dict:
    """Unregister a library and delete its index data (never the source photos).

    Like switching, this only rewrites the registry and disk; the path-bound
    globals rebind on the next restart, which the Rust shell performs right after
    this call so the app reopens on a remaining library (or the setup screen)."""
    source = str(payload.get("source", "")).strip()
    root = _live_root()
    if root is None:
        raise HTTPException(status_code=409, detail="indexes folder not set")
    lib = libraries.remove_library(root, source)
    if lib is None:
        raise HTTPException(status_code=404, detail="unknown library")
    return {"ok": True}


@app.get("/index/status")
def index_status() -> dict:
    with _state_lock:
        return dict(STATUS, count=len(PHOTOS))


@app.get("/index/secondary/status")
def index_secondary_status() -> dict:
    return secondary_index.status()


@app.post("/index/secondary/background")
def index_secondary_background() -> dict:
    """Drop background indexing to a single quiet thread (used by 'Run in
    background', so the gallery opens while indexing continues unobtrusively)."""
    secondary_index.set_mode("background")
    return secondary_index.status()


@app.post("/index/secondary/foreground")
def index_secondary_foreground() -> dict:
    """Push indexing back to full speed (a thread per core). Lets the user resume
    the fast indexing screen from the gallery without restarting the app."""
    secondary_index.set_mode("foreground")
    return secondary_index.status()


# --------------------------------------------------------------------------- #
# People + search. "Tags" are people only for now (locations / OCR text later).
# --------------------------------------------------------------------------- #

@app.get("/people")
def people_list() -> dict:
    return {"people": secondary_index.list_people()}


@app.post("/people/{pid}/name")
def people_set_name(pid: int, payload: dict) -> dict:
    name = secondary_index.set_person_name(pid, str(payload.get("name", "")))
    return {"ok": True, "name": name}


@app.post("/people/merge")
def people_merge(payload: dict) -> dict:
    try:
        source = int(payload["source"])
        target = int(payload["target"])
    except (KeyError, ValueError, TypeError):
        raise HTTPException(status_code=400, detail="source and target ids required")
    try:
        return {"ok": True, **secondary_index.merge_people(source, target)}
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown person")


def _face_crop_response(photo_id: str, bbox, request: Request) -> Response:
    """A square headshot JPEG cropped around `bbox` in the given photo.

    The stored box is in the analysis-image coordinate space, so we decode the
    source at the same size used during indexing, crop a padded square around
    the face, and return a small JPEG.

    Cached via revalidation (ETag + no-cache) rather than a fixed max-age. The
    ETag is keyed on the source photo id (a hash of the file path, so unique
    across libraries) and the face box, so a repeat view is a cheap 304 but the
    avatar can never be reused for a different library's person: `/people/1/face`
    is the same URL in every library, yet person 1's cover photo differs, so the
    ETag differs and the webview refetches instead of serving a stale crop.
    """
    if not bbox:
        raise HTTPException(status_code=404, detail="no face")

    etag = 'W/"' + hashlib.sha1(f"{photo_id}:{bbox}".encode("utf-8")).hexdigest()[:16] + '"'
    revalidate = {"ETag": etag, "Cache-Control": "no-cache"}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=revalidate)

    photo = BY_ID.get(photo_id)
    if not photo:
        raise HTTPException(status_code=404, detail="photo missing")

    img = imaging.load_for_analysis(photo["path"], secondary_index.DETECTION_INPUT_SIZE)
    if img is None:
        raise HTTPException(status_code=404, detail="cannot read photo")

    x, y, w, h = bbox
    iw, ih = img.size
    # A padded square around the face, clamped to stay fully inside the image so
    # the crop never distorts when resized.
    side = min(max(w, h) * 1.6, iw, ih)
    half = side / 2
    cx = min(max(x + w / 2, half), iw - half)
    cy = min(max(y + h / 2, half), ih - half)
    left, top = int(cx - half), int(cy - half)
    crop = img.crop((left, top, left + int(side), top + int(side)))
    crop = crop.resize((256, 256), Image.LANCZOS)

    buf = io.BytesIO()
    crop.save(buf, "JPEG", quality=88)
    return Response(
        content=buf.getvalue(),
        media_type="image/jpeg",
        headers=revalidate,
    )


@app.get("/people/{pid}/face")
def people_face(pid: int, request: Request):
    """A square headshot crop for a person's avatar (their cover face)."""
    cover = secondary_index.person_cover(pid)
    if not cover:
        raise HTTPException(status_code=404, detail="no face for person")
    return _face_crop_response(cover["photo_id"], cover.get("bbox"), request)


@app.get("/photo/{pid}/faces")
def photo_faces(pid: str) -> dict:
    """Every face detected in one photo, with the person each belongs to."""
    return {"faces": secondary_index.photo_faces(pid)}


@app.get("/photo/{pid}/face/{idx}")
def photo_face_crop(pid: str, idx: int, request: Request):
    """A square crop of one detected face in a photo (by detection index)."""
    return _face_crop_response(pid, secondary_index.face_box(pid, idx), request)


@app.get("/photo/{pid}/location")
def photo_location(pid: str) -> dict:
    """Where one photo was taken (place + coordinates), or null if unknown."""
    return {"location": secondary_index.photo_location(pid)}


@app.get("/search")
def search(q: str = "", limit: int = 200) -> dict:
    photos = secondary_index.search_photos(q, limit)
    return {"query": q, "count": len(photos), "photos": photos}


@app.post("/index/scan")
def index_scan() -> dict:
    if STATUS["state"] == "scanning":
        return {"started": False, "reason": "already scanning"}
    threading.Thread(target=scan_library, daemon=True).start()
    return {"started": True}


@app.get("/index")
def get_index() -> JSONResponse:
    with _state_lock:
        return JSONResponse(
            {
                "tile_grids": TILE_GRIDS,
                "thumb_size": THUMB_SIZE,
                "tile_px": TILE_PX,
                "count": len(PHOTOS),
                "photos": PHOTOS,
                # A token unique to the active library (its index-folder name),
                # so the frontend can version every asset URL and no library's
                # cached bytes (mega-tiles, thumbnails, ...) can be reused for
                # another. Position-keyed URLs like /megatile/4/0 are otherwise
                # identical across libraries and collide in the webview cache.
                "library": imaging.ACTIVE_LIBRARY["dir"]
                if imaging.ACTIVE_LIBRARY
                else "",
            }
        )


def _serve_file(path, media_type: str) -> FileResponse:
    if not path.exists():
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(path, media_type=media_type)


@app.get("/thumb/{pid}")
def get_thumb(pid: str) -> FileResponse:
    return _serve_file(THUMB_DIR / f"{pid}.jpg", "image/jpeg")


@app.get("/megatile/{grid}/{tile}")
def get_megatile(grid: int, tile: int) -> FileResponse:
    # Full tiles are JPEG; the last (partial) tile of a level is a transparent PNG.
    out = imaging.tile_dir(grid)
    png = out / f"tile_{tile}.png"
    if png.exists():
        return FileResponse(png, media_type="image/png")
    return _serve_file(out / f"tile_{tile}.jpg", "image/jpeg")


@app.get("/photo/{pid}")
def get_photo(pid: str):
    photo = BY_ID.get(pid)
    if not photo:
        raise HTTPException(status_code=404, detail="unknown photo")

    src = Path(photo["path"])
    if not src.exists():
        raise HTTPException(status_code=404, detail="file missing")

    ext = photo.get("ext", src.suffix.lower())
    if ext in VIDEO_EXTS:
        # Stream the original video straight from disk. FileResponse honors the
        # Range header, so the viewer can seek/scrub without downloading it all.
        media = {
            ".mp4": "video/mp4",
            ".m4v": "video/mp4",
            ".mov": "video/quicktime",
            ".webm": "video/webm",
            ".avi": "video/x-msvideo",
            ".mkv": "video/x-matroska",
        }.get(ext, "application/octet-stream")
        return FileResponse(src, media_type=media)

    if ext in WEB_DISPLAYABLE:
        # Web-native formats stream straight from the original file. Nothing is
        # copied; FileResponse reads the original on disk.
        media = "image/jpeg"
        if ext == ".png":
            media = "image/png"
        elif ext == ".gif":
            media = "image/gif"
        elif ext == ".webp":
            media = "image/webp"
        return FileResponse(src, media_type=media)

    # Other formats (HEIC, TIFF, ...) are converted to JPEG in memory and
    # streamed. We deliberately do NOT write a copy to disk; the browser caches
    # the response for the session, so re-opening the same photo is free without
    # costing any disk space.
    try:
        with Image.open(src) as img:
            img = ImageOps.exif_transpose(img).convert("RGB")
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=90)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"convert failed: {exc}")
    return Response(
        content=buf.getvalue(),
        media_type="image/jpeg",
        headers={"Cache-Control": "max-age=3600"},
    )
