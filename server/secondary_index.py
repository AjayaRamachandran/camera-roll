"""
Background secondary indexing.

The main scan in app.py builds the thumbnail/mega-tile index that the gallery
needs before it can show anything. This module adds a *second* index that is
built quietly in the background once the app is usable, and keeps itself current
without ever blocking browsing.

Today there is one secondary index: faces, grouped into people. The design is
generalized so other passes (text in images, places) can be added later by
appending one `IndexType` descriptor to `REGISTRY`. Everything below is written
against the registry, not against faces specifically.

Key properties:

  * Runs on a single daemon thread, throttled, and yields entirely while the
    main scan is running so it never competes for the CPU.
  * Resumable / repairing: the per-photo records on disk ARE the cursor. On
    restart we reprocess only the photos that have no record yet, so an
    interrupted run picks up where it left off.
  * Keyed by the stable photo id, so the main scan re-sorting or rewriting the
    photo list is harmless; only the *set* of ids matters, reconciled each pass.

State lives in three JSON files in the index folder:
  faces.json          per-photo face records (also the resume cursor)
  people.json         the people table (sample embeddings per person)
  indexing_log.json   cumulative time spent indexing, across sessions
"""

import json
import os
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

import geocode
import imaging
import models_bootstrap

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #

_SEC = imaging.CONFIG["secondary_index"]
ENABLED: bool = bool(_SEC["enabled"])

_FACES_CFG = _SEC["faces"]
MAX_SAMPLES_PER_PERSON: int = int(_FACES_CFG["max_samples_per_person"])
DETECTION_INPUT_SIZE: int = int(_FACES_CFG["detection_input_size"])
MIN_PEOPLE_COUNT: int = int(_FACES_CFG["min_people_count"])

_WORKER_CFG = _SEC["worker"]
WORK_SLEEP_S: float = int(_WORKER_CFG["work_sleep_ms"]) / 1000.0
SCAN_YIELD_S: float = int(_WORKER_CFG["scan_yield_ms"]) / 1000.0
FLUSH_EVERY: int = int(_WORKER_CFG["flush_every"])
# How many of the most recently processed photos (per index type) to base the
# ETA on. The cumulative average reacts too slowly (early slow photos or a faster
# machine than last session drag the estimate off for the whole run), so we
# project from the rate over a trailing window instead. The window is measured in
# photos (not chunks) and kept per type: a chunk or two is far too few — a short
# run of easy photos (few/no faces) would crater the rate and falsely read
# "almost done" — while the per-type split stops slow face work from being priced
# at the much faster location rate.
ETA_WINDOW_UNITS: int = int(_WORKER_CFG.get("eta_window_units", 150))
# How many photos to detect faces in at once while indexing in the foreground
# (the fast, halt-the-app mode). 0 means "use a thread per CPU core". The
# background mode always uses a single thread so it stays out of the way.
FOREGROUND_WORKERS_CFG: int = int(_WORKER_CFG.get("foreground_workers", 0))


def _foreground_workers() -> int:
    return FOREGROUND_WORKERS_CFG if FOREGROUND_WORKERS_CFG > 0 else imaging.pool_workers()

# Resolved against the active library. All None until a library is set up, in
# which case the worker never starts (see start()) and nothing touches them.
INDEX_DIR = imaging.INDEX_DIR
FACES_FILE = (INDEX_DIR / "faces.json") if INDEX_DIR else None
PEOPLE_FILE = (INDEX_DIR / "people.json") if INDEX_DIR else None
LOCATIONS_FILE = (INDEX_DIR / "locations.json") if INDEX_DIR else None
LOG_FILE = (INDEX_DIR / "indexing_log.json") if INDEX_DIR else None
# User-authored names for people, kept in their own file so they survive the
# auto-built people table being pruned or rebuilt. The map is person id -> name.
ALIASES_FILE = (INDEX_DIR / "aliases.json") if INDEX_DIR else None

# --------------------------------------------------------------------------- #
# In-memory state (guarded by _sec_lock)
# --------------------------------------------------------------------------- #

_sec_lock = threading.Lock()

_faces: dict[str, dict] = {}     # photo_id -> {indexed_at, engine, faces:[...]}
# photo_id -> {indexed_at, engine, lat, lon, landmark, city, state, country,
# keywords} for geotagged photos, or {indexed_at, no_gps:true} for the rest.
_locations: dict[str, dict] = {}
_people: dict[str, dict] = {}    # person_id(str) -> {count,label,cover,samples}
_aliases: dict[str, str] = {}    # person_id(str) -> user-given name
_next_person_id: int = 1
# The on-disk faces/people/aliases are loaded once, by whichever thread needs
# them first (the worker, or a query from the HTTP layer).
_state_loaded = False

