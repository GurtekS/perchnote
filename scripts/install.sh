#!/usr/bin/env bash
# Install Perchnote.app to /Applications.
# Always does a clean replace so stale binaries are never left behind.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="$ROOT/src-tauri/target/release/bundle/macos/Perchnote.app"
BINARY="$ROOT/src-tauri/target/release/perchnote"
DEST="/Applications/Perchnote.app"

pkill -f "Perchnote" 2>/dev/null || true
sleep 1

# Prefer full bundle install; fall back to binary-only patch if bundle is stale/missing.
# The bundle can be stale when only `cargo build --release` was run (not `tauri build`).
# In that case, copy the fresh binary directly into the existing installed app.
if [[ -d "$APP_BUNDLE" ]]; then
  BUNDLE_BINARY="$APP_BUNDLE/Contents/MacOS/perchnote"
  FRESH_BINARY="$BINARY"
  if [[ -f "$FRESH_BINARY" && -f "$BUNDLE_BINARY" ]]; then
    BUNDLE_MTIME=$(stat -f%m "$BUNDLE_BINARY")
    FRESH_MTIME=$(stat -f%m "$FRESH_BINARY")
    if [[ $FRESH_MTIME -gt $BUNDLE_MTIME ]]; then
      echo "Binary is newer than bundle — patching binary into existing install."
      cp "$FRESH_BINARY" "$BUNDLE_BINARY"
    fi
  fi
  rm -rf "$DEST"
  cp -r "$APP_BUNDLE" "$DEST"
elif [[ -f "$BINARY" && -d "$DEST" ]]; then
  echo "No bundle found — patching binary into existing install at $DEST."
  cp "$BINARY" "$DEST/Contents/MacOS/perchnote"
else
  echo "No bundle found at $APP_BUNDLE — run 'npm run tauri build' first." >&2
  exit 1
fi

echo "Installed: $DEST ($(stat -f%z "$DEST/Contents/MacOS/perchnote") bytes)"
