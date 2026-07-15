"""
Camera Roll backend entry point (thin launcher).

This file is deliberately tiny. On Windows the process pool spawns workers by
re-importing the __main__ module, so keeping the heavy web stack (FastAPI,
uvicorn) out of this module's top level means each worker starts in a fraction
of the time. The actual server lives in app.py; the image workers in imaging.py.

Run:  python main.py   (PHOTOVIEWER_PORT selects the port, default 8756)

When frozen with PyInstaller (the packaged app), two extra things matter and are
handled below: the process pool re-launches this very executable to spawn its
workers, and a windowed build has no console, so `sys.stdout`/`sys.stderr` are
None and any `print()` would crash. See the two helpers in the __main__ block.
"""

import os
import sys


def _redirect_streams_if_frozen() -> None:
    """Give every process a valid stdout/stderr in a windowed frozen build.

    A PyInstaller windowed executable has `sys.stdout`/`sys.stderr` set to None,
    so any `print()` — ours or a dependency's, in the main process or a spawned
    image worker — would raise. Point both at a rolling log file in the app-data
    folder so nothing crashes and there is a support log to read after install.
    Runs before `freeze_support()` so the spawned workers get valid streams too.
    """
    if not getattr(sys, "frozen", False):
        return
    if sys.stdout is not None and sys.stderr is not None:
        return
    try:
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        log_dir = os.path.join(base, "CameraRoll")
        os.makedirs(log_dir, exist_ok=True)
        fh = open(
            os.path.join(log_dir, "backend.log"),
            "a",
            encoding="utf-8",
            buffering=1,
        )
        sys.stdout = fh
        sys.stderr = fh
    except Exception:
        # Last resort: swallow output rather than crash writing to a None stream.
        devnull = open(os.devnull, "w")
        sys.stdout = devnull
        sys.stderr = devnull


if __name__ == "__main__":
    import multiprocessing

    _redirect_streams_if_frozen()
    # Must run before anything spawns a process: in a frozen build the image
    # ProcessPoolExecutor re-launches this exe for each worker, and this call is
    # what makes the re-launched process run the worker instead of booting a
    # second web server. A no-op in a normal `python main.py` run.
    multiprocessing.freeze_support()

    import uvicorn

    from app import app

    port = int(os.environ.get("PHOTOVIEWER_PORT", "8756"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
