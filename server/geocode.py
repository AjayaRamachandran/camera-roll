"""
Offline reverse geocoder.

Turns a latitude/longitude into human keywords: the nearest town/city, its
state/region, the country, and the closest notable landmark when one is within a
threshold. Every lookup is local. Bundled GeoNames extracts are loaded once into
numpy arrays, and a coarse one-degree grid keeps each query to a handful of
distance calculations, so there is no network call, no API key, and no per-photo
rate limit.

The rest of the app talks to this module through two things:

    data_available() -> bool      # are the bundled files present?
    reverse(lat, lon) -> dict     # {landmark, city, state, country, keywords}

The data files live in server/geodata and are produced by
tools/build_geo_data.py. If they are absent this module reports unavailable and
the locations index simply does not register, so face indexing is unaffected.
"""

import math
import re
import threading
from pathlib import Path
from typing import Optional

import imaging

_CFG = imaging.CONFIG.get("locations", {})
LANDMARK_THRESHOLD_M: float = float(_CFG.get("landmark_threshold_m", 750))

# Where the bundled extracts live. Empty config -> server/geodata, which is what
# tauri.conf.json ships and what resolve_server_dir points at in both dev and
# release, so the same path works either way.
_dir_cfg = (_CFG.get("data_dir") or "").strip()
DATA_DIR = Path(_dir_cfg) if _dir_cfg else (Path(__file__).resolve().parent / "geodata")

CITIES_FILE = DATA_DIR / "cities.npz"
LANDMARKS_FILE = DATA_DIR / "landmarks.npz"
ADMIN1_FILE = DATA_DIR / "admin1.tsv"
COUNTRIES_FILE = DATA_DIR / "countries.tsv"


class GeoDataError(RuntimeError):
    """Raised when the bundled geocoding data is missing or unreadable."""


def engine_name() -> str:
    return "geonames-offline"


def data_available() -> bool:
    """True if every bundled data file is present. Cheap: no numpy, just stat."""
    return (
        CITIES_FILE.exists()
        and LANDMARKS_FILE.exists()
        and ADMIN1_FILE.exists()
        and COUNTRIES_FILE.exists()
    )


# --------------------------------------------------------------------------- #
# Lazy load (mirrors faces.py: numpy and the arrays only come in on first use)
# --------------------------------------------------------------------------- #

_lock = threading.Lock()
_loaded = False
_np = None
_cities: dict = {}        # lat, lon, name, admin1, cc  (parallel numpy arrays)
_landmarks: dict = {}     # lat, lon, name
_city_grid: dict = {}     # (floor_lat, floor_lon) -> list[int] row indices
_landmark_grid: dict = {}
_admin1: dict = {}        # "US.MA" -> "Massachusetts"
_countries: dict = {}     # "US" -> {"iso3": "USA", "name": "United States"}


def _load_npz(np, path: Path, with_meta: bool) -> dict:
    with np.load(path, allow_pickle=False) as z:
        out = {
            "lat": z["lat"].astype("float64"),
            "lon": z["lon"].astype("float64"),
            "name": z["name"],
        }
        if with_meta:
            out["admin1"] = z["admin1"]
            out["cc"] = z["cc"]
            # Older data files predate the population column; treat them as all
            # zero so the "principal city" pass simply finds nothing extra.
            out["pop"] = (
                z["pop"].astype("int64")
                if "pop" in z.files
                else np.zeros(len(out["lat"]), dtype="int64")
            )
    return out


def _build_grid(lat, lon) -> dict:
    grid: dict = {}
    for i in range(len(lat)):
        key = (math.floor(lat[i]), math.floor(lon[i]))
        grid.setdefault(key, []).append(i)
    return grid


def _load_kv(path: Path) -> dict:
    out: dict = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2 and parts[0]:
                out[parts[0]] = parts[1]
    return out


def _load_countries(path: Path) -> dict:
    out: dict = {}
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 3 and parts[0]:
                out[parts[0]] = {"iso3": parts[1], "name": parts[2]}
            elif len(parts) == 2 and parts[0]:
                out[parts[0]] = {"iso3": "", "name": parts[1]}
    return out