_log: dict = {"version": 1, "total_seconds": 0.0, "sessions": []}
_session: Optional[dict] = None
# Per-type rolling window of (seconds, units) for the most recently processed
# photos, each trimmed to ~ETA_WINDOW_UNITS photos. Drives the realtime ETA.
# In-memory only: a fresh session starts empty and reports no ETA until the first
# chunk fills the window (which happens almost immediately).
_recent: dict[str, deque] = {}        # type name -> deque[(seconds, units)]
_recent_units: dict[str, int] = {}    # type name -> units currently in window
_recent_seconds: dict[str, float] = {}  # type name -> seconds currently in window

_worker_state = "idle"           # idle | indexing | paused-for-scan | error
_worker_error: Optional[str] = None

# How hard the worker pushes. It starts in "foreground" (a thread per core, no
# throttle) so a fresh library indexes as fast as possible while the user waits
# on the indexing screen; "Run in background" drops it to a single, throttled
# thread so browsing stays smooth. Once the first full pass finishes, the worker
# settles into background on its own so later incremental work stays quiet.
_mode = "foreground"             # foreground | background

_changed_event = threading.Event()
_started = False
_faces_engine = None             # the lazily-imported faces module


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _set_worker_state(state: str) -> None:
    global _worker_state
    _worker_state = state


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #

def _atomic_write(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh)
    os.replace(tmp, path)


def _read_json(path: Path) -> Optional[dict]:
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        print(f"[backend] failed to read {path.name}, ignoring: {exc}")
        return None


# --- faces / people -------------------------------------------------------- #

def _load_faces() -> None:
    global _faces, _people, _next_person_id
    data = _read_json(FACES_FILE) or {}
    _faces = data.get("photos", {}) if isinstance(data, dict) else {}
    pdata = _read_json(PEOPLE_FILE) or {}
    _people = pdata.get("people", {}) if isinstance(pdata, dict) else {}
    _next_person_id = int(pdata.get("next_person_id", len(_people) + 1)) if pdata else 1


def _flush_faces() -> None:
    _atomic_write(FACES_FILE, {"version": 1, "type": "faces", "photos": _faces})
    _atomic_write(
        PEOPLE_FILE,
        {"version": 1, "next_person_id": _next_person_id, "people": _people},
    )


def _faces_done_ids() -> set[str]:
    return set(_faces.keys())


def _faces_count_done() -> int:
    return len(_faces)


def _prune_faces(valid_ids: set[str]) -> None:
    """Drop records for photos that no longer exist. People counts may drift
    slightly after deletions; that is acceptable and self-corrects over time."""
    stale = [pid for pid in _faces if pid not in valid_ids]
    for pid in stale:
        _faces.pop(pid, None)


def _faces_record_error(pid: str) -> None:
    """Mark a photo done-with-error so a bad image is not retried forever."""
    with _sec_lock:
        _faces[pid] = {"indexed_at": _now(), "faces": [], "error": "failed"}


# --- aliases (user-given names) ------------------------------------------- #

def _load_aliases() -> None:
    global _aliases
    data = _read_json(ALIASES_FILE) or {}
    _aliases = data.get("aliases", {}) if isinstance(data, dict) else {}


def _flush_aliases() -> None:
    _atomic_write(ALIASES_FILE, {"version": 1, "aliases": _aliases})


def _display_name(person_id: str) -> str:
    """The name shown for a person: their alias, or the default `Person N`."""
    return _aliases.get(person_id) or f"Person {person_id}"


def _person_photos() -> dict[int, set[str]]:
    """Reverse index person id -> set of photo ids they appear in, from _faces."""
    rev: dict[int, set[str]] = {}
    for photo_id, rec in _faces.items():
        for f in rec.get("faces", []):
            rev.setdefault(int(f["person"]), set()).add(photo_id)
    return rev


# --------------------------------------------------------------------------- #
# People classifier
# --------------------------------------------------------------------------- #

def _assign_face(embedding: list[float], photo_id: str, face_index: int) -> int:
    """Match a face embedding to an existing person, or start a new one.

    For each known person (oldest first, so person 1 is the first face ever
    seen) we compare against at most X stored sample faces and take the mean
    distance. The first person within the similarity threshold wins and we stop
    looking. If none match, a new person is created. Must run under _sec_lock.
    """
    global _next_person_id
    fe = _faces_engine
    best_pid: Optional[str] = None
    for pid, person in _people.items():
        samples = person.get("samples", [])[:MAX_SAMPLES_PER_PERSON]
        if not samples:
            continue
        mean_diff = sum(fe.distance(embedding, s) for s in samples) / len(samples)
        if mean_diff <= fe.SIMILAR_THRESHOLD:
            best_pid = pid
            break  # early exit: first matching person wins

    if best_pid is None:
        best_pid = str(_next_person_id)
        _next_person_id += 1
        _people[best_pid] = {
            "count": 0,
            "label": None,
            "cover": {"photo_id": photo_id, "face_index": face_index},
            "samples": [],
        }

    person = _people[best_pid]
    person["count"] += 1
    if len(person["samples"]) < MAX_SAMPLES_PER_PERSON:
        person["samples"].append(embedding)
    return int(best_pid)


