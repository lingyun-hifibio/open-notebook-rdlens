#!/usr/bin/env bash
# Issue #1017 — one side (BEFORE or AFTER) synthetic evidence run.
#
# Reproduces the harness: route-mocked Research Gateway + synthetic host page +
# real fork Next.js app in embedded mode (legacy regression entry
# /research?legacy=1), then captures the 10 scenes at 1440x900 / 1024x768
# (fresh browser context per scene; gateway reset + mode per scene).
#
# Usage:
#   SIDE=before WT_BEFORE=/path/to/baseline-copy   ./run_side.sh
#   SIDE=after  WT_AFTER=/path/to/impl-worktree    ./run_side.sh
#
# Preconditions:
#   - WT_* contains the fork frontend with `node_modules` available
#     (BEFORE copy: symlink to the shared checkout; AFTER: worktree symlink).
#   - ports 8911 (BEFORE dev) / 8913 (AFTER dev), 8972/8974 (host),
#     8941 (gateway) are free; runs are serial (one side at a time).
#   - no real backend/database/model is contacted; every request is synthetic.
#
# Note: the fork needs a harness-only `frontend/src/lib/embedded/config.ts`
# patch during capture (Next dev does not inline dynamic process.env[CONST]
# lookups); it is restored afterwards and is NOT part of any product change.
set -uo pipefail

SIDE="${SIDE:?usage: SIDE=before|after WT_BEFORE=...|WT_AFTER=... ./run_side.sh}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EVIDENCE="$(cd "$HERE/.." && pwd)"
LOGS="$EVIDENCE/logs"
mkdir -p "$LOGS" "$EVIDENCE/screenshots/$SIDE"

if [ "$SIDE" = "before" ]; then
  WT="${WT_BEFORE:?set WT_BEFORE}"
  DEV_PORT=8911
  HOST_PORT=8972
  SHA="${BEFORE_SHA:-d959635ebf5f642b6e8a75fb9a89896fe366683d}"
else
  WT="${WT_AFTER:?set WT_AFTER}"
  DEV_PORT=8913
  HOST_PORT=8974
  SHA="${AFTER_SHA:?set AFTER_SHA}"
fi
GATEWAY_PORT=8941

echo "== #1017 $SIDE evidence run: worktree=$WT head=$SHA =="
date -Iseconds

# 1) harness-only config.ts patch (static NEXT_PUBLIC_* member access)
CONFIG="$WT/frontend/src/lib/embedded/config.ts"
cp "$CONFIG" "/tmp/issue1017-config-$SIDE.orig"
python3 - "$CONFIG" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
s = p.read_text()
s = s.replace("(process.env[EMBEDDED_MODE_ENV] ?? '')", "(process.env.NEXT_PUBLIC_RD_EMBEDDED_MODE ?? '')")
s = s.replace("(process.env[GATEWAY_URL_ENV] ?? '')", "(process.env.NEXT_PUBLIC_RD_GATEWAY_URL ?? '')")
s = s.replace("(process.env[PARENT_ORIGIN_ENV] ?? '')", "(process.env.NEXT_PUBLIC_RD_PARENT_ORIGIN ?? '')")
p.write_text(s)
print("config.ts harness patch applied")
PY
sha256sum "$CONFIG" | tee "$LOGS/config-$SIDE.patched.sha256"
sha256sum "/tmp/issue1017-config-$SIDE.orig" | tee "$LOGS/config-$SIDE.original.sha256"

cleanup() {
  set +e
  [ -n "${DEV_PID:-}" ] && kill "$DEV_PID" 2>/dev/null
  [ -n "${HOST_PID:-}" ] && kill "$HOST_PID" 2>/dev/null
  [ -n "${GW_PID:-}" ] && kill "$GW_PID" 2>/dev/null
  cp "/tmp/issue1017-config-$SIDE.orig" "$CONFIG"
  echo "== config.ts restored =="
  sha256sum "$CONFIG" | tee "$LOGS/config-$SIDE.restored.sha256"
}
trap cleanup EXIT

# 2) synthetic gateway + host page
cd "$HERE"
nohup node gateway_mock.js "$GATEWAY_PORT" > "$LOGS/gateway-$SIDE.log" 2>&1 &
GW_PID=$!
nohup node host_server.js "$HOST_PORT" "http://127.0.0.1:$DEV_PORT/research?legacy=1" > "$LOGS/host-$SIDE.log" 2>&1 &
HOST_PID=$!

# 3) Next dev for the worktree under capture
(
  cd "$WT/frontend" || exit 1
  NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1 \
  NEXT_PUBLIC_RD_EMBEDDED_MODE=1 \
  NEXT_PUBLIC_RD_GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT" \
  NEXT_PUBLIC_RD_PARENT_ORIGIN="http://127.0.0.1:$HOST_PORT" \
  nohup node_modules/.bin/next dev --webpack -p "$DEV_PORT" > "$LOGS/dev-$SIDE.log" 2>&1 &
  echo $!
) > "/tmp/issue1017-dev-$SIDE.pid"
DEV_PID=$(cat "/tmp/issue1017-dev-$SIDE.pid")

echo "waiting for dev server on $DEV_PORT ..."
code=""
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$DEV_PORT/research?legacy=1" || true)
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || { echo "dev server did not become ready (last=$code)"; tail -40 "$LOGS/dev-$SIDE.log"; exit 3; }
curl -sf "http://127.0.0.1:$GATEWAY_PORT/__health" >/dev/null || { echo "gateway not up"; exit 4; }
curl -sf "http://127.0.0.1:$HOST_PORT/health" >/dev/null || { echo "host not up"; exit 5; }
echo "servers ready (dev=$DEV_PID host=$HOST_PID gateway=$GW_PID)"

# 4) capture
cd "$HERE"
node capture.js \
  --phase="$SIDE" \
  --host="http://127.0.0.1:$HOST_PORT/" \
  --head="$SHA" \
  --outdir="$EVIDENCE/screenshots/$SIDE" \
  --logfile="$EVIDENCE/capture.log" \
  --manifest="$EVIDENCE/$SIDE-manifest.json"
CAPTURE=$?
echo "capture exit=$CAPTURE"
echo "== $SIDE done =="
exit $CAPTURE
