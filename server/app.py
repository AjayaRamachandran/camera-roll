"""
Camera Roll FastAPI server and indexing orchestration.

This module owns the index state and the HTTP API. The heavy image work lives in
imaging.py and runs across a single process pool that is reused for both the
thumbnail and mega-tile phases (creating the pool is the expensive part, so we
do it once per scan). main.py is a thin launcher that imports `app` from here.
"""

import io
import json
import os
import platform
import threading
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from PIL import Image, ImageOps

import imaging

# Pull the shared config/paths from the imaging module.
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


def load_index() -> None:
    global PHOTOS, BY_ID, _loaded_thumb_size
    if not INDEX_FILE.exists():
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
        "version": 3,
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
                if os.path.splitext(name)[1].lower() in IMAGE_EXTS:
                    found.append(os.path.join(dirpath, name))

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
    except Exception as exc:
        print(f"[backend] scan failed: {exc}")
        _set_status(state="error", message=str(exc))


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
    load_index()
    threading.Thread(target=scan_library, daemon=True).start()


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
        "photo_root": str(PHOTO_ROOT),
        "index_dir": str(INDEX_DIR),
        "thumb_size": THUMB_SIZE,
        "tile_grids": TILE_GRIDS,
        "tile_px": TILE_PX,
    }


@app.get("/index/status")
def index_status() -> dict:
    with _state_lock:
        return dict(STATUS, count=len(PHOTOS))


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