def _process_photo_faces(photo: dict) -> None:
    """Detect + assign faces for one photo, then store its record.

    Decoding and inference (slow) run WITHOUT the lock; only the small in-memory
    state update is locked. Videos and unreadable files get an empty record so
    they still count as done and are not retried forever.
    """
    pid = photo["id"]
    if photo.get("kind") == "video":
        with _sec_lock:
            _faces[pid] = {"indexed_at": _now(), "faces": [], "skipped": "video"}
        return

    img = imaging.load_for_analysis(photo["path"], DETECTION_INPUT_SIZE)
    if img is None:
        with _sec_lock:
            _faces[pid] = {"indexed_at": _now(), "faces": [], "error": "decode"}
        return

    found = _faces_engine.detect_and_embed(img)  # slow; no lock held

    with _sec_lock:
        recs = []
        for f in found:
            person = _assign_face(f.embedding, pid, len(recs))
            recs.append(
                {
                    "bbox": list(f.bbox),
                    "person": person,
                    "det_score": f.det_score,
                    "embedding": f.embedding,
                }
            )
        _faces[pid] = {
            "indexed_at": _now(),
            "engine": _faces_engine.engine_name(),
            "faces": recs,
        }


# --------------------------------------------------------------------------- #
# Locations pass
# --------------------------------------------------------------------------- #
#
# Reverse-geocode each photo's GPS into place keywords (nearest landmark, city,
# state, country). The per-photo record on disk is the resume cursor, exactly
# like faces: a photo with no record is pending, a photo with a `no_gps` record
# is done and never retried. The heavy geocode data loads lazily inside
# geocode.reverse(); this pass only ever reads the small EXIF GPS tag itself.


# Bump when the geocoding logic changes in a way that should re-tag photos that
# were already indexed. On load, records written by an older version are dropped
# so the worker geocodes them again (cheap: GPS read + nearest-point search, no
# model). v2 added the "metro" / principal-city tag.
LOCATIONS_VERSION = 2


def _load_locations() -> None:
    global _locations
    data = _read_json(LOCATIONS_FILE) or {}
    if not isinstance(data, dict):
        _locations = {}
        return
    if data.get("version", 1) < LOCATIONS_VERSION:
        _locations = {}  # stale: force a re-geocode under the current logic
        return
    _locations = data.get("photos", {})


def _flush_locations() -> None:
    _atomic_write(
        LOCATIONS_FILE,
        {"version": LOCATIONS_VERSION, "type": "locations", "photos": _locations},
    )


def _locations_done_ids() -> set[str]:
    return set(_locations.keys())


def _locations_count_done() -> int:
    return len(_locations)


def _prune_locations(valid_ids: set[str]) -> None:
    stale = [pid for pid in _locations if pid not in valid_ids]
    for pid in stale:
        _locations.pop(pid, None)


def _locations_record_error(pid: str) -> None:
    with _sec_lock:
        _locations[pid] = {"indexed_at": _now(), "error": "failed"}


def _process_photo_locations(photo: dict) -> None:
    """Reverse-geocode one photo, then store its record.

    Reading the GPS tag and geocoding (no model, just a numpy nearest-point
    search) run WITHOUT the lock; only the small state update is locked. Photos
    with no usable GPS get a `no_gps` record so they still count as done.
    """
    pid = photo["id"]
    coords = imaging.read_gps(photo["path"])
    if coords is None:
        with _sec_lock:
            _locations[pid] = {"indexed_at": _now(), "no_gps": True}
        return

    lat, lon = coords
    fields = geocode.reverse(lat, lon)  # numpy nearest-point search; no lock held
    with _sec_lock:
        _locations[pid] = {
            "indexed_at": _now(),
            "engine": geocode.engine_name(),
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "landmark": fields["landmark"],
            "city": fields["city"],
            "metro": fields["metro"],
            "state": fields["state"],
            "country": fields["country"],
            "keywords": fields["keywords"],
        }


# --------------------------------------------------------------------------- #
# Generalized index-type registry
# --------------------------------------------------------------------------- #

