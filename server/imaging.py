"""
Image worker module: config, thumbnailing, and mega-tile composition.

This module is intentionally lean. It imports only what an image worker needs
(Pillow, pillow-heif, PyYAML) and NOT the web stack. The thumbnail/tile work
runs across a process pool, and on Windows every worker re-imports the modules
it touches, so keeping this free of FastAPI/uvicorn makes each worker start in
~120ms instead of ~1s. See app.py for the server that drives these functions.
"""

import hashlib
import os
from datetime import datetime
from functools import reduce
from math import gcd
from pathlib import Path
from typing import Optional

import yaml
from PIL import Image, ImageOps

# Register HEIC/HEIF support (iPhone photos). This runs in every worker process.
try:
    import pillow_heif

    pillow_heif.register_heif_opener()
    # One decode thread per process. The process pool already spans every core,
    # so letting libheif spin up its own threads per worker only oversubscribes
    # the CPU and makes HEIC decoding dramatically slower under load.
    try:
        pillow_heif.options.DECODE_THREADS = 1
    except Exception:
        pass
except Exception as exc:  # pragma: no cover
    print(f"[backend] pillow-heif unavailable, HEIC photos will be skipped: {exc}")


# Formats the webview can show directly; everything else is converted on demand.
WEB_DISPLAYABLE = {".jpg", ".jpeg", ".png", ".gif", ".webp"}
IMAGE_EXTS = WEB_DISPLAYABLE | {".heic", ".heif", ".bmp", ".tif", ".tiff"}

EXIF_DATETIME_ORIGINAL = 36867
EXIF_DATETIME_DIGITIZED = 36868
EXIF_DATETIME = 306
EXIF_ORIENTATION = 274


