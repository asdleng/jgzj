#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="${SUPERSPLAT_VIEWER_VERSION:-1.26.0}"
TARGET_DIR="${THREE_DGS_SUPERSPLAT_VIEWER_ROOT:-$ROOT_DIR/.runtime/three-dgs/supersplat-viewer}"
WORK_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

cd "$WORK_DIR"
npm pack "@playcanvas/supersplat-viewer@$VERSION" >/dev/null
tar -xzf "playcanvas-supersplat-viewer-$VERSION.tgz"

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp package/public/index.html "$TARGET_DIR/index.html"
cp package/public/index.css "$TARGET_DIR/index.css"
cp package/public/index.js "$TARGET_DIR/index.js"
cp package/LICENSE "$TARGET_DIR/LICENSE"
python3 "$ROOT_DIR/scripts/patch_supersplat_viewer_html.py" "$TARGET_DIR/index.html"
python3 "$ROOT_DIR/scripts/patch_supersplat_viewer_js.py" "$TARGET_DIR/index.js"
cat > "$TARGET_DIR/settings.json" <<'JSON'
{
  "version": 2,
  "tonemapping": "linear",
  "highPrecisionRendering": false,
  "background": {
    "color": [0.02, 0.03, 0.05]
  },
  "postEffectSettings": {
    "sharpness": { "enabled": false, "amount": 0 },
    "bloom": { "enabled": false, "intensity": 0.1, "blurLevel": 2 },
    "grading": {
      "enabled": false,
      "brightness": 1,
      "contrast": 1,
      "saturation": 1,
      "tint": [1, 1, 1]
    },
    "vignette": {
      "enabled": false,
      "intensity": 0.5,
      "inner": 0.3,
      "outer": 0.75,
      "curvature": 1
    },
    "fringing": { "enabled": false, "intensity": 0.5 }
  },
  "cameras": [
    {
      "initial": {
        "position": [0, 2, -5],
        "target": [0, 0, 0],
        "fov": 75
      }
    }
  ],
  "animTracks": [],
  "annotations": [],
  "startMode": "default"
}
JSON

echo "installed SuperSplat Viewer $VERSION to $TARGET_DIR"