@dataclass
class IndexType:
    name: str
    load: Callable[[], None]
    flush: Callable[[], None]
    done_ids: Callable[[], set[str]]
    count_done: Callable[[], int]
    process_photo: Callable[[dict], None]
    prune: Callable[[set[str]], None]
    # Mark one photo done-with-error, so a single bad file (or a per-photo
    # failure inside process_photo) is recorded against the right index and not
    # retried forever. Used by the worker's catch-all handler.
    record_error: Callable[[str], None]


def _build_faces_type() -> IndexType:
    return IndexType(
        name="faces",
        load=_load_faces,
        flush=_flush_faces,
        done_ids=_faces_done_ids,
        count_done=_faces_count_done,
        process_photo=_process_photo_faces,
        prune=_prune_faces,
        record_error=_faces_record_error,
    )


def _build_locations_type() -> IndexType:
    return IndexType(
        name="locations",
        load=_load_locations,
        flush=_flush_locations,
        done_ids=_locations_done_ids,
        count_done=_locations_count_done,
        process_photo=_process_photo_locations,
        prune=_prune_locations,
        record_error=_locations_record_error,
    )


# The progress math, worker loop, timing, and status endpoint all generalize
# over this list unchanged. Locations only joins when its bundled data is
# present; without it the pass stays off and faces are unaffected (build the
# data with server/tools/build_geo_data.py).
REGISTRY: list[IndexType] = [_build_faces_type()]
if geocode.data_available():
    REGISTRY.append(_build_locations_type())
else:
    print(
        "[backend] location indexing disabled: geocoding data not found "
        f"({geocode.DATA_DIR}); run server/tools/build_geo_data.py"
    )


# --------------------------------------------------------------------------- #
# Timing log
# --------------------------------------------------------------------------- #

def _load_log() -> None:
    global _log, _session
    data = _read_json(LOG_FILE)
    if isinstance(data, dict):
        _log = {
            "version": 1,
            "total_seconds": float(data.get("total_seconds", 0.0)),
            "sessions": list(data.get("sessions", [])),
        }
    _session = {"started": _now(), "seconds": 0.0, "photos": 0}
    _log["sessions"].append(_session)


def _flush_log() -> None:
    _atomic_write(LOG_FILE, _log)


def _accumulate_time(seconds: float, chunk: list) -> None:
    units = len(chunk)
    _log["total_seconds"] += seconds
    if _session is not None:
        _session["seconds"] += seconds
        _session["photos"] += units
    if units <= 0:
        return
    # Attribute this chunk's wall time to each index type it touched, so every
    # type's ETA uses its own observed rate (faces is far slower than locations).
    # Chunks are single-type except at a type boundary, so a per-item split by
    # count is exact in practice.
    counts: dict[str, int] = {}
    for _photo, t in chunk:
        counts[t.name] = counts.get(t.name, 0) + 1
    for name, cnt in counts.items():
        share = seconds * (cnt / units)
        dq = _recent.setdefault(name, deque())
        dq.append((share, cnt))
        _recent_units[name] = _recent_units.get(name, 0) + cnt
        _recent_seconds[name] = _recent_seconds.get(name, 0.0) + share
        # Drop the oldest samples until the window holds ~ETA_WINDOW_UNITS photos,
        # keeping the sample that crosses the threshold so one big chunk can't
        # empty it.
        while len(dq) > 1 and _recent_units[name] - dq[0][1] >= ETA_WINDOW_UNITS:
            old_seconds, old_units = dq.popleft()
            _recent_units[name] -= old_units
            _recent_seconds[name] -= old_seconds


# --------------------------------------------------------------------------- #
# Worker
# --------------------------------------------------------------------------- #

def _ensure_state_loaded() -> None:
    """Load faces/people/aliases from disk exactly once, lazily and thread-safe.

    The worker calls this at startup; the HTTP query functions call it too, so a
    People-modal or search request that arrives before (or instead of) the
    worker still sees the on-disk data.
    """
    global _state_loaded
    if _state_loaded:
        return
    with _sec_lock:
        if _state_loaded:
            return
        for t in REGISTRY:
            t.load()
        _load_aliases()
        _state_loaded = True


def _snapshot_photos() -> list[dict]:
    """Canonical photo order, copied from app.py under its own lock."""
    import app  # lazy: app imports this module, so import here to avoid a cycle
    return app.snapshot_photos()


def _is_scanning() -> bool:
    import app
    return app.STATUS.get("state") == "scanning"


def _flush_all() -> None:
    with _sec_lock:
        for t in REGISTRY:
            t.flush()
        _flush_log()


