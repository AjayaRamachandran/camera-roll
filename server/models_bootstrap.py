"""
First-run face-model bootstrap.

The face engine (faces.py) needs two ONNX models: an SCRFD detector and an
ArcFace recognizer. Rather than bundle ~280 MB into the installer or ask the
user to download them by hand, this module fetches them once, in the background,
the first time a library is indexed, and drops the two files into the shared
models folder (`<indexes_root>/models`).

It is intentionally dependency-free (stdlib only: urllib + zipfile), so the
download never pulls in numpy/onnxruntime and can run while the rest of the app
is usable. If the download fails (offline, moved URL) the face pass simply parks
with a reason, exactly as it did before, and everything else keeps working.

Public API used by secondary_index.py:
    models_present(models_dir) -> bool
    ensure_models_async(models_dir, on_done=None) -> None
    status() -> dict            # {state, downloaded, total, error}
"""

import os
import shutil
import threading
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable, Optional

# InsightFace "buffalo_l" pack (pinned release). The zip holds several models;
# we keep only the detector and the ArcFace recognizer faces.py expects and drop
# the rest (the extra landmark / gender-age models would confuse the recognizer
# auto-detection in faces._classify_sessions).
BUFFALO_L_URL = (
    "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
)
WANTED = ("det_10g.onnx", "w600k_r50.onnx")

_lock = threading.Lock()
_thread: Optional[threading.Thread] = None
# state: idle | downloading | extracting | done | error
_state = {"state": "idle", "downloaded": 0, "total": 0, "error": None}


def _set(**kw) -> None:
    with _lock:
        _state.update(kw)


def status() -> dict:
    """A snapshot of the download progress, safe to call from any thread."""
    with _lock:
        return dict(_state)


def models_present(models_dir) -> bool:
    """True if the folder already holds enough models for the face engine.

    faces.py needs at least two .onnx files (a detector + a recognizer); if the
    user has already placed their own, we never download. Cheap: a glob, no load.
    """
    if not models_dir:
        return False
    d = Path(models_dir)
    if not d.exists():
        return False
    return len(list(d.glob("*.onnx"))) >= 2


def ensure_models_async(models_dir, on_done: Optional[Callable[[], None]] = None) -> None:
    """Start a one-off background download if the models are missing.

    No-op if the models are already present or a download is already running.
    `on_done` (if given) is called once the thread finishes, success or not, so
    the caller can wake its worker and re-plan (the models may now be ready).
    """
    global _thread
    if models_present(models_dir):
        return
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        _thread = threading.Thread(
            target=_run,
            args=(Path(models_dir), on_done),
            daemon=True,
            name="models-bootstrap",
        )
        _thread.start()


def _run(models_dir: Path, on_done: Optional[Callable[[], None]]) -> None:
    try:
        models_dir.mkdir(parents=True, exist_ok=True)
        tmp = models_dir / "buffalo_l.zip.part"
        _download(tmp)
        _extract(tmp, models_dir)
        try:
            tmp.unlink()
        except OSError:
            pass
        if not models_present(models_dir):
            raise RuntimeError("expected face models were not found in the download")
        _set(state="done", error=None)
        print(f"[backend] face models ready in {models_dir}")
    except Exception as exc:
        _set(state="error", error=str(exc))
        print(f"[backend] face model download failed: {exc}")
    finally:
        if on_done is not None:
            try:
                on_done()
            except Exception:
                pass


def _download(dest: Path) -> None:
    _set(state="downloading", downloaded=0, total=0, error=None)
    req = urllib.request.Request(BUFFALO_L_URL, headers={"User-Agent": "CameraRoll"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length") or 0)
        _set(total=total)
        downloaded = 0
        with open(dest, "wb") as fh:
            while True:
                chunk = resp.read(1 << 20)  # 1 MiB
                if not chunk:
                    break
                fh.write(chunk)
                downloaded += len(chunk)
                _set(downloaded=downloaded)


def _extract(zip_path: Path, models_dir: Path) -> None:
    _set(state="extracting")
    with zipfile.ZipFile(zip_path) as z:
        for member in z.namelist():
            name = os.path.basename(member)
            if name in WANTED:
                with z.open(member) as src, open(models_dir / name, "wb") as dst:
                    shutil.copyfileobj(src, dst)
