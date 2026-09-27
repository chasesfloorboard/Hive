#!/usr/bin/env bash
# Build the Windows x64 release zip (Hive-<version>-Win-x64.zip) on Linux.
#
#   scripts/build-windows.sh            -> dist/Hive-<version>-Win-x64.zip
#
# Needs: node/npm, python3, bsdtar, objdump, curl, 7z, git, wine (electron-builder
# uses it to stamp the exe's icon and version info). Downloads are cached under
# build/windows (HIVE_WIN_WORK overrides it).
#
# What goes in:
#   - the app: a clean export of git-tracked files only (the checkout also holds
#     personal data -- Hive Data, backups, logs -- which must never ship), with
#     production dependencies installed fresh
#   - resources/native/beehive-gstreamer-player.exe: app/native/gstreamer-player.c
#     cross-compiled with Zig against MSYS2's GStreamer
#   - resources/GStreamer: the minimal GStreamer runtime for PLUGINS below,
#     resolved from real DLL imports (scripts/windows-gstreamer-runtime.py)
#   - resources/python-runtime: the python.org embeddable Python, which runs the
#     tag writer and the library database worker (main.js sets BEEHIVE_PYTHON)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('$ROOT/package.json').version")"
WORK="${HIVE_WIN_WORK:-$ROOT/build/windows}"
ZIG_VERSION=0.16.0
PYTHON_VERSION=3.13.15
ELECTRON_BUILDER=electron-builder@26.15.3
# Playback (playbin, volume, spectrum, format/rate conversion), Windows output
# (WASAPI via autoaudiosink), and decoders: MP3, FLAC, Ogg Vorbis/Opus,
# WavPack, WAV, AIFF, MP4/M4A AAC, Matroska. ALAC needs FFmpeg (gst-libav),
# which adds ~150 MB, so it is not included yet.
PLUGINS=(coreelements playback typefindfunctions audioconvert audioresample volume spectrum
  autodetect wasapi wasapi2 audioparsers id3demux apetag flac mpg123 ogg vorbis opus
  wavpack wavparse isomp4 fdkaac aiff matroska)

STAGE="$WORK/stage"
mkdir -p "$WORK" "$STAGE"
rm -rf "$STAGE"/*

echo "== Zig $ZIG_VERSION"
ZIG="$WORK/zig-x86_64-linux-$ZIG_VERSION/zig"
if [ ! -x "$ZIG" ]; then
  curl -sSfL "https://ziglang.org/download/$ZIG_VERSION/zig-x86_64-linux-$ZIG_VERSION.tar.xz" | tar -xJ -C "$WORK"
fi

echo "== GStreamer runtime (MSYS2 ucrt64)"
python3 "$ROOT/scripts/windows-gstreamer-runtime.py" "$WORK/msys2" "$STAGE/GStreamer" \
  $(for p in "${PLUGINS[@]}"; do printf 'libgst%s.dll ' "$p"; done)

echo "== Native helper"
R="$WORK/msys2/root/ucrt64"
mkdir -p "$STAGE/native"
"$ZIG" cc -target x86_64-windows-gnu -O2 -Wall -Wno-unused-function \
  -I"$R/include/gstreamer-1.0" -I"$R/include/glib-2.0" -I"$R/lib/glib-2.0/include" -I"$R/include" \
  "$ROOT/app/native/gstreamer-player.c" \
  "$R/lib/libgstaudio-1.0.dll.a" "$R/lib/libgstbase-1.0.dll.a" "$R/lib/libgstreamer-1.0.dll.a" \
  "$R/lib/libgobject-2.0.dll.a" "$R/lib/libglib-2.0.dll.a" "$R/lib/libintl.dll.a" \
  -o "$STAGE/native/beehive-gstreamer-player.exe"
rm -f "$STAGE/native/"*.pdb  # debug symbols, not shipped
missing="$(objdump -p "$STAGE/native/beehive-gstreamer-player.exe" | sed -n 's/.*DLL Name: \(lib.*\)/\1/p' | while read -r d; do [ -f "$STAGE/GStreamer/bin/$d" ] || echo "$d"; done)"
[ -z "$missing" ] || { echo "helper imports DLLs missing from the runtime: $missing" >&2; exit 1; }

echo "== Python $PYTHON_VERSION (embeddable)"
PY_ZIP="$WORK/python-$PYTHON_VERSION-embed-amd64.zip"
[ -f "$PY_ZIP" ] || curl -sSfL -o "$PY_ZIP" "https://www.python.org/ftp/python/$PYTHON_VERSION/python-$PYTHON_VERSION-embed-amd64.zip"
mkdir -p "$STAGE/python-runtime"
bsdtar -xf "$PY_ZIP" -C "$STAGE/python-runtime"

echo "== Clean source export"
SRC="$WORK/app-src"
rm -rf "$SRC"; mkdir -p "$SRC"
(cd "$ROOT" && git ls-files -z --cached --others --exclude-standard | grep -zv -e '__pycache__/' -e '\.pyc$' \
  | while IFS= read -r -d '' f; do [ -e "$f" ] && printf '%s\0' "$f"; done \
  | tar --null -T - -cf -) | tar -xf - -C "$SRC"
# Production dependencies only, no install scripts: nothing Hive ships needs a
# native build, and a Linux-built optional addon must not land in a Windows zip.
(cd "$SRC" && npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --loglevel=error)

echo "== electron-builder"
node - "$ROOT/package.json" "$WORK/builder.json" "$STAGE" "$WORK/out" <<'EOF'
const [pkgPath, outPath, stage, output] = process.argv.slice(2);
const build = require(pkgPath).build;
const config = {
  ...build,
  directories: { output },
  npmRebuild: false,
  files: ['**/*', '!test/**', '!docs/**', '!tools/**', '!scripts/**', '!.github/**', '!.claude/**',
    '!resources/screenshots/**', '!*.sh', '!**/__pycache__/**', '!logs/**'],
  extraResources: [
    { from: `${stage}/native`, to: 'native' },
    { from: `${stage}/GStreamer`, to: 'GStreamer' },
    { from: `${stage}/python-runtime`, to: 'python-runtime' },
  ],
  win: { target: [{ target: 'dir', arch: ['x64'] }], icon: 'resources/hive-minimal-black.png' },
};
delete config.linux;
require('fs').writeFileSync(outPath, JSON.stringify(config, null, 2));
EOF
rm -rf "$WORK/out"
(cd "$SRC" && npx --yes "$ELECTRON_BUILDER" --win dir --x64 --config "$WORK/builder.json" --publish never)

echo "== Zip"
mkdir -p "$ROOT/dist"
ZIP="$ROOT/dist/Hive-$VERSION-Win-x64.zip"
rm -rf "$WORK/zip" "$ZIP"; mkdir -p "$WORK/zip"
cp -a "$WORK/out/win-unpacked" "$WORK/zip/Hive"
(cd "$WORK/zip" && 7z a -tzip -mx=9 "$ZIP" Hive >/dev/null)
ls -l "$ZIP"