def _safe_process(item, engine_errors) -> Optional[tuple]:
    """Run one (photo, index-type) job, swallowing per-photo failures.

    Returns ("engine", message) if the face engine itself failed (models gone),
    which the caller treats as fatal for the pass; None otherwise. Decoding and
    inference happen without the lock inside process_photo, so several of these
    can run on different threads at once; only the small state update is locked.
    """
    photo, t = item
    try:
        t.process_photo(photo)
        return None
    except engine_errors as exc:
        return ("engine", str(exc))
    except Exception as exc:
        # Record an error result against this pass so a bad photo is not retried
        # forever. Routed through the index type, so a locations failure does not
        # accidentally write a faces record (or vice versa).
        print(f"[backend] {t.name} indexing skipped {photo.get('path')}: {exc}")
        t.record_error(photo["id"])
        return None


def _process_pending(pending: list, engine_errors) -> str:
    """Work through the pending jobs under the current mode.

    Foreground runs a chunk of photos per CPU core concurrently with no throttle;
    background runs one at a time with a small sleep between. Returns "done" when
    the list is exhausted, "mode-changed" if the mode was switched mid-run (so
    the caller re-plans), or "engine-error" if the engine failed.
    """
    global _worker_error
    mode = _mode
    parallel = mode == "foreground"
    workers = _foreground_workers() if parallel else 1

    with _sec_lock:
        _set_worker_state("indexing")

    pool = ThreadPoolExecutor(max_workers=workers) if workers > 1 else None
    processed_since_flush = 0
    i = 0
    try:
        while i < len(pending):
            # Stand aside entirely while the main library scan runs.
            while _is_scanning():
                with _sec_lock:
                    _set_worker_state("paused-for-scan")
                time.sleep(SCAN_YIELD_S)
            if _mode != mode:
                return "mode-changed"
            with _sec_lock:
                if _worker_state != "indexing":
                    _set_worker_state("indexing")

            chunk = pending[i : i + workers]
            i += len(chunk)

            start = time.monotonic()
            if pool is not None:
                results = list(pool.map(lambda it: _safe_process(it, engine_errors), chunk))
            else:
                results = [_safe_process(chunk[0], engine_errors)]
            _accumulate_time(time.monotonic() - start, chunk)

            for r in results:
                if r and r[0] == "engine":
                    with _sec_lock:
                        _worker_error = r[1]
                        _set_worker_state("error")
                    print(f"[backend] face indexing stopped: {r[1]}")
                    return "engine-error"

            processed_since_flush += len(chunk)
            if processed_since_flush >= FLUSH_EVERY:
                _flush_all()
                processed_since_flush = 0
            if not parallel:
                time.sleep(WORK_SLEEP_S)
        return "done"
    finally:
        if pool is not None:
            pool.shutdown(wait=True)
        _flush_all()


def _worker_loop() -> None:
    global _faces_engine, _worker_error, _mode
    # Lazy import keeps numpy/onnxruntime out of startup and lets a missing
    # dependency park just this pass instead of crashing the server.
    try:
        import faces as fe
        _faces_engine = fe
    except Exception as exc:
        with _sec_lock:
            _worker_error = f"face engine unavailable: {exc}"
            _set_worker_state("error")
        print(f"[backend] secondary index disabled: {exc}")
        return

    # First run: fetch the face models in the background if they are missing, so
    # face grouping just works without a manual download. Any other pass (e.g.
    # locations) keeps running meanwhile; faces jobs are held back below until the
    # models land, and the download wakes the worker to re-plan when it finishes.
    models_bootstrap.ensure_models_async(
        _faces_engine.MODELS_DIR, on_done=notify_index_changed
    )

    _ensure_state_loaded()
    with _sec_lock:
        _load_log()

    engine_errors = getattr(_faces_engine, "FaceEngineError", Exception)

    while True:
        photos = _snapshot_photos()
        all_ids = {p["id"] for p in photos}
        with _sec_lock:
            for t in REGISTRY:
                t.prune(all_ids)
            done_sets = {t.name: t.done_ids() for t in REGISTRY}
        # Hold back face jobs while the models are still downloading; every other
        # pass proceeds. Once the download finishes, on_done wakes us to re-plan.
        faces_ready = models_bootstrap.models_present(_faces_engine.MODELS_DIR)
        pending = [
            (p, t)
            for t in REGISTRY
            for p in photos
            if p["id"] not in done_sets[t.name]
            and (t.name != "faces" or faces_ready)
        ]

        if not pending:
            _flush_all()
            dl = models_bootstrap.status()["state"] in ("downloading", "extracting")
            with _sec_lock:
                if _worker_error is None:
                    _set_worker_state("downloading-models" if dl else "idle")
            # The first full pass is done; settle into background so any later
            # incremental work (new photos) stays quiet without halting the app.
            # While the models are still downloading we stay in the foreground so
            # the setup screen keeps showing its progress instead of vanishing.
            if _mode == "foreground" and not dl:
                _mode = "background"
            _changed_event.wait()
            _changed_event.clear()
            continue

        reason = _process_pending(pending, engine_errors)
        if reason == "engine-error":
            return
        # "done" or "mode-changed": loop and re-plan under the current mode.


