"""
Build the bundled offline geocoding data from GeoNames.

Run this once (by a developer) to produce the compact files geocode.py loads:

    server/geodata/cities.npz       towns/cities: lat, lon, name, admin1, cc
    server/geodata/landmarks.npz    notable named places: lat, lon, name
    server/geodata/admin1.tsv       "US.MA" -> "Massachusetts"
    server/geodata/countries.tsv    "US" -> ISO3 + "United States"

It downloads the GeoNames public-domain dumps (https://www.geonames.org/, CC BY)
into a local cache, filters them, and writes the small artifacts. The cities /
admin1 / country files are a few MB; landmarks come from `allCountries` (a ~1.5GB
download), so that part is gated behind a flag and only its tiny filtered output
ships.

Usage:
    python server/tools/build_geo_data.py                 # everything
    python server/tools/build_geo_data.py --skip-landmarks # cities only (fast)
    python server/tools/build_geo_data.py --keep-altnames-only false

The downloads are cached under server/geodata/_cache and reused on re-runs.
"""

import argparse
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

GEO = "https://download.geonames.org/export/dump"
DOWNLOADS = {
    "cities500.zip": f"{GEO}/cities500.zip",
    "admin1CodesASCII.txt": f"{GEO}/admin1CodesASCII.txt",
    "countryInfo.txt": f"{GEO}/countryInfo.txt",
    "allCountries.zip": f"{GEO}/allCountries.zip",
}

OUT_DIR = Path(__file__).resolve().parent.parent / "geodata"
CACHE_DIR = OUT_DIR / "_cache"

# Cap a stored name's length so one freak 200-char entry does not widen the whole
# fixed-width numpy string column. Real place names sit well under this.
MAX_NAME = 60

# GeoNames feature codes we treat as "notable named places" for the landmark
# field. These are the kinds of places people actually search a photo by. The
# allowlist IS the notability filter; broaden or trim it to taste.
NOTABLE_CODES = {
    # historic, monuments, civic structures
    "MNMT", "HSTS", "CSTL", "PAL", "PYR", "PYRS", "RUIN", "ARCH", "TOWR",
    # culture & learning
    "MUS", "THTR", "OPRA", "LIBR", "UNIV", "CTRR", "CTRCM", "GHAT",
    # religious sites
    "CH", "CTHL", "TMPL", "MSQE", "SHRN", "CVNT", "MSTY",
    # sport, leisure, attractions
    "STDM", "ARENA", "ATHF", "AMTH", "ZOO", "GDN", "THME", "RECG", "RECR",
    # transport landmarks
    "AIRP", "RSTN", "MTRO", "PIER", "BDG", "LTHSE",
    # nature & parks (named ones people reference)
    "PRK", "RESN", "RESW", "BCH", "FLLS", "CAPE", "MT", "PK", "VOLC", "ISL",
    # urban open space / commerce
    "SQR", "MALL", "MKT", "OBS",
}


