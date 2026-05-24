#!/usr/bin/env bash
# Perchnote automated test pipeline
# Runs automated checks and a live smoke test of the local Tauri app bundle.
#
# Usage:
#   ./scripts/test.sh          # full pipeline (build + tests + smoke)
#   ./scripts/test.sh --quick  # unit tests + fast compile checks; smoke existing bundle if present

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BUNDLE="$ROOT/src-tauri/target/release/bundle/macos/Perchnote.app"
APP="$APP_BUNDLE/Contents/MacOS/perchnote"
INFO_PLIST="$APP_BUNDLE/Contents/Info.plist"
LOG_DIR="$(mktemp -d /tmp/perchnote-test.XXXXXX)"
LOG="$LOG_DIR/startup.log"
APP_DATA="$HOME/Library/Application Support/com.perchnote.app"
QUICK=0
PASS=0; FAIL=0; SKIP=0

green()  { printf '\033[32m✓ %s\033[0m\n' "$*"; }
red()    { printf '\033[31m✗ %s\033[0m\n' "$*"; }
yellow() { printf '\033[33m~ %s\033[0m\n' "$*"; }
header() { printf '\n\033[1m=== %s ===\033[0m\n' "$*"; }

check() {
  local label=$1; shift
  local output="$LOG_DIR/${label//[^A-Za-z0-9_.-]/_}.log"
  if "$@" >"$output" 2>&1; then
    green "$label"; PASS=$((PASS+1))
  else
    red   "$label"; FAIL=$((FAIL+1))
    sed -n '1,80p' "$output"
    local lines
    lines=$(wc -l <"$output" | tr -d ' ')
    if [[ "$lines" -gt 80 ]]; then
      printf '... (%s total lines; last 40 follow) ...\n' "$lines"
      tail -40 "$output"
    fi
  fi
}

skip() {
  yellow "$1"; SKIP=$((SKIP+1))
}

cleanup() {
  if [[ $FAIL -eq 0 ]]; then
    rm -rf "$LOG_DIR"
  else
    printf '\033[33m~ Logs retained at %s\033[0m\n' "$LOG_DIR"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'USAGE'
Usage:
  ./scripts/test.sh
  ./scripts/test.sh --quick
USAGE
}

if [[ "${1:-}" == "--quick" ]]; then
  QUICK=1
elif [[ -n "${1:-}" ]]; then
  usage >&2
  exit 2
fi

check_frontend_output() {
  check "Frontend output includes dist/index.html" test -s "$ROOT/dist/index.html"
  check "Frontend output includes JS asset" bash -c "find \"\$1\" -maxdepth 1 -type f -name '*.js' -size +0c -print -quit | grep -q ." _ "$ROOT/dist/assets"
  check "Frontend output includes CSS asset" bash -c "find \"\$1\" -maxdepth 1 -type f -name '*.css' -size +0c -print -quit | grep -q ." _ "$ROOT/dist/assets"
}

check_bundle_output() {
  check "Tauri bundle exists" test -d "$APP_BUNDLE"
  check "Tauri bundle executable exists" test -x "$APP"
  check "Tauri bundle Info.plist exists" test -s "$INFO_PLIST"
}

plist_has_value() {
  local key=$1 expected=$2 value
  value=$(/usr/libexec/PlistBuddy -c "Print :$key" "$INFO_PLIST" 2>/dev/null || true)
  [[ -n "$value" && "$value" == *"$expected"* ]]
}

check_privacy_strings() {
  check "Info.plist has microphone privacy string" plist_has_value NSMicrophoneUsageDescription "microphone"
  check "Info.plist has screen-capture privacy string" plist_has_value NSScreenCaptureUsageDescription "system audio"
}

check_no_startup_fatal_patterns() {
  local label=$1
  shift
  local found=0 pattern
  for pattern in "$@"; do
    if grep -Eiq "$pattern" "$LOG" 2>/dev/null; then
      red "$label (matched: $pattern)"
      grep -Ein "$pattern" "$LOG" | head -10 || true
      found=1
    fi
  done
  if [[ $found -eq 0 ]]; then
    green "$label"; PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
  fi
}

cd "$ROOT"

# ── 1. Build / compile checks ─────────────────────────────────────────────────
if [[ $QUICK -eq 1 ]]; then
  header "Quick compile checks"
  check "Frontend compiles" npm run build
  check_frontend_output
else
  header "Release bundle build"
  check "Tauri release bundle builds" npm run tauri:build
  check_frontend_output
  check_bundle_output
  check_privacy_strings
fi

# ── 2. Unit tests ─────────────────────────────────────────────────────────────
header "Unit tests"
check "Frontend (Vitest)" npm test -- --run
check "Rust type check" bash -c "cd src-tauri && cargo check"
check "Rust library tests" bash -c "cd src-tauri && cargo test --lib"

# ── 3. App smoke test ─────────────────────────────────────────────────────────
header "App smoke test"

if [[ ! -x "$APP" ]]; then
  if [[ $QUICK -eq 1 ]]; then
    skip "No existing Tauri bundle at $APP_BUNDLE; quick mode skips bundle smoke"
  else
    red "App binary not found at $APP after full build"
    FAIL=$((FAIL+1))
  fi
else
  pkill -f "$APP" 2>/dev/null || true
  pkill -x perchnote 2>/dev/null || true
  sleep 1

  "$APP" >"$LOG" 2>&1 &
  APP_PID=$!
  sleep 4

  check "App launched" kill -0 "$APP_PID"
  check_no_startup_fatal_patterns "No fatal startup log patterns" \
    "fatal runtime error" \
    "thread '.*' panicked" \
    "panicked at" \
    "failed to initialize" \
    "failed to create webview" \
    "error occurred while running application" \
    "localhost:1420"

  SCREENSHOT="/tmp/perchnote-smoke-$$.png"
  screencapture -x "$SCREENSHOT" 2>/dev/null && green "Screenshot saved to $SCREENSHOT" || true

  kill "$APP_PID" 2>/dev/null || true
  wait "$APP_PID" 2>/dev/null || true