# --------------------------------------------------------------------------- #
# Public API (called from app.py)
# --------------------------------------------------------------------------- #

def start() -> None:
    """Launch the background worker once. No-op if disabled, already running, or
    no library is set up yet (nothing to index, and no folder to write to)."""
    global _started
    if _started or not ENABLED or not imaging.has_library():
        return
    _started = True
    threading.Thread(target=_worker_loop, daemon=True, name="secondary-index").start()


def notify_index_changed() -> None:
    """Wake the worker so it picks up photos added by a fresh library scan."""
    _changed_event.set()


def set_mode(mode: str) -> None:
    """Switch indexing intensity.

    'foreground' uses a thread per core with no throttle (fast, halts the app);
    'background' uses a single throttled thread so browsing stays smooth. The
    worker checks the mode between chunks, so a switch takes effect right away.
    """
    global _mode
    if mode in ("foreground", "background") and mode != _mode:
        _mode = mode
        _changed_event.set()


def status() -> dict:
    """Progress across every secondary index type, plus a cross-session ETA."""
    photos = _snapshot_photos()
    n = len(photos)
    with _sec_lock:
        num_types = len(REGISTRY)
        total_units = n * num_types
        done_units = sum(t.count_done() for t in REGISTRY)
        spent = _log["total_seconds"]
        recent_units = dict(_recent_units)
        recent_seconds = dict(_recent_seconds)
        per_type = {}
        per_type_remaining = {}
        for t in REGISTRY:
            entry = {"done": t.count_done(), "total": n}
            if t.name == "faces":
                entry["people"] = len(_people)
            per_type[t.name] = entry
            per_type_remaining[t.name] = max(0, n - t.count_done())
        state = _worker_state
        error = _worker_error
        mode = _mode

    if total_units <= 0:
        percent, frac = 100.0, 1.0
    else:
        frac = done_units / total_units
        percent = 100.0 * frac

    remaining_units = max(0, total_units - done_units)
    # Project each type's remaining work from its own trailing rate, summing into
    # one ETA. A type with no samples yet (e.g. the next type hasn't started)
    # borrows the overall rate so its work is still counted. With no samples at
    # all (the worker just (re)started) we report no ETA rather than projecting
    # from the stale cumulative average, which on a resume reads as a near-zero
    # "almost done" while real work remains.
    total_recent_units = sum(recent_units.values())
    total_recent_seconds = sum(recent_seconds.values())
    if remaining_units <= 0:
        remaining = 0.0
    elif total_recent_units > 0 and total_recent_seconds > 0:
        global_rate = total_recent_seconds / total_recent_units
        remaining = 0.0
        for name, rem in per_type_remaining.items():
            if rem <= 0:
                continue
            ru = recent_units.get(name, 0)
            rs = recent_seconds.get(name, 0.0)
            rate = (rs / ru) if ru > 0 and rs > 0 else global_rate
            remaining += rate * rem
    else:
        remaining = None

    return {
        "enabled": ENABLED,
        "state": state,
        "mode": mode,
        "percent": round(percent, 1),
        "done_units": done_units,
        "total_units": total_units,
        "num_types": num_types,
        "eta_seconds": round(remaining, 1) if remaining is not None else None,
        "time_spent_seconds": round(spent, 1),
        "per_type": per_type,
        "error": error,
        # First-run face-model download progress, so the UI can show "Setting up
        # face search". state is idle until a download is actually needed.
        "models": models_bootstrap.status(),
    }


# --------------------------------------------------------------------------- #
# People + tag search (called from app.py)
# --------------------------------------------------------------------------- #
#
# "Tags" are people only for now. Locations and OCR text are planned; when they
# arrive they become additional sources feeding the same search, so callers and
# the frontend keep talking to one search endpoint.


def list_people(min_count: int = MIN_PEOPLE_COUNT) -> list[dict]:
    """People to show in the People view, most photographed first.

    A person qualifies if they appear in at least `min_count` distinct photos,
    OR the user has given them a name (named people always show, even below the
    threshold, since naming says "this person matters to me"). Returns
    `{id, name, count, has_alias}`; the count is distinct photos.
    """
    _ensure_state_loaded()
    with _sec_lock:
        rev = _person_photos()
        people = []
        for spid in _people:
            count = len(rev.get(int(spid), set()))
            has_alias = spid in _aliases
            if count < min_count and not has_alias:
                continue
            people.append(
                {
                    "id": int(spid),
                    "name": _display_name(spid),
                    "count": count,
                    "has_alias": has_alias,
                }
            )
    people.sort(key=lambda p: p["count"], reverse=True)
    return people


