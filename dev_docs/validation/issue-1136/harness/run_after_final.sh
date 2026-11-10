#!/usr/bin/env bash
# Issue #1136 — AFTER evidence run (implementation head, Lead-provided SHA).
#
# Same synthetic harness as run_before.sh: route-mocked Research Gateway +
# synthetic host page + real fork Next.js app in embedded mode, then captures
# R1–R5 at 1440x900 / 1024x768 (fresh browser context per scene, gateway reset
# per scene).
#
# Usage:
#   WT_AFTER=/path/to/fork-after AFTER_SHA=<40-hex-head> ./run_after_final.sh
#
# Preconditions: $WT_AFTER is a git worktree of the fork repo (node_modules
# available) and ports 8913 (Next dev), 8974 (host), 8941 (gateway) are free.
# The gateway/host may already be running from the BEFORE run; this script only
# starts what is missing.
set -uo pipefail

WT_AFTER="${WT_AFTER:?usage: WT_AFTER=<path-to-after-worktree> AFTER_SHA=<sha> ./run_after_final.sh}"
AFTER_SHA="${AFTER_SHA:?usage: WT_AFTER=... AFTER_SHA=<sha> ./run_after_final.sh}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EVIDENCE="$(cd "$HERE/.." && pwd)"
LOGS="$EVIDENCE/logs"
DEV_PORT=8913
HOST_PORT=8974
GATEWAY_PORT=8941

mkdir -p "$LOGS" "$EVIDENCE/screenshots/after"
echo "== AFTER evidence run: worktree=$WT_AFTER sha=$AFTER_SHA =="
date -Iseconds

# 1) ensure the worktree is exactly at the requested head
git -C "$WT_AFTER" checkout -- frontend/src/lib/embedded/config.ts 2>/dev/null || true
git -C "$WT_AFTER" checkout --detach "$AFTER_SHA" || { echo "checkout failed"; exit 2; }
git -C "$WT_AFTER" log --oneline -1

# 2) harness-only config.ts patch (static NEXT_PUBLIC_* member access)
python3 - "$WT_AFTER/frontend/src/lib/embedded/config.ts" <<'PY'
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

# 3) synthetic gateway + host page (idempotent: skip if already healthy)
cd "$HERE"
if ! curl -sf "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null; then
  nohup node gateway_mock.js "$GATEWAY_PORT" > "$LOGS/gateway.log" 2>&1 &
  GW_PID=$!
fi
if ! curl -sf "http://127.0.0.1:$HOST_PORT/health" >/dev/null; then
  nohup node host_server.js "$HOST_PORT" "http://127.0.0.1:$DEV_PORT/research?legacy=1" > "$LOGS/host-after.log" 2>&1 &
  HOST_PID=$!
fi
trap 'kill ${GW_PID:-} ${HOST_PID:-} ${DEV_PID:-} 2>/dev/null || true' EXIT

# 4) restart Next dev for the AFTER worktree
PID=$(ss -ltnp 2>/dev/null | grep ":$DEV_PORT " | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "${PID:-}" ] && kill "$PID" 2>/dev/null && sleep 1
(
  cd "$WT_AFTER/frontend" || exit 1
  NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1 \
  NEXT_PUBLIC_RD_EMBEDDED_MODE=1 \
  NEXT_PUBLIC_RD_GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT" \
  NEXT_PUBLIC_RD_PARENT_ORIGIN="http://127.0.0.1:$HOST_PORT" \
  nohup node_modules/.bin/next dev --webpack -p "$DEV_PORT" > "$LOGS/dev-after.log" 2>&1 &
  echo $!
) > /tmp/issue1136-dev-after.pid
DEV_PID=$(cat /tmp/issue1136-dev-after.pid)

echo "waiting for dev server on $DEV_PORT ..."
for _ in $(seq 1 150); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$DEV_PORT/research" || true)
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || { echo "dev server did not become ready (last=$code)"; tail -30 "$LOGS/dev-after.log"; exit 3; }
curl -sf "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null || { echo "gateway not up"; exit 4; }
curl -sf "http://127.0.0.1:$HOST_PORT/health" >/dev/null || { echo "host not up"; exit 5; }

# 5) capture
cd "$HERE"
node capture.js --phase=after --host="http://127.0.0.1:$HOST_PORT/" --head="$AFTER_SHA"
echo "capture exit=$?"

# 6) record + restore harness-only patch (dev server keeps running only if
#    the caller wants the local verification step next; this script stops it)
PID=$(ss -ltnp 2>/dev/null | grep ":$DEV_PORT " | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true
git -C "$WT_AFTER" checkout -- frontend/src/lib/embedded/config.ts
{
  echo "AFTER_SHA=$AFTER_SHA"
  git -C "$WT_AFTER" rev-parse HEAD
  git -C "$WT_AFTER" status --porcelain
  date -Iseconds
} | tee "$LOGS/after-head.txt"
echo "== done =="
