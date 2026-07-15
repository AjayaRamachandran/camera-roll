# Camera ROll — Python Backend

A small [FastAPI](https://fastapi.tiangolo.com/) server that the Tauri app
spawns as a sidecar. Today it exposes one endpoint, `/health`, and imports
OpenCV as a placeholder for future image-processing work.

## Setup (one-time)

From this `server/` directory:

```bash
# Create an isolated virtualenv. The Rust side automatically prefers
# server/.venv if it exists, so this is the recommended layout.
python -m venv .venv

# Activate it:
#   Windows (PowerShell):  .venv\Scripts\Activate.ps1
#   macOS/Linux:           source .venv/bin/activate

pip install -r requirements.txt
```

> If you skip the virtualenv, the app falls back to the `python` on your PATH,
> which must then have these packages installed.

## Run standalone (for testing without the desktop app)

```bash
python main.py
# then, in another terminal:
curl http://127.0.0.1:8756/health
```

Expected response:

```json
{ "status": "ok", "opencv_version": "4.10.0", "python_version": "3.11.9" }
```

## How it's launched in the app

The Rust side (`src-tauri/src/python_server.rs`) sets the `PHOTOVIEWER_PORT`
environment variable and terminates the process when the app exits. You never
have to start this manually during normal use. How it starts depends on the
build:

- **Dev (`tauri dev`):** runs `python main.py` from this source tree, preferring
  `server/.venv` if present.
- **Packaged (`tauri build`):** runs the self-contained executable produced by
  PyInstaller (see Packaging below). The end user needs no Python install.

## Packaging (self-contained Windows installer)

`tauri build` produces a single NSIS installer that bundles a frozen copy of
this server, so the user does not need Python or any pip packages.

The freeze is driven by `scripts/build-server.mjs` (run via `npm run
build:server`, and chained automatically from `tauri build` through the
`build:all` script). It:

1. uses `server/.venv` (which must already have `requirements.txt` installed),
2. installs PyInstaller into that venv the first time,
3. runs `server/camera-roll-server.spec` to produce
   `server/dist/camera-roll-server/` (a onedir bundle),

which `tauri.conf.json` then ships under the app's `server-bin` resource folder.
`config.yaml` and `geodata/` are embedded inside the frozen bundle (read from
`sys._MEIPASS` at runtime), so nothing external needs to sit next to the exe.

To build the installer end to end:

```bash
# one-time: create the venv and install runtime deps (see Setup above)
npm run app:build
```

The frozen server is windowed (no console), so its stdout/stderr are redirected
to `%APPDATA%\CameraRoll\backend.log` for troubleshooting installs.

## Where to add OpenCV work

Add new endpoints to `main.py`. `cv2` is already imported. A new processing
endpoint would then be exposed to the frontend by adding:

1. a Rust proxy command in `src-tauri/src/commands.rs`,
2. a typed wrapper in `src/lib/api.ts`.

## Background face indexing (models)

After the main library scan, `secondary_index.py` quietly groups the faces in
your photos into people. It runs two ONNX models through `onnxruntime`
(`faces.py`), with all pre/post-processing in numpy + Pillow (no OpenCV):

1. a **face detector** that returns boxes plus five landmarks, and
2. an **ArcFace recognizer** that turns each aligned face into a 512-d
   embedding.

These model files are not pip packages, so on first run the app downloads them
automatically (see `models_bootstrap.py`): when a library is first indexed and
no models are found, it fetches InsightFace's `buffalo_l` pack in the background,
keeps the two `.onnx` files it needs, and drops them into the models folder,
which defaults to:

```
<index_dir>/models/
```

(`index_dir` is set in `config.yaml`; override the location with
`secondary_index.faces.models_dir`.) The download is stdlib-only (no extra
dependency) and reports progress through `GET /index/secondary/status` under the
`models` field, which the setup screen shows as "Setting up face search". If it
fails (offline, moved URL), face indexing simply parks and the rest of the app
is unaffected. To supply the models yourself instead, drop any SCRFD detector
and ArcFace recognizer `.onnx` pair into the folder before indexing:

- detector: `det_10g.onnx` (SCRFD with landmarks)
- recognizer: `w600k_r50.onnx` (ArcFace, 512-d)

The engine identifies which file is which by inspecting each model (the
recognizer has a single output), so exact filenames do not matter as long as
both an SCRFD-style detector and an ArcFace recognizer are present. If the
folder or models are missing, face indexing simply parks itself and reports the
reason via `GET /index/secondary/status`; the rest of the app is unaffected.

Tunables live under `secondary_index` in `config.yaml`: `similar_threshold`
(how close two faces must be to count as the same person),
`max_samples_per_person`, `detection_input_size`, and `min_det_score`.