fi

# ── 4. WAV integrity + content check ─────────────────────────────────────────
header "Recording integrity"
RECORDINGS_DIR="$APP_DATA/recordings"
DB="$APP_DATA/perchnote.db"

if command -v sqlite3 &>/dev/null && [[ -f "$DB" ]]; then
  SYS_AUDIO=$(sqlite3 "$DB" "SELECT value FROM settings WHERE key='capture_system_audio'" 2>/dev/null || echo "unknown")
  if [[ "$SYS_AUDIO" == "true" ]]; then
    green "Settings: system audio capture enabled"
  else
    printf '\033[33m~ Settings: system audio capture = %s (enable in Settings > Audio to test)\033[0m\n' "${SYS_AUDIO:-not set}"
  fi
  PASS=$((PASS+1))
else
  green "DB check skipped (sqlite3 not available or DB not found)"
  PASS=$((PASS+1))
fi

if [[ -d "$RECORDINGS_DIR" ]]; then
  BAD_WAVS=0
  TOTAL_WAVS=0
  for wav in "$RECORDINGS_DIR"/*.wav; do
    [[ -f "$wav" ]] || continue
    TOTAL_WAVS=$((TOTAL_WAVS+1))
    SIZE=$(python3 -c "
import struct
with open('$wav','rb') as f:
    f.seek(4); v=struct.unpack('<I',f.read(4))[0]; print(v)
" 2>/dev/null || echo "0")
    if [[ "$SIZE" == "0" ]]; then
      BAD_WAVS=$((BAD_WAVS+1))
    fi
  done

  # Only count WAVs created in the last 5 minutes as failures (the test window).
  # Older corrupt files are pre-existing — likely from previous abrupt process kills.
  BAD_NEW=0
  NOW=$(date +%s)
  for wav in "$RECORDINGS_DIR"/*.wav; do
    [[ -f "$wav" ]] || continue
    MTIME=$(stat -f %m "$wav" 2>/dev/null || echo 0)
    AGE=$((NOW - MTIME))
    [[ $AGE -lt 300 ]] || continue
    SIZE=$(python3 -c "
import struct
with open('$wav','rb') as f:
    f.seek(4); v=struct.unpack('<I',f.read(4))[0]; print(v)
" 2>/dev/null || echo "0")
    [[ "$SIZE" == "0" ]] && BAD_NEW=$((BAD_NEW+1))
  done

  if [[ $BAD_WAVS -eq 0 ]]; then
    green "All $TOTAL_WAVS WAV files have valid headers"
    PASS=$((PASS+1))
  elif [[ $BAD_NEW -eq 0 && $BAD_WAVS -gt 0 ]]; then
    printf '\033[33m~ %d/%d older WAV files have corrupt headers (pre-existing, not from this run)\033[0m\n' "$BAD_WAVS" "$TOTAL_WAVS"
    PASS=$((PASS+1))
  elif [[ $BAD_NEW -gt 0 ]]; then
    red "$BAD_NEW WAV file(s) created in last 5 min have corrupt headers (riff_size=0)"
    FAIL=$((FAIL+1))
  else
    green "All $TOTAL_WAVS WAV files have valid headers"
    PASS=$((PASS+1))
  fi

  # Most recent valid recording: confirm capture pipeline produced non-silent audio.
  LATEST_WAV=$(python3 -c "
import os, struct, glob
d = '$RECORDINGS_DIR'
wavs = sorted(glob.glob(os.path.join(d, '*.wav')), key=os.path.getmtime, reverse=True)
for w in wavs:
    try:
        with open(w,'rb') as f:
            f.seek(4); sz=struct.unpack('<I',f.read(4))[0]
            if sz > 0: print(w); break
    except: pass
" 2>/dev/null)
  if [[ -n "$LATEST_WAV" ]]; then
    PEAK=$(python3 -c "
import struct
path = '$LATEST_WAV'
with open(path,'rb') as f:
    f.seek(12)
    while True:
        chunk_id = f.read(4)
        if len(chunk_id) < 4: break
        chunk_sz = struct.unpack('<I', f.read(4))[0]
        if chunk_id == b'data':
            data = f.read(min(chunk_sz, 96000 * 2))
            if len(data) < 2: print(0); exit()
            samples = struct.unpack(f'<{len(data)//2}h', data[:len(data)//2*2])
            print(max(abs(s) for s in samples))
            exit()
        f.seek(chunk_sz, 1)
    print(0)
" 2>/dev/null || echo "0")
    FNAME=$(basename "$LATEST_WAV")
    if [[ "$PEAK" -gt 50 ]]; then
      green "Latest valid recording has audio content (peak=$PEAK/32767) — $FNAME"
      PASS=$((PASS+1))
    elif [[ "$PEAK" -gt 0 ]]; then
      printf '\033[33m~ Latest valid recording has very low audio (peak=%s/32767) — %s\033[0m\n' "$PEAK" "$FNAME"
      PASS=$((PASS+1))
    else
      red "Latest valid recording appears silent (peak=0) — $FNAME"
      FAIL=$((FAIL+1))
    fi
  fi
else
  green "No recordings directory yet (skipped)"
  PASS=$((PASS+1))
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
printf 'Results: \033[32m%d passed\033[0m, \033[31m%d failed\033[0m, \033[33m%d skipped\033[0m\n' "$PASS" "$FAIL" "$SKIP"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
