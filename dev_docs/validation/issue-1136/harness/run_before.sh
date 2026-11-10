#!/usr/bin/env bash
# Issue #1136 — BEFORE evidence run (fork baseline origin/main a4a76170c).
#
# Reproduces the synthetic harness: route-mocked Research Gateway + synthetic
# host page + real fork Next.js app in embedded mode, then captures R1–R5 at
# 1440x900 / 1024x768 (fresh browser context per scene, gateway reset per scene).
#
# Usage:
#   WT_BEFORE=/path/to/fork-before ./run_before.sh
#
# Expected preconditions (see README §Environment):
#   - $WT_BEFORE is a git worktree of the fork repo checked out at the BEFORE
#     revision (or any revision you want as baseline) with
#     frontend/node_modules symlinked/copied (this harness used a symlink to
#     /home/lchen/workspace/open-notebook-rdlens/frontend/node_modules).
#   - ports 8911 (Next dev), 8972 (host), 8941 (gateway) are free.
#   - no real backend/database/model is contacted; every request is synthetic.
#
# Note: the fork applies the harness-only `frontend/src/lib/embedded/config.ts`
# static-NEXT_PUBLIC_* patch during capture and reverts it afterwards (Next dev
# does not inline dynamic process.env[CONST] lookups); this is not part of any
# product change.
set -uo pipefail

WT_BEFORE="${WT_BEFORE:?usage: WT_BEFORE=<path-to-baseline-worktree> ./run_before.sh}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EVIDENCE="$(cd "$HERE/.." && pwd)"
LOGS="$EVIDENCE/logs"
DEV_PORT=8911
HOST_PORT=8972
GATEWAY_PORT=8941
SHA="${BEFORE_SHA:-a4a76170c5016d0c4cfefae505aa8369be568a96}"

mkdir -p "$LOGS" "$EVIDENCE/screenshots/before"
echo "== BEFORE evidence run: worktree=$WT_BEFORE sha=$SHA =="
date -Iseconds

# 1) harness-only config.ts patch (static NEXT_PUBLIC_* member access)
python3 - "$WT_BEFORE/frontend/src/lib/embedded/config.ts" <<'PY'
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

# 2) synthetic gateway + host page
cd "$HERE"
nohup node gateway_mock.js "$GATEWAY_PORT" > "$LOGS/gateway.log" 2>&1 &
GW_PID=$!
nohup node host_server.js "$HOST_PORT" "http://127.0.0.1:$DEV_PORT/research?legacy=1" > "$LOGS/host-before.log" 2>&1 &
HOST_PID=$!
trap 'kill $GW_PID $HOST_PID $DEV_PID 2>/dev/null || true' EXIT

# 3) Next dev for the baseline worktree
(
  cd "$WT_BEFORE/frontend" || exit 1
  NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1 \
  NEXT_PUBLIC_RD_EMBEDDED_MODE=1 \
  NEXT_PUBLIC_RD_GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT" \
  NEXT_PUBLIC_RD_PARENT_ORIGIN="http://127.0.0.1:$HOST_PORT" \
  nohup node_modules/.bin/next dev --webpack -p "$DEV_PORT" > "$LOGS/dev-before.log" 2>&1 &
  echo $!
) > /tmp/issue1136-dev-before.pid
DEV_PID=$(cat /tmp/issue1136-dev-before.pid)

echo "waiting for dev server on $DEV_PORT ..."
for _ in $(seq 1 120); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$DEV_PORT/research" || true)
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || { echo "dev server did not become ready (last=$code)"; tail -30 "$LOGS/dev-before.log"; exit 3; }
curl -sf "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null || { echo "gateway not up"; exit 4; }
curl -sf "http://127.0.0.1:$HOST_PORT/health" >/dev/null || { echo "host not up"; exit 5; }

# 4) capture
cd "$HERE"
node capture.js --phase=before --host="http://127.0.0.1:$HOST_PORT/" --head="$SHA"
echo "capture exit=$?"

# 5) restore harness-only patch
git -C "$WT_BEFORE" checkout -- frontend/src/lib/embedded/config.ts
git -C "$WT_BEFORE" status --porcelain
echo "== done =="
