<p align="center">
  <img src="./src/assets/icon.png" width="128" height="128">
  <h1 align='center'>Camera Roll</h1>
</p>

A personal photo browser for making large iPhone backups usable again.

I have years of iPhone photos sitting on my Windows PC as nested backup folders.
In that format they are practically unusable: 
- there is no gallery view
- there is no proper searchability/indexing
- HEIC/HEIF & HEVC format support is not great

As a result, the backup, whose original goal was to preserve memories accessibly acts as more of an emergency archive (and it isn't even good at that, since searchability is so poor). The goal was an app that turns the mess back into something I actually want to look through.

This is a private (mostly vibe coded) tool, not a product. It is not meant for public distro, deployment, or running on someone else's machine. It exists to make my own library browsable and searchable.

## What it does today

- Points at a folder of photos (including HEIC/HEIF from iPhone) and indexes everything underneath it, no matter how deeply nested.
- Sorts the whole library by capture time, pulled from EXIF where available and falling back to the file's modification time.
- Shows a single continuous camera-roll grid with smooth zoom, a detail viewer, and a filmstrip for moving between photos.
- Converts non-web formats (HEIC, TIFF, BMP) to JPEG on the fly for display.
- Indexes images (currently by capture time and by faces within the images, eventually location from EXIF data as well as OCR text) so they can be inspected, and most importantly, *searched*!

## How it's built

A Tauri desktop shell with a React frontend and a Python backend that does the
image work.

- **`src/`** — React + TypeScript + Tailwind UI. The grid, detail viewer, filmstrip, zoom stepper, and frosted-glass chrome. UI conventions are defined in [AGENTS.md](./AGENTS.md) and followed throughout.
- **`src-tauri/`** — the Rust/Tauri shell. Applies the native window blur and spawns/tears down the Python backend as a sidecar process. See `src-tauri/src/lib.rs`.
- **`server/`** — a FastAPI backend that indexes the library and serves the index, thumbnails, mega-tiles, and full images over a local HTTP port. The heavy lifting (thumbnailing, tile composition) runs across a process pool. See `server/app.py` and `server/imaging.py`.

The frontend talks to the backend directly over `http://127.0.0.1:8756` (see `src/lib/photoApi.ts`).

## Running it

1. **Frontend + Tauri deps**

```bash
npm install
```

2. **Backend** — from `server/`, create a virtualenv and install dependencies (the app auto-detects `server/.venv`; see [server/README.md](./server/README.md)):

```bash
python -m venv .venv
.venv\Scripts\Activate.ps1   # Windows PowerShell
pip install -r requirements.txt
```

3. **Config** — create a `config.yaml` (read by `server/imaging.py`) pointing at your library and a location to drop all the indexing-related files:

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

The first run indexes the whole library (this can take a while for large backups); subsequent runs are incremental and only process new or removed files. Face indexing happens optionally asynchronously (due to large indexing times) and can happen while the user is on the app.

## Next steps

The goal is to turn a flat camera roll into a library you can actually search by
who, what, and where. Roughly in order:

### 1. People (face recognition) [DONE]
Run images through a face-recognition model during indexing to detect **persistent faces** across the library. Cluster recurring faces into "people" in the index so you can open a selection for a single person and see every photo they appear in.

### 2. Unified search [MOSTLY DONE]
Tie all forms of tags (including People) together into one **comprehensive search** so a single natural query spans all of them. The target experience is typing something like:

> ajaya boston jan 2025

and getting back the photos of that person, at that place, around that time. This works for people (and groups of people!) but will continue to evolve as more types of tags emerge.

### 3. Location and metadata
Index by **capture location** (GPS from EXIF) and other metadata fields, so photos can be grouped and filtered by place, device, date range, and similar.

### 4. Text in images (OCR)
Index images with OCR so we know which photos contain text. This powers a **"Has text"** album (screenshots signs, documents, whiteboards) and feeds the search index so text inside a photo becomes findable.