def set_person_name(person_id: int, name: str) -> str:
    """Set (or clear, when blank) a person's name. Returns the resulting name."""
    spid = str(person_id)
    name = (name or "").strip()
    _ensure_state_loaded()
    with _sec_lock:
        if name:
            _aliases[spid] = name
        else:
            _aliases.pop(spid, None)
        _flush_aliases()
        return _display_name(spid)


def merge_people(source_id: int, target_id: int) -> dict:
    """Fold one person into another: every face of `source` becomes `target`.

    The target survives (keeping its name unless it has none, in which case it
    inherits the source's). Used when the auto-grouping split one person into
    two and the user drags them together. Returns the target's resulting name.
    """
    if source_id == target_id:
        return {"id": target_id, "name": _display_name(str(target_id))}
    ss, ts = str(source_id), str(target_id)
    _ensure_state_loaded()
    with _sec_lock:
        if ss not in _people or ts not in _people:
            raise KeyError("unknown person")

        for rec in _faces.values():
            for f in rec.get("faces", []):
                if int(f["person"]) == source_id:
                    f["person"] = target_id

        src = _people.pop(ss)
        tgt = _people[ts]
        tgt["count"] = tgt.get("count", 0) + src.get("count", 0)
        tgt["samples"] = (tgt.get("samples", []) + src.get("samples", []))[
            :MAX_SAMPLES_PER_PERSON
        ]
        if not tgt.get("cover"):
            tgt["cover"] = src.get("cover")

        # Keep the target's name; only inherit the source's if the target is
        # still unnamed. Either way the source's alias is dropped.
        if ts not in _aliases and ss in _aliases:
            _aliases[ts] = _aliases[ss]
        _aliases.pop(ss, None)

        _flush_faces()
        _flush_aliases()
        return {"id": target_id, "name": _display_name(ts)}


def person_cover(person_id: int) -> Optional[dict]:
    """The cover face for a person's avatar: `{photo_id, face_index, bbox}`."""
    spid = str(person_id)
    _ensure_state_loaded()
    with _sec_lock:
        person = _people.get(spid)
        if not person:
            return None
        cover = person.get("cover") or {}
        photo_id = cover.get("photo_id")
        face_index = int(cover.get("face_index", 0))
        rec = _faces.get(photo_id)
        if not rec:
            return None
        faces_list = rec.get("faces", [])
        if face_index >= len(faces_list):
            return None
        return {
            "photo_id": photo_id,
            "face_index": face_index,
            "bbox": faces_list[face_index].get("bbox"),
        }


def photo_faces(photo_id: str) -> list[dict]:
    """The faces detected in one photo, with the person each belongs to.

    Returns one entry per face: `{index, person_id, name, count, known}`, where
    `known` means the person is named or appears in enough photos to show in the
    People view. The info panel uses `known` to flag faces that still need
    sorting (the question-mark badge).
    """
    _ensure_state_loaded()
    with _sec_lock:
        rec = _faces.get(photo_id)
        if not rec:
            return []
        rev = _person_photos()
        out = []
        for idx, f in enumerate(rec.get("faces", [])):
            pid = int(f["person"])
            spid = str(pid)
            count = len(rev.get(pid, set()))
            has_alias = spid in _aliases
            out.append(
                {
                    "index": idx,
                    "person_id": pid,
                    "name": _display_name(spid),
                    "count": count,
                    "known": has_alias or count >= MIN_PEOPLE_COUNT,
                }
            )
    return out


def photo_location(photo_id: str) -> Optional[dict]:
    """The geocoded place for one photo, for the info panel's map.

    Returns `{lat, lon, label, query}`, or None when the photo has no usable GPS
    or has not been location-indexed yet. `label` is a human place string like
    "Boston, Massachusetts"; `query` is what the gallery search should run to
    surface every photo from the same place. The stored place fields are
    lowercase keyword tokens (what search scans), so we title-case them here for
    display.
    """
    _ensure_state_loaded()
    with _sec_lock:
        rec = _locations.get(photo_id)
        if not rec or "lat" not in rec:
            return None
        lat = rec["lat"]
        lon = rec["lon"]
        landmark = list(rec.get("landmark") or [])
        city = list(rec.get("city") or [])
        metro = list(rec.get("metro") or [])
        state = list(rec.get("state") or [])
        country = list(rec.get("country") or [])

    def phrase(tokens: list[str]) -> str:
        # The indexer appends a 2-letter code (postal abbr / ISO) next to the
        # full name; drop it for display, then title-case the remaining words.
        words = [t for t in tokens if len(t) > 2] or tokens
        return " ".join(w.capitalize() for w in words)

    # Most specific name first, then the major city it sits in (when that adds
    # something), then the region: "Cathedral, Boston, Massachusetts".
    primary = phrase(landmark) or phrase(city)
    town = phrase(metro) or phrase(city)
    region = phrase(state) or phrase(country)
    parts = [primary]
    if town and town != primary:
        parts.append(town)
    if region:
        parts.append(region)
    label = ", ".join(p for p in parts if p)

    # Click-to-search runs the broadest place that still groups well: the major
    # city, falling back to the nearest town, then landmark, then region.
    query = (
        " ".join(metro)
        or " ".join(city)
        or " ".join(landmark)
        or " ".join(state)
        or " ".join(country)
    ).strip()

    return {
        "lat": lat,
        "lon": lon,
        "label": label or "Unknown location",
        "query": query,
    }


