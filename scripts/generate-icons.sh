#!/usr/bin/env bash
#
# Generate Windows-compatible app icons for the Tauri app from a single source
# PNG. Produces the PNG sizes referenced by tauri.conf.json plus a proper
# multi-resolution icon.ico, and stages a copy for the in-app title bar logo.
#
# Usage:
#   bash scripts/generate-icons.sh [source.png]   # defaults to ./icon.png
#
# Requires ImageMagick 7 (the `magick` command).

set -euo pipefail

SRC="${1:-icon.png}"
ICON_DIR="src-tauri/icons"
ASSET_DIR="src/assets"

if ! command -v magick >/dev/null 2>&1; then
  echo "error: ImageMagick 'magick' not found on PATH" >&2
  exit 1
fi

if [ ! -f "$SRC" ]; then
  echo "error: source image not found: $SRC" >&2
  exit 1
fi

mkdir -p "$ICON_DIR" "$ASSET_DIR"

echo "Source: $SRC ($(magick identify -format '%wx%h' "$SRC"))"

# PNG sizes Tauri references in tauri.conf.json.
echo "Generating PNG sizes..."
magick "$SRC" -background none -resize 32x32   "$ICON_DIR/32x32.png"
magick "$SRC" -background none -resize 128x128 "$ICON_DIR/128x128.png"
magick "$SRC" -background none -resize 256x256 "$ICON_DIR/128x128@2x.png"

# Multi-resolution Windows .ico. auto-resize packs every listed size into one
# file so Windows can pick the right one for the taskbar, title bar, alt-tab,
# Explorer, etc.
echo "Generating multi-resolution icon.ico..."
magick "$SRC" -background none \
  -define icon:auto-resize=256,128,96,64,48,32,16 \
  "$ICON_DIR/icon.ico"

# Copy of the source for the in-app title bar logo (imported by TitleBar.tsx).
echo "Staging title bar asset..."
cp "$SRC" "$ASSET_DIR/icon.png"

echo "Done. Wrote:"
ls -la "$ICON_DIR"
echo "and $ASSET_DIR/icon.png"
