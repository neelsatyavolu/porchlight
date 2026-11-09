#!/bin/bash
# Usage: scripts/snap.sh <out-dir> [name-filter]
#        scripts/snap.sh --ios-check
# Builds the Porchlight-Snapshots debug tool and writes PNGs of the Mac screens
# (Snapshots/SnapshotMain.swift) to <out-dir>, dark and light, nothing on screen.
# --ios-check only compiles the iPhone app (no simulator, no signing).
# One build at a time: a lock directory makes parallel callers wait their turn.
set -euo pipefail
cd "$(dirname "$0")/.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
LOCK="${TMPDIR:-/tmp}/porchlight-snap.lock"
until mkdir "$LOCK" 2>/dev/null; do sleep 3; done
trap 'rmdir "$LOCK"' EXIT

DERIVED=build/snap
build() {
  local scheme="$1" dest="$2" log="$DERIVED/$1.log"
  mkdir -p "$DERIVED"
  xcodegen generate >/dev/null
  if ! nice -n 15 xcodebuild -project Porchlight.xcodeproj -scheme "$scheme" -configuration Debug -destination "$dest" \
      -jobs 4 -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO build > "$log" 2>&1; then
    grep -E "error:" "$log" | sort -u >&2
    echo "build of $scheme failed (full log: $log)" >&2
    exit 1
  fi
}

if [[ "${1:-}" == "--ios-check" ]]; then
  build Porchlight-iOS 'generic/platform=iOS'
  echo "ios-check: Porchlight-iOS compiles"
  exit 0
fi

OUT="${1:?usage: scripts/snap.sh <out-dir> [name-filter]}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
build Porchlight-Snapshots 'platform=macOS'
BIN="$DERIVED/Build/Products/Debug/Porchlight-Snapshots.app/Contents/MacOS/Porchlight-Snapshots"
PORCHLIGHT_SNAPSHOTS="$OUT" PORCHLIGHT_SNAPSHOT_ONLY="${2:-}" "$BIN"