def face_box(photo_id: str, face_index: int) -> Optional[list]:
    """The bounding box of one detected face, for cropping its avatar."""
    _ensure_state_loaded()
    with _sec_lock:
        rec = _faces.get(photo_id)
        if not rec:
            return None
        faces_list = rec.get("faces", [])
        if face_index < 0 or face_index >= len(faces_list):
            return None
        return faces_list[face_index].get("bbox")


# Month names and the common abbreviations, mapped to their 1-based month.
_MONTHS: dict[str, int] = {}
for _i, (_full, _abbr) in enumerate(
    [
        ("january", "jan"), ("february", "feb"), ("march", "mar"),
        ("april", "apr"), ("may", "may"), ("june", "jun"),
        ("july", "jul"), ("august", "aug"), ("september", "sep"),
        ("october", "oct"), ("november", "nov"), ("december", "dec"),
    ],
    start=1,
):
    _MONTHS[_full] = _i
    _MONTHS[_abbr] = _i
_MONTHS["sept"] = 9  # the other common September short form


def _is_date_token(tok: str) -> bool:
    """A 4-digit year, or a month name/abbreviation."""
    return (tok.isdigit() and len(tok) == 4) or tok in _MONTHS


def _date_match(tok: str, taken: Optional[str]) -> bool:
    """Does a date-ish token match a photo's capture time (ISO `taken`)?

    A 4-digit token matches the year; a month name/abbreviation matches the
    month. `taken` looks like "2026-02-14T..." so the year is chars 0-3 and the
    month is chars 5-6.
    """
    if not taken or len(taken) < 7:
        return False
    if tok.isdigit() and len(tok) == 4:
        return taken[0:4] == tok
    month = _MONTHS.get(tok)
    if month is not None:
        try:
            return int(taken[5:7]) == month
        except ValueError:
            return False
    return False


def search_photos(query: str, limit: int = 200) -> list[dict]:
    """Photos matching everything in `query`, newest first, capped.

    The query is split into words and every word must match (AND). A single word
    can match across three sources, and a photo qualifies for that word if ANY
    source does:

      * people   - a person whose display name contains the word (incl. the
                   default `Person N`), so clicking an unnamed person still works
      * location - a place keyword (landmark, city, state, country) contains the
                   word, so "boston", "ma", and "usa" all resolve
      * dates    - the word is a year or a month name matching the capture time

    So "ajaya boston feb 2025" keeps only photos that contain a person matching
    "ajaya", AND a place matching "boston", AND were taken in February, AND in
    2025. Words are matched case-insensitively; location/people use substring
    matching for consistency.
    """
    tokens = (query or "").lower().split()
    if not tokens:
        return []
    _ensure_state_loaded()
    import app  # lazy: avoid an import cycle (app imports this module)
    by_id = app.BY_ID
    with _sec_lock:
        rev = _person_photos()
        names = {spid: _display_name(spid).lower() for spid in _people}
        loc = {pid: rec.get("keywords", []) for pid, rec in _locations.items()}
        # For each word, the set of photos that satisfy it via any source.
        per_token: list[set[str]] = []
        for tok in tokens:
            ids: set[str] = set()
            # people
            for spid, name in names.items():
                if tok in name:
                    ids |= rev.get(int(spid), set())
            # location
            for pid, keywords in loc.items():
                if any(tok in kw for kw in keywords):
                    ids.add(pid)
            # dates (only scan photos when the word actually looks like a date)
            if _is_date_token(tok):
                for pid, rec in by_id.items():
                    if _date_match(tok, rec.get("taken")):
                        ids.add(pid)
            per_token.append(ids)
        # A photo qualifies only if it satisfies every word (intersection).
        photo_ids = set.intersection(*per_token) if per_token else set()
    records = [by_id[pid] for pid in photo_ids if pid in by_id]
    records.sort(key=lambda p: p.get("taken") or "", reverse=True)
    return records[:limit]