def _ensure_loaded() -> None:
    global _loaded, _np, _cities, _landmarks, _city_grid, _landmark_grid
    global _admin1, _countries
    if _loaded:
        return
    with _lock:
        if _loaded:
            return
        if not data_available():
            raise GeoDataError(
                f"geocoding data not found in {DATA_DIR}; "
                "run server/tools/build_geo_data.py"
            )
        import numpy as np  # lazy: keep numpy out of import-time cost

        _np = np
        _cities = _load_npz(np, CITIES_FILE, with_meta=True)
        _landmarks = _load_npz(np, LANDMARKS_FILE, with_meta=False)
        _city_grid = _build_grid(_cities["lat"], _cities["lon"])
        _landmark_grid = _build_grid(_landmarks["lat"], _landmarks["lon"])
        _admin1 = _load_kv(ADMIN1_FILE)
        _countries = _load_countries(COUNTRIES_FILE)
        _loaded = True


# --------------------------------------------------------------------------- #
# Nearest-point search
# --------------------------------------------------------------------------- #

def _candidates(lat: float, lon: float, grid: dict, radius: int) -> list[int]:
    ci, cj = math.floor(lat), math.floor(lon)
    idxs: list[int] = []
    for di in range(-radius, radius + 1):
        for dj in range(-radius, radius + 1):
            cell = grid.get((ci + di, cj + dj))
            if cell:
                idxs.extend(cell)
    return idxs


def _nearest(lat: float, lon: float, arrays: dict, grid: dict):
    """Index of the closest point and its distance in metres, or (None, inf).

    Looks in the photo's one-degree cell and its neighbours first (a few hundred
    points at most), widening the ring only in sparse regions, then falling back
    to a full scan if a cell somehow has nothing nearby.
    """
    np = _np
    n = len(arrays["lat"])
    if n == 0:
        return None, float("inf")

    idxs: list[int] = []
    radius = 1
    while radius <= 4 and not idxs:
        idxs = _candidates(lat, lon, grid, radius)
        radius += 1
    idx = np.arange(n) if not idxs else np.array(idxs)

    plat = arrays["lat"][idx]
    plon = arrays["lon"][idx]
    # Vectorized haversine over just the candidate set.
    r = 6371000.0
    phi1 = math.radians(lat)
    phi2 = np.radians(plat)
    dphi = np.radians(plat - lat)
    dlmb = np.radians(plon - lon)
    a = np.sin(dphi / 2.0) ** 2 + math.cos(phi1) * np.cos(phi2) * np.sin(dlmb / 2.0) ** 2
    dist = 2.0 * r * np.arcsin(np.minimum(1.0, np.sqrt(a)))
    k = int(np.argmin(dist))
    return int(idx[k]), float(dist[k])


def _metro_radius_km(pop: int) -> float:
    """How far a city of this size reaches out from its centroid.

    A coarse population-to-reach ladder. GeoNames stores a city as one point at
    its centre, so to decide whether a photo lies "in" that city we give bigger
    cities a wider footprint. Tuned so a major metro (Boston, ~620k) claims its
    outer neighbourhoods a few km from downtown, while a small town only claims
    its immediate surroundings.
    """
    if pop >= 5_000_000:
        return 40.0
    if pop >= 1_000_000:
        return 30.0
    if pop >= 500_000:
        return 22.0
    if pop >= 200_000:
        return 15.0
    if pop >= 100_000:
        return 12.0
    if pop >= 50_000:
        return 8.0
    return 0.0


