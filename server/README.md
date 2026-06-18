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

The Rust side (`src-tauri/src/python_server.rs`) runs `python main.py` with the
`PHOTOVIEWER_PORT` environment variable set, and terminates the process when the
app exits. You never have to start this manually during normal use.

## Where to add OpenCV work

Add new endpoints to `main.py`. `cv2` is already imported. A new processing
endpoint would then be exposed to the frontend by adding:

1. a Rust proxy command in `src-tauri/src/commands.rs`,
2. a typed wrapper in `src/lib/api.ts`.
