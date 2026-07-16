"""
Library registry: which photo folders the app knows about, where each one's
index lives, and which one is currently being viewed.

Layout on disk:
  <indexes_root>/
    libraries.json          # the registry (this module owns it)
    <library-dir-1>/        # one folder per source library
      index.json, thumbnails/, megatiles/, faces.json, people.json, ...
    <library-dir-2>/
    models/                 # face models, shared across every library

The indexes_root itself is chosen by the user on first launch. Its location is
remembered in a tiny pointer file in the OS app-data directory, so the app can
find it again next time independently of the (version-controlled, hand-commented)
config.yaml. config.yaml's `index_dir` is only consulted as the initial default.
"""

import hashlib
import json
import os
import re
import shutil
from pathlib import Path
from typing import Optional

# Loose index artifacts that belong to a single library. Used by the one-time
# migration that adopts a pre-existing (flat) Indexes folder as library #1.
# `models` is deliberately excluded: it is shared across libraries.
LIBRARY_ARTIFACTS = (
    "index.json",
    "thumbnails",
    "megatiles",
    "faces.json",
    "people.json",
    "locations.json",
    "aliases.json",
    "indexing_log.json",
)


# --------------------------------------------------------------------------- #
# App-data pointer to the indexes root
# --------------------------------------------------------------------------- #

def _app_data_dir() -> Path:
    """A stable per-user folder for the app's own bootstrap state."""
    if os.name == "nt":
        base = os.environ.get("APPDATA") or (Path.home() / "AppData" / "Roaming")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or (Path.home() / ".config")
    return Path(base) / "CameraRoll"


def _state_file() -> Path:
    return _app_data_dir() / "state.json"


def _load_state() -> dict:
    try:
        with open(_state_file(), "r", encoding="utf-8") as fh:
            return json.load(fh) or {}
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _save_state(state: dict) -> None:
    path = _state_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)


def resolve_indexes_root(config: dict) -> Optional[Path]:
    """Where all per-library index folders live, or None if not set up yet.

    Prefers the user's chosen root (remembered in app-data); falls back to the
    `index_dir` default in config.yaml so an existing install keeps working with
    no setup prompt.
    """
    saved = (_load_state().get("indexes_root") or "").strip()
    if saved:
        return Path(saved)
    default = (config.get("index_dir") or "").strip()
    if default:
        return Path(default)
    return None


def set_indexes_root(path: str) -> Path:
    """Remember the user's chosen indexes root and create it."""
    root = Path(path)
    root.mkdir(parents=True, exist_ok=True)
    state = _load_state()
    state["indexes_root"] = str(root)
    _save_state(state)
    return root


# --------------------------------------------------------------------------- #
# The per-root registry (libraries.json)
# --------------------------------------------------------------------------- #

def _registry_file(root: Path) -> Path:
    return root / "libraries.json"


def load_registry(root: Path) -> dict:
    try:
        with open(_registry_file(root), "r", encoding="utf-8") as fh:
            reg = json.load(fh) or {}
    except (FileNotFoundError, json.JSONDecodeError):
        reg = {}
    reg.setdefault("current", None)
    reg.setdefault("libraries", [])
    return reg


def save_registry(root: Path, reg: dict) -> None:
    root.mkdir(parents=True, exist_ok=True)
    with open(_registry_file(root), "w", encoding="utf-8") as fh:
        json.dump(reg, fh, indent=2)


def _norm(source: str) -> str:
    """Canonical form of a source path for stable comparison and hashing."""
    return str(Path(source)).rstrip("\\/").lower()


def _dir_name(source: str) -> str:
    """A unique, human-recognizable folder name for a library's index.

    Sanitized folder basename plus a short hash of the full path, so two folders
    that share a basename (e.g. two "Photos" folders) never collide.
    """
    base = Path(source).name or "library"
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("_") or "library"
    digest = hashlib.sha1(_norm(source).encode("utf-8")).hexdigest()[:8]
    return f"{slug}-{digest}"


def find_library(reg: dict, source: str) -> Optional[dict]:
    target = _norm(source)
    for lib in reg["libraries"]:
        if _norm(lib["source"]) == target:
            return lib
    return None


def current_library(root: Path) -> Optional[dict]:
    """The library entry currently selected for viewing, or None.

    If the selected library's source folder isn't reachable right now (e.g. an
    external drive that's unplugged), we never remove or touch its registry
    entry or index data — the drive may come back. Instead we just prefer
    another registered library that IS currently reachable, so the app still
    opens onto something usable rather than showing a "folder not found"
    error. The switch is persisted (like a normal library switch) so the rest
    of the app agrees on what's current; it only happens when the previously
    current library has actually gone missing.
    """
    reg = load_registry(root)
    lib = find_library(reg, reg["current"]) if reg["current"] else None
    if lib is not None and Path(lib["source"]).exists():
        return lib

    for candidate in reg["libraries"]:
        if Path(candidate["source"]).exists():
            if _norm(candidate["source"]) != _norm(reg.get("current") or ""):
                reg["current"] = candidate["source"]
                save_registry(root, reg)
            return candidate

    # Nothing reachable: fall back to whatever's on record (even though its
    # folder is missing) so a stale/missing `current` still opens something
    # rather than dropping to the setup screen, matching prior behavior.
    return lib or (reg["libraries"][0] if reg["libraries"] else None)


