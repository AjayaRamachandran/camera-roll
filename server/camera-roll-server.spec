# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the Camera Roll Python sidecar.
#
# Produces a self-contained onedir bundle (dist/camera-roll-server/) that the
# Tauri app launches directly, so end users need no Python install. onedir (not
# onefile) is deliberate: onnxruntime/pillow-heif ship native DLLs and onefile
# re-extracts them to a temp dir on every launch (slow, and often AV-flagged),
# while onedir starts fast and the library-switch restart stays snappy.
#
# Build it via `npm run build:server` (see scripts/build-server.mjs), which is
# also chained into `tauri build`.

import os

from PyInstaller.utils.hooks import (
    collect_all,
    collect_data_files,
    collect_submodules,
)

# SPECPATH is the directory holding this spec (server/), injected by PyInstaller.
SERVER_DIR = SPECPATH
REPO_DIR = os.path.dirname(SERVER_DIR)

datas = []
binaries = []
hiddenimports = []

# App modules imported dynamically (inside functions, or by string) that static
# analysis from main.py might not fully pull in on its own.
hiddenimports += [
    "app",
    "imaging",
    "libraries",
    "secondary_index",
    "geocode",
    "faces",
    "models_bootstrap",
    "ffmpeg_bootstrap",
]

# uvicorn loads its loop / protocol / lifespan implementations by string name, so
# their submodules have to be collected explicitly or the server won't boot.
hiddenimports += collect_submodules("uvicorn")
# pydantic v2 has a compiled core plus dynamically referenced submodules.
hiddenimports += collect_submodules("pydantic")

# Packages that ship native DLLs / data files: pull binaries + data + any hidden
# submodules so the frozen face engine and HEIC decoding work standalone.
#
# numpy 2.x reorganized its C-extensions under numpy._core, and PyInstaller's
# built-in hook does not fully collect them for this version (the frozen engine
# fails with "No module named 'numpy._core._exceptions'"), so collect it in full
# here. onnxruntime + numpy back both the face engine and the geocoder.
for pkg in ("numpy", "onnxruntime", "pillow_heif", "pydantic_core"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# Read-only reference data shipped inside the bundle so the sidecar is fully
# self-contained: the tuning config, and the offline geocoder's GeoNames data.
datas += [(os.path.join(REPO_DIR, "config.yaml"), ".")]
datas += [(os.path.join(SERVER_DIR, "geodata"), "geodata")]

a = Analysis(
    [os.path.join(SERVER_DIR, "main.py")],
    pathex=[SERVER_DIR],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Trim GUI toolkits we never use; keeps the bundle smaller and the build
    # cleaner. The app has no Python-side UI (Tauri owns the window).
    excludes=["tkinter", "matplotlib", "PySide6", "PyQt5", "PyQt6", "IPython"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="camera-roll-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # Windowed: no console window flashes when the app spawns the sidecar (or its
    # image workers). main.py redirects stdout/stderr to a log file for support.
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="camera-roll-server",
)