def _download(name: str, url: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    dest = CACHE_DIR / name
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  cached: {name}")
        return dest
    print(f"  downloading {name} ...")
    with urllib.request.urlopen(url) as resp, open(dest, "wb") as fh:
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            fh.write(chunk)
    print(f"  saved {name} ({dest.stat().st_size / 1e6:.1f} MB)")
    return dest


def _open_geonames_table(zip_or_txt: Path, inner_txt: str):
    """Yield split rows of a GeoNames main-table file (zipped or plain)."""
    if zip_or_txt.suffix == ".zip":
        with zipfile.ZipFile(zip_or_txt) as zf:
            with zf.open(inner_txt) as raw:
                for line in raw:
                    yield line.decode("utf-8", "replace").rstrip("\n").split("\t")
    else:
        with open(zip_or_txt, "r", encoding="utf-8") as fh:
            for line in fh:
                yield line.rstrip("\n").split("\t")


def _clean(name: str) -> str:
    return name.strip()[:MAX_NAME]


def _save_npz_points(path: Path, lats, lons, names, admin1=None, cc=None, pop=None) -> None:
    arrays = {
        "lat": np.asarray(lats, dtype="float32"),
        "lon": np.asarray(lons, dtype="float32"),
        "name": np.asarray(names),
    }
    if admin1 is not None:
        arrays["admin1"] = np.asarray(admin1)
        arrays["cc"] = np.asarray(cc)
    if pop is not None:
        arrays["pop"] = np.asarray(pop, dtype="int32")
    np.savez(path, **arrays)
    print(f"  wrote {path.name}: {len(lats):,} rows ({path.stat().st_size / 1e6:.1f} MB)")


def build_cities() -> None:
    src = _download("cities500.zip", DOWNLOADS["cities500.zip"])
    lats, lons, names, admin1, cc, pop = [], [], [], [], [], []
    for r in _open_geonames_table(src, "cities500.txt"):
        # 0 id, 2 asciiname, 4 lat, 5 lon, 6 fclass, 8 cc, 10 admin1, 14 population
        if len(r) < 15 or r[6] != "P":
            continue
        try:
            lat, lon = float(r[4]), float(r[5])
        except ValueError:
            continue
        try:
            population = int(r[14] or 0)
        except ValueError:
            population = 0
        names.append(_clean(r[2] or r[1]))
        lats.append(lat)
        lons.append(lon)
        country = r[8]
        cc.append(country)
        admin1.append(f"{country}.{r[10]}" if r[10] else country)
        # Population lets the geocoder tag a point with the major city whose
        # footprint contains it, not just the nearest (often a neighbourhood).
        pop.append(population)
    _save_npz_points(OUT_DIR / "cities.npz", lats, lons, names, admin1, cc, pop)


def build_landmarks(keep_altnames_only: bool) -> None:
    src = _download("allCountries.zip", DOWNLOADS["allCountries.zip"])
    lats, lons, names = [], [], []
    scanned = 0
    for r in _open_geonames_table(src, "allCountries.txt"):
        scanned += 1
        if scanned % 2_000_000 == 0:
            print(f"  scanned {scanned:,} rows, kept {len(lats):,} landmarks ...")
        # 1 name, 2 asciiname, 3 altnames, 4 lat, 5 lon, 7 fcode, 14 population
        if len(r) < 15 or r[7] not in NOTABLE_CODES:
            continue
        ascii_name = (r[2] or r[1]).strip()
        if not ascii_name:
            continue
        if keep_altnames_only:
            has_alt = bool(r[3].strip())
            try:
                pop = int(r[14] or 0)
            except ValueError:
                pop = 0
            if not has_alt and pop <= 0:
                continue
        try:
            lat, lon = float(r[4]), float(r[5])
        except ValueError:
            continue
        names.append(ascii_name[:MAX_NAME])
        lats.append(lat)
        lons.append(lon)
    _save_npz_points(OUT_DIR / "landmarks.npz", lats, lons, names)


def build_empty_landmarks() -> None:
    _save_npz_points(OUT_DIR / "landmarks.npz", [], [], [])


def build_admin1() -> None:
    src = _download("admin1CodesASCII.txt", DOWNLOADS["admin1CodesASCII.txt"])
    lines = []
    with open(src, "r", encoding="utf-8") as fh:
        for line in fh:
            parts = line.rstrip("\n").split("\t")
            # 0 "US.MA", 1 name, 2 asciiname
            if len(parts) >= 3 and parts[0]:
                lines.append(f"{parts[0]}\t{parts[2] or parts[1]}")
    out = OUT_DIR / "admin1.tsv"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  wrote {out.name}: {len(lines):,} regions")


def build_countries() -> None:
    src = _download("countryInfo.txt", DOWNLOADS["countryInfo.txt"])
    lines = []
    with open(src, "r", encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("#"):
                continue
            parts = line.rstrip("\n").split("\t")
            # 0 ISO2, 1 ISO3, 4 Country name
            if len(parts) >= 5 and parts[0]:
                lines.append(f"{parts[0]}\t{parts[1]}\t{parts[4]}")
    out = OUT_DIR / "countries.tsv"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"  wrote {out.name}: {len(lines):,} countries")


def main() -> int:
    ap = argparse.ArgumentParser(description="Build bundled GeoNames geocoding data.")
    ap.add_argument(
        "--skip-landmarks",
        action="store_true",
        help="skip the 1.5GB allCountries download; writes an empty landmarks file",
    )
    ap.add_argument(
        "--keep-altnames-only",
        default="true",
        help="for landmarks, keep only places with alternate names or population "
        "(true|false). Smaller, more 'notable' set when true.",
    )
    args = ap.parse_args()
    keep_altnames_only = str(args.keep_altnames_only).lower() not in ("false", "0", "no")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("Building geocoding data into", OUT_DIR)

    print("countries:")
    build_countries()
    print("admin1 regions:")
    build_admin1()
    print("cities/towns:")
    build_cities()
    print("landmarks:")
    if args.skip_landmarks:
        print("  skipped (writing empty landmarks file)")
        build_empty_landmarks()
    else:
        build_landmarks(keep_altnames_only)

    print("\nDone. Files written to", OUT_DIR)
    print("The _cache folder can be deleted; it only speeds up re-runs.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
