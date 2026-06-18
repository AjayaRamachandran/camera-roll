# Camera Roll

A personal photo browser for making large iPhone backups usable again.

I have years of iPhone photos sitting on my Windows PC as deeply nested backup folders.
In that format they are practically unusable: you cannot scroll a camera roll,
you cannot find anything, and photos that are supposed to be memories just rot
inside a folder tree nobody opens. Camera Roll turns that mess
back into something you actually want to look through.

This is a private (mostly vibe coded) tool, not a product. It is not meant for public distribution,
multi-user setups, or running on someone else's machine. It exists to make my
own library browsable, fast, and pleasant.

## What it does today

- Points at a folder of photos (including HEIC/HEIF from iPhone) and indexes
  everything underneath it, no matter how deeply nested.
- Builds square thumbnails and composes them into "mega-tiles" so the grid can
  render tens of thousands of photos smoothly at multiple zoom levels.
- Sorts the whole library by capture time, pulled from EXIF where available and
  falling back to the file's modification time.
- Shows a single continuous camera-roll grid with smooth zoom, a detail viewer,
  and a filmstrip for moving between photos.
- Converts non-web formats (HEIC, TIFF, BMP) to JPEG on the fly for display,
  without writing extra copies to disk.

## How it's built

A Tauri desktop shell with a React frontend and a Python backend that does the
image work.

- **`src/`** — React + TypeScript + Tailwind UI. The grid, detail viewer,
  filmstrip, zoom stepper, and frosted-glass chrome. UI conventions are defined
  in [AGENTS.md](./AGENTS.md) and must be followed.
- **`src-tauri/`** — the Rust/Tauri shell. Applies the native window blur and
  spawns/tears down the Python backend as a sidecar process. See
  `src-tauri/src/lib.rs`.
- **`server/`** — a FastAPI backend that indexes the library and serves the
  index, thumbnails, mega-tiles, and full images over a local HTTP port. The
  heavy lifting (thumbnailing, tile composition) runs across a process pool.
  See `server/app.py` and `server/imaging.py`.

The frontend talks to the backend directly over `http://127.0.0.1:8756`
(see `src/lib/photoApi.ts`). Image processing uses Pillow + pillow-heif rather
than OpenCV, keeping the native path light.

## Running it

1. **Frontend + Tauri deps**

   ```bash
   npm install
   ```

2. **Backend** — from `server/`, create a virtualenv and install dependencies
   (the app auto-detects `server/.venv`; see [server/README.md](./server/README.md)):

   ```bash
   python -m venv .venv
   .venv\Scripts\Activate.ps1     # Windows PowerShell
   pip install -r requirements.txt
   ```

3. **Config** — create a `config.yaml` (read by `server/imaging.py`) pointing at
   your library and an index location:

   ```yaml
   photo_root: "D:/iPhone Backup/Photos"
   index_dir: "D:/iPhone Backup/.photoviewer-index"
   thumb_size: 128
   tile_grids: [7, 15, 30]
   jpeg_quality: 80
   ```

4. **Run** — launch the desktop app, which boots the backend automatically:

   ```bash
   npm run app          # tauri dev
   ```

The first run indexes the whole library (this can take a while for large
backups); subsequent runs are incremental and only process new or removed files.

## Next steps

The goal is to turn a flat camera roll into a library you can actually search by
who, what, and where. Roughly in order:

### 1. Videos and an Albums tab
Bring videos into the same grid experience alongside photos, and add an
**Albums** tab that collects photos, videos, and GIFs together. The grid stops
being photos-only and becomes the whole roll.

### 2. People (face recognition)
Run images through a face-recognition model during indexing to detect
**persistent faces** across the library. Cluster recurring faces into "people"
in the index so you can open an album for a single person and see every photo
they appear in.

### 3. Text in images (OCR)
Index images with OCR so we know which photos contain text. This powers a
**"Has text"** album (screenshots, signs, documents, whiteboards) and feeds the
search index so text inside a photo becomes findable.

### 4. Location and metadata
Index by **capture location** (GPS from EXIF) and other metadata fields, so
photos can be grouped and filtered by place, device, date range, and similar.

### 5. Unified search
Tie People, OCR text, and location together into one **comprehensive search** so
a single natural query spans all of them. The target experience is typing
something like:

> maithili christian science center feb 2025

and getting back the photos of that person, at that place, around that time,
including ones where the place name only appears as text in the image.

## A note on scope

Camera Roll is built for one person's library on one machine. There is no auth,
no sharing, no cloud, and no intent to distribute it. Every design decision
favors making a personal archive fast and enjoyable to browse over anything to
do with being a general-purpose or shippable application.