def add_library(root: Path, source: str, make_current: bool = True) -> dict:
    """Register a source folder (creating its index dir) and optionally select
    it. Idempotent: re-adding an existing folder just re-selects it."""
    reg = load_registry(root)
    lib = find_library(reg, source)
    if lib is None:
        lib = {
            "source": str(Path(source)),
            "dir": _dir_name(source),
            "name": Path(source).name or str(source),
        }
        reg["libraries"].append(lib)
    (root / lib["dir"]).mkdir(parents=True, exist_ok=True)
    if make_current:
        reg["current"] = lib["source"]
    save_registry(root, reg)
    return lib


def set_current(root: Path, source: str) -> Optional[dict]:
    """Select an already-registered library for viewing."""
    reg = load_registry(root)
    lib = find_library(reg, source)
    if lib is None:
        return None
    reg["current"] = lib["source"]
    save_registry(root, reg)
    return lib


def remove_library(root: Path, source: str) -> Optional[dict]:
    """Unregister a library and delete its index folder, keeping source photos.

    Removes the registry entry and recursively deletes only that library's index
    subfolder (thumbnails, mega-tiles, faces/people/locations, etc.). The source
    photo folder is never touched, nor is the shared `models` folder. If the
    removed library was the active one, `current` falls back to the first
    remaining library (or None when none are left, dropping to setup).

    Returns the removed entry, or None if no such library was registered.
    """
    reg = load_registry(root)
    lib = find_library(reg, source)
    if lib is None:
        return None

    target = _norm(source)
    reg["libraries"] = [
        entry for entry in reg["libraries"] if _norm(entry["source"]) != target
    ]
    if reg["current"] and _norm(reg["current"]) == target:
        reg["current"] = reg["libraries"][0]["source"] if reg["libraries"] else None

    # Delete the index folder for this library only. Guard against a missing or
    # oddly-shaped entry so a bad `dir` can never escape the indexes root.
    index_dir = root / lib["dir"]
    if lib.get("dir") and index_dir.exists() and index_dir.parent == root:
        shutil.rmtree(index_dir, ignore_errors=True)

    save_registry(root, reg)
    return lib


def list_libraries(root: Optional[Path]) -> dict:
    """Registry contents shaped for the UI: each library plus a `current` flag."""
    if root is None:
        return {"current": None, "libraries": []}
    reg = load_registry(root)
    cur = _norm(reg["current"]) if reg["current"] else None
    return {
        "current": reg["current"],
        "libraries": [
            {
                "source": lib["source"],
                "name": lib.get("name") or Path(lib["source"]).name,
                "current": _norm(lib["source"]) == cur,
                # Whether the source folder is reachable right now (drive
                # plugged in, path still exists, etc). The UI disables picking
                # a library that isn't.
                "exists": Path(lib["source"]).exists(),
            }
            for lib in reg["libraries"]
        ],
    }


# --------------------------------------------------------------------------- #
# One-time migration of a pre-existing flat Indexes folder
# --------------------------------------------------------------------------- #

def migrate_legacy_if_needed(root: Path, legacy_source: Optional[str]) -> None:
    """Adopt an existing flat index as the first library.

    Earlier versions wrote thumbnails/, megatiles/, index.json, etc. directly
    into the indexes folder for a single library. If we find those loose files
    and no registry yet, move them into a per-library subfolder and register the
    old `photo_root` as library #1, so the built index is reused, not rebuilt.
    """
    if not root.exists():
        return
    reg = load_registry(root)
    if reg["libraries"]:
        return  # already migrated / already multi-library

    has_loose = any((root / name).exists() for name in LIBRARY_ARTIFACTS)
    if not has_loose or not legacy_source:
        return

    lib = {
        "source": str(Path(legacy_source)),
        "dir": _dir_name(legacy_source),
        "name": Path(legacy_source).name or str(legacy_source),
    }
    dest = root / lib["dir"]
    dest.mkdir(parents=True, exist_ok=True)
    for name in LIBRARY_ARTIFACTS:
        src = root / name
        if src.exists():
            shutil.move(str(src), str(dest / name))

    reg["libraries"].append(lib)
    reg["current"] = lib["source"]
    save_registry(root, reg)
    print(f"[backend] adopted existing index as library '{lib['name']}'")