def _find_config() -> Path:
    here = Path(__file__).resolve().parent
    candidates = [
        here.parent / "config.yaml",
        here / "config.yaml",
        Path.cwd() / "config.yaml",
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


CONFIG_PATH = _find_config()


def load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
        cfg = yaml.safe_load(fh) or {}
    cfg.setdefault("thumb_size", 128)
    cfg.setdefault("jpeg_quality", 80)
    # Accept either the multi-level `tile_grids` list or the legacy single
    # `tile_grid`. Normalize to a sorted, de-duplicated ascending list.
    grids = cfg.get("tile_grids") or [cfg.get("tile_grid", 5)]
    cfg["tile_grids"] = sorted({int(g) for g in grids})
    return cfg


CONFIG = load_config()
PHOTO_ROOT = Path(CONFIG["photo_root"])
INDEX_DIR = Path(CONFIG["index_dir"])
THUMB_DIR = INDEX_DIR / "thumbnails"
TILE_DIR = INDEX_DIR / "megatiles"
INDEX_FILE = INDEX_DIR / "index.json"

THUMB_SIZE = int(CONFIG["thumb_size"])
# One grid dimension per zoom level (e.g. [7, 15, 30]). The smallest is the
# "primary" level, and its cells are rendered at full thumbnail resolution.
TILE_GRIDS = list(CONFIG["tile_grids"])
PRIMARY_GRID = TILE_GRIDS[0]

# TILE_PX must be divisible by every grid size so that integer cell arithmetic
# (cell = TILE_PX // grid) divides evenly with no right/bottom gap on each
# composed tile. Round THUMB_SIZE * PRIMARY_GRID up to the nearest multiple of
# the LCM of all grids.
def _lcm(a: int, b: int) -> int:
    return a * b // gcd(a, b)

_grids_lcm = reduce(_lcm, TILE_GRIDS)
_base = THUMB_SIZE * PRIMARY_GRID
TILE_PX = ((_base + _grids_lcm - 1) // _grids_lcm) * _grids_lcm
JPEG_QUALITY = int(CONFIG["jpeg_quality"])
# Decode JPEGs to ~2x the thumbnail; the draft scale then has headroom for a
# crisp resize while staying far cheaper than a full-resolution decode.
DRAFT_TARGET = THUMB_SIZE * 2


def tile_dir(grid: int) -> Path:
    """Folder holding the composed tiles for one zoom level."""
    return TILE_DIR / f"g{grid}"


for _d in (INDEX_DIR, THUMB_DIR, TILE_DIR):
    _d.mkdir(parents=True, exist_ok=True)
for _g in TILE_GRIDS:
    tile_dir(_g).mkdir(parents=True, exist_ok=True)


def photo_id(path: str) -> str:
    """Stable id from the absolute path, so re-runs reuse the same thumbnail."""
    return hashlib.sha1(path.lower().encode("utf-8")).hexdigest()[:16]


def pool_workers() -> int:
    return max(2, (os.cpu_count() or 4))


def _exif_taken(exif) -> Optional[str]:
    if not exif:
        return None
    for tag in (EXIF_DATETIME_ORIGINAL, EXIF_DATETIME_DIGITIZED, EXIF_DATETIME):
        raw = exif.get(tag)
        if raw:
            try:
                dt = datetime.strptime(str(raw).strip(), "%Y:%m:%d %H:%M:%S")
                return dt.isoformat()
            except ValueError:
                continue
    return None


def make_thumbnail(src_str: str) -> Optional[dict]:
    """Generate one square center-cropped thumbnail. Runs in a worker process."""
    src = Path(src_str)
    ext = src.suffix.lower()
    try:
        with Image.open(src) as img:
            ow, oh = img.size  # original dims, before any decode
            exif = img.getexif()
            orientation = exif.get(EXIF_ORIENTATION, 1)
            taken = _exif_taken(exif)

            # Fast JPEG decode: have the decoder emit a reduced-scale image.
            if ext in (".jpg", ".jpeg"):
                img.draft("RGB", (DRAFT_TARGET, DRAFT_TARGET))

            img = ImageOps.exif_transpose(img)
            # "Crop in": short side fits, then center-crop to a square. BILINEAR
            # is plenty at this size and much faster than LANCZOS.
            thumb = ImageOps.fit(
                img.convert("RGB"),
                (THUMB_SIZE, THUMB_SIZE),
                method=Image.BILINEAR,
                centering=(0.5, 0.5),
            )
    except Exception as exc:
        print(f"[backend] skip unreadable image {src}: {exc}")
        return None

    pid = photo_id(src_str)
    thumb.save(THUMB_DIR / f"{pid}.jpg", "JPEG", quality=JPEG_QUALITY)

    if orientation in (5, 6, 7, 8):
        width, height = oh, ow
    else:
        width, height = ow, oh

    if not taken:
        taken = datetime.fromtimestamp(src.stat().st_mtime).isoformat()
        taken_source = "file"
    else:
        taken_source = "exif"

    return {
        "id": pid,
        "path": src_str,
        "thumb": f"{pid}.jpg",
        "width": width,
        "height": height,
        "taken": taken,
        "taken_source": taken_source,
        "ext": ext,
    }


def compose_tile(payload) -> None:
    """Compose one mega-tile from its thumbnails. Runs in a worker process.

    Full tiles (every cell used) are JPEG. The final partial tile of each level
    is a PNG with a transparent background so empty cells show the app
    background instead of dark squares. Every level renders to the same TILE_PX
    canvas, so denser grids paste smaller cells (thumbnails are downscaled to
    fit); the primary grid's cells already match the thumbnail size.
    """
    grid, tile_index, names, full = payload
    cell = TILE_PX // grid
    if full:
        canvas = Image.new("RGB", (TILE_PX, TILE_PX), (20, 20, 20))
    else:
        canvas = Image.new("RGBA", (TILE_PX, TILE_PX), (0, 0, 0, 0))

    for i, name in enumerate(names):
        if not name:
            continue
        row, col = divmod(i, grid)
        try:
            with Image.open(THUMB_DIR / name) as th:
                im = th.convert("RGB")
                if im.size != (cell, cell):
                    im = im.resize((cell, cell), Image.BILINEAR)
                canvas.paste(im, (col * cell, row * cell))
        except Exception:
            continue

    out = tile_dir(grid)
    if full:
        canvas.save(out / f"tile_{tile_index}.jpg", "JPEG", quality=JPEG_QUALITY)
    else:
        canvas.save(out / f"tile_{tile_index}.png", "PNG")
