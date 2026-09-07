#!/bin/sh
# Rasterize build/icon.svg into build/icon.icns (and build/icon.png for the dev Dock icon).
# Uses only macOS built-ins: qlmanage, sips, iconutil.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
qlmanage -t -s 1024 -o "$tmp" build/icon.svg >/dev/null 2>&1
cp "$tmp/icon.svg.png" build/icon.png
rm -rf build/icon.iconset && mkdir -p build/icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s build/icon.png --out "build/icon.iconset/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d build/icon.png --out "build/icon.iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns build/icon.iconset -o build/icon.icns
rm -rf "$tmp"
echo "wrote build/icon.icns and build/icon.png"