def _principal_city(lat: float, lon: float):
    """Index of the major city whose footprint contains the point, or None.

    Nearest-centroid alone misses the obvious city when a photo sits in one of
    its neighbourhoods, whose own GeoNames point is closer than the city centre
    (a Mission Hill photo is nearest to "Roxbury Crossing", not "Boston"). So we
    also look among nearby populous cities for the most populous one whose
    population-scaled radius reaches the point, and tag the photo with it. That
    is what makes such a photo searchable as "Boston".
    """
    np = _np
    n = len(_cities["lat"])
    if n == 0:
        return None

    # Same neighbourhood gather as _nearest; one-degree cells (~111 km) cover
    # the widest metro radius many times over.
    idxs: list[int] = []
    radius = 1
    while radius <= 4 and not idxs:
        idxs = _candidates(lat, lon, _city_grid, radius)
        radius += 1
    if not idxs:
        return None

    idx = np.array(idxs)
    big = idx[_cities["pop"][idx] >= 50_000]
    if len(big) == 0:
        return None

    plat = _cities["lat"][big]
    plon = _cities["lon"][big]
    r = 6371000.0
    phi1 = math.radians(lat)
    a = (
        np.sin(np.radians(plat - lat) / 2.0) ** 2
        + math.cos(phi1) * np.cos(np.radians(plat)) * np.sin(np.radians(plon - lon) / 2.0) ** 2
    )
    dist_km = (2.0 * r * np.arcsin(np.minimum(1.0, np.sqrt(a)))) / 1000.0
    bpop = _cities["pop"][big]
    reach = np.array([_metro_radius_km(int(p)) for p in bpop])

    within = dist_km <= reach
    if not within.any():
        return None
    cand = big[within]
    # The most populous city that reaches the point wins, so a metro outranks a
    # large neighbourhood sharing the same ground.
    return int(cand[int(np.argmax(_cities["pop"][cand]))])


# --------------------------------------------------------------------------- #
# Keyword shaping
# --------------------------------------------------------------------------- #

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> list[str]:
    """Lowercase word tokens, e.g. 'Christian Science Center' -> the 3 words."""
    return _TOKEN_RE.findall((text or "").lower())


def _state_tokens(admin1_code: str, cc: str) -> list[str]:
    toks: list[str] = []
    name = _admin1.get(admin1_code)
    if name:
        toks.extend(_tokens(name))
    # For the US the admin1 subcode IS the postal abbreviation (US.MA -> "ma").
    if cc == "US" and "." in admin1_code:
        sub = admin1_code.split(".", 1)[1]
        if sub.isalpha() and len(sub) == 2 and sub.lower() not in toks:
            toks.append(sub.lower())
    return toks


def _country_tokens(cc: str) -> list[str]:
    toks: list[str] = []
    info = _countries.get(cc)
    if info:
        toks.extend(_tokens(info["name"]))
        iso3 = (info.get("iso3") or "").lower()
        if iso3 and iso3 not in toks:
            toks.append(iso3)
    if cc and cc.lower() not in toks:
        toks.append(cc.lower())
    return toks


def reverse(lat: float, lon: float) -> dict:
    """Place keywords for a coordinate.

    Returns the place fields as separate lowercase keyword lists (landmark,
    city, metro, state, country), plus a de-duplicated `keywords` union of them
    all (what search scans). The landmark list is empty unless a notable place
    is within LANDMARK_THRESHOLD_M; `metro` is empty unless a populous city's
    footprint reaches the point.
    """
    _ensure_loaded()
    out = {"landmark": [], "city": [], "metro": [], "state": [], "country": []}

    ci, _ = _nearest(lat, lon, _cities, _city_grid)
    if ci is not None:
        out["city"] = _tokens(str(_cities["name"][ci]))
        out["state"] = _state_tokens(str(_cities["admin1"][ci]), str(_cities["cc"][ci]))
        out["country"] = _country_tokens(str(_cities["cc"][ci]))

    # The major city the point falls within (often different from the nearest
    # centroid). Kept separate from `city` so it widens search without muddying
    # the most-specific place name used for display.
    mi = _principal_city(lat, lon)
    if mi is not None:
        out["metro"] = _tokens(str(_cities["name"][mi]))

    li, ldist = _nearest(lat, lon, _landmarks, _landmark_grid)
    if li is not None and ldist <= LANDMARK_THRESHOLD_M:
        out["landmark"] = _tokens(str(_landmarks["name"][li]))

    seen: set[str] = set()
    keywords: list[str] = []
    for field in ("landmark", "city", "metro", "state", "country"):
        for tok in out[field]:
            if tok not in seen:
                seen.add(tok)
                keywords.append(tok)
    out["keywords"] = keywords
    return out
