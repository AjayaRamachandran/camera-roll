"""
First-run ffmpeg bootstrap.

Video indexing needs `ffmpeg` (extract a thumbnail frame) and `ffprobe` (read
duration + capture time). Neither ships with Windows, and the packaged app does
not bundle them (to keep the installer small), so the first time a library that
contains videos is scanned this module downloads a small static build in the
background and drops `ffmpeg.exe` + `ffprobe.exe` into a per-user bin folder
(`%APPDATA%/CameraRoll/bin`). imaging.py then prefers those over anything on PATH.

Like models_bootstrap.py this is stdlib-only (urllib + zipfile), so it pulls in
no extra dependency and can run while the rest of the app is usable. If the
download fails (offline, moved URL) videos are simply skipped, exactly as before,
and photos are unaffected. Windows-only: on other platforms it no-ops and video
tools are expected on PATH (the app targets Windows).

Public API used by app.py / imaging.py:
    ffmpeg_present() -> bool
    ffmpeg_path() / ffprobe_path() -> Optional[Path]
    ensure_ffmpeg_async(on_success=None) -> None
    status() -> dict            # {state, downloaded, total, error}
"""

import os
import shutil
import threading
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable, Optional

# Gyan.dev "essentials" build: the canonical, officially linked Windows ffmpeg
# build and the smallest one that still includes ffprobe. The URL is the stable
# always-latest-release alias, so it does not rot as versions age. The zip nests
# the binaries under `ffmpeg-<ver>-essentials_build/bin/`; we extract by basename
# so the versioned folder name does not matter.
FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
WANTED = ("ffmpeg.exe", "ffprobe.exe")

_lock = threading.Lock()
_thread: Optional[threading.Thread] = None
# state: idle | downloading | extracting | done | error
_state = {"state": "idle", "downloaded": 0, "total": 0, "error": None}


def _bin_dir() -> Path:
    """Per-user folder the downloaded binaries live in (install-independent)."""
    if os.name == "nt":
        base = os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming")
    else:
        base = os.environ.get("XDG_DATA_HOME") or (Path.home() / ".local" / "share")
    return Path(base) / "CameraRoll" / "bin"


BIN_DIR = _bin_dir()


def _set(**kw) -> None:
    with _lock:
        _state.update(kw)


def status() -> dict:
    """A snapshot of the download progress, safe to call from any thread."""
    with _lock:
        return dict(_state)


def ffmpeg_path() -> Optional[Path]:
    p = BIN_DIR / "ffmpeg.exe"
    return p if p.exists() else None


def ffprobe_path() -> Optional[Path]:
    p = BIN_DIR / "ffprobe.exe"
    return p if p.exists() else None


def ffmpeg_present() -> bool:
    """True once both downloaded binaries are in place."""
    return ffmpeg_path() is not None and ffprobe_path() is not None


def ensure_ffmpeg_async(on_success: Optional[Callable[[], None]] = None) -> None:
    """Start a one-off background download if the binaries are missing.

    No-op if they are already present, a download is already running, or a prior
    attempt this session failed (so a re-scan triggered by the failure cannot spin
    up an endless retry loop; the next app launch tries again with a clean state).
    `on_success`, if given, is called only when the download succeeds, so the
    caller can re-scan and pick up the videos it skipped.
    """
    global _thread
    if os.name != "nt":
        return  # only the Windows static build is fetched; elsewhere use PATH
    if ffmpeg_present():
        return
    with _lock:
        if _state["state"] == "error":
            return
        if _thread is not None and _thread.is_alive():
            return
        _thread = threading.Thread(
            target=_run,
            args=(on_success,),
            daemon=True,
            name="ffmpeg-bootstrap",
        )
        _thread.start()


def _run(on_success: Optional[Callable[[], None]]) -> None:
    try:
        BIN_DIR.mkdir(parents=True, exist_ok=True)
        tmp = BIN_DIR / "ffmpeg.zip.part"
        _download(tmp)
        _extract(tmp, BIN_DIR)
        try:
            tmp.unlink()
        except OSError:
            pass
        if not ffmpeg_present():
            raise RuntimeError("ffmpeg/ffprobe were not found in the download")
        _set(state="done", error=None)
        print(f"[backend] ffmpeg ready in {BIN_DIR}")
        if on_success is not None:
            try:
                on_success()
            except Exception:
                pass
    except Exception as exc:
        _set(state="error", error=str(exc))
        print(f"[backend] ffmpeg download failed, videos will be skipped: {exc}")


def _download(dest: Path) -> None:
    _set(state="downloading", downloaded=0, total=0, error=None)
    req = urllib.request.Request(FFMPEG_URL, headers={"User-Agent": "CameraRoll"})
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


def _extract(zip_path: Path, bin_dir: Path) -> None:
    _set(state="extracting")
    with zipfile.ZipFile(zip_path) as z:
        for member in z.namelist():
            name = os.path.basename(member)
            if name in WANTED:
                with z.open(member) as src, open(bin_dir / name, "wb") as dst:
                    shutil.copyfileobj(src, dst)
