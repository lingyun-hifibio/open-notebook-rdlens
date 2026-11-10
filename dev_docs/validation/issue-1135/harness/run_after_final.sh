#!/usr/bin/env bash
# Issue #1135 — AFTER evidence run (implementation head, Lead-provided SHA).
#
# Same synthetic harness as run_before.sh: route-mocked Research Gateway +
# synthetic host page + real fork Next.js app in embedded mode, then captures
# E1–E8 at 1440x900 / 1024x768 (fresh browser context per scene, gateway reset
# per scene; behavior driven by /tmp/issue1135-{note,enable}-mode).
#
# Usage:
#   WT_AFTER=/path/to/fork-after AFTER_SHA=<40-hex-head> ./run_after_final.sh
#
# Preconditions: $WT_AFTER is a git worktree of the fork repo (node_modules
# available) and ports 8933 (Next dev), 8992 (host), 8961 (gateway) are free.
# The gateway/host may already be running from the BEFORE run; this script only
# starts what is missing and stops what it started.
set -uo pipefail

WT_AFTER="${WT_AFTER:?usage: WT_AFTER=<path-to-after-worktree> AFTER_SHA=<sha> ./run_after_final.sh}"
AFTER_SHA="${AFTER_SHA:?usage: WT_AFTER=... AFTER_SHA=<sha> ./run_after_final.sh}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EVIDENCE="$(cd "$HERE/.." && pwd)"
LOGS="$EVIDENCE/logs"
DEV_PORT=8933
HOST_PORT=8992
GATEWAY_PORT=8961

mkdir -p "$LOGS" "$EVIDENCE/screenshots/after"
echo "== AFTER evidence run: worktree=$WT_AFTER sha=$AFTER_SHA =="
date -Iseconds

# 0) port check for the ports this script owns (gateway is reused if healthy)
for port in "$DEV_PORT" "$HOST_PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$port$"; then
    echo "port $port already in use — stop it first"; exit 6
  fi
done

# 1) ensure the worktree is exactly at the requested head
git -C "$WT_AFTER" checkout -- frontend/src/lib/embedded/config.ts 2>/dev/null || true
git -C "$WT_AFTER" checkout --detach "$AFTER_SHA" || { echo "checkout failed"; exit 2; }
git -C "$WT_AFTER" log --oneline -1

# 2) harness-only config.ts patch (static NEXT_PUBLIC_* member access)
python3 - "$WT_AFTER/frontend/src/lib/embedded/config.ts" > "$LOGS/config-patch-after.txt" <<'PY'
import hashlib
import sys
from pathlib import Path
p = Path(sys.argv[1])
original = p.read_text()
original_sha = hashlib.sha256(original.encode()).hexdigest()
patched = original
patched = patched.replace("(process.env[EMBEDDED_MODE_ENV] ?? '')", "(process.env.NEXT_PUBLIC_RD_EMBEDDED_MODE ?? '')")
patched = patched.replace("(process.env[GATEWAY_URL_ENV] ?? '')", "(process.env.NEXT_PUBLIC_RD_GATEWAY_URL ?? '')")
patched = patched.replace("(process.env[PARENT_ORIGIN_ENV] ?? '')", "(process.env.NEXT_PUBLIC_RD_PARENT_ORIGIN ?? '')")
p.write_text(patched)
patched_sha = hashlib.sha256(patched.encode()).hexdigest()
print(f"worktree=after original_sha256={original_sha} patched_sha256={patched_sha} changed={original != patched}")
PY
cat "$LOGS/config-patch-after.txt"

# 3) synthetic gateway + host page (start what is missing)
cd "$HERE"
GW_PID=''
HOST_PID=''
DEV_PID=''
if ! curl -sf "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null; then
  nohup node gateway_mock.js "$GATEWAY_PORT" > "$LOGS/gateway-after.log" 2>&1 &
  GW_PID=$!
fi
if ! curl -sf "http://127.0.0.1:$HOST_PORT/health" >/dev/null; then
  nohup node host_server.js "$HOST_PORT" "http://127.0.0.1:$DEV_PORT/research?legacy=1" > "$LOGS/host-after.log" 2>&1 &
  HOST_PID=$!
fi
cleanup() {
  kill ${DEV_PID:-} ${GW_PID:-} ${HOST_PID:-} 2>/dev/null || true
  sleep 1
  kill -9 ${DEV_PID:-} ${GW_PID:-} ${HOST_PID:-} 2>/dev/null || true
  git -C "$WT_AFTER" checkout -- frontend/src/lib/embedded/config.ts 2>/dev/null || true
  echo "== AFTER cleanup (ports $DEV_PORT/$HOST_PORT/$GATEWAY_PORT released) =="
}
trap cleanup EXIT

# 4) Next dev for the AFTER worktree
(
  cd "$WT_AFTER/frontend" || exit 1
  NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1 \
  NEXT_PUBLIC_RD_EMBEDDED_MODE=1 \
  NEXT_PUBLIC_RD_GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT" \
  NEXT_PUBLIC_RD_PARENT_ORIGIN="http://127.0.0.1:$HOST_PORT" \
  nohup node_modules/.bin/next dev --webpack -p "$DEV_PORT" > "$LOGS/dev-after.log" 2>&1 &
  echo $!
) > /tmp/issue1135-dev-after.pid
DEV_PID=$(cat /tmp/issue1135-dev-after.pid)

echo "waiting for dev server on $DEV_PORT (pid=$DEV_PID) ..."
code=000
for _ in $(seq 1 180); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$DEV_PORT/research" || true)
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || { echo "dev server did not become ready (last=$code)"; tail -60 "$LOGS/dev-after.log"; exit 3; }
curl -sf "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null || { echo "gateway not up"; exit 4; }
curl -sf "http://127.0.0.1:$HOST_PORT/health" >/dev/null || { echo "host not up"; exit 5; }

# 5) capture
cd "$HERE"
node capture.js --phase=after --host="http://127.0.0.1:$HOST_PORT/" --head="$AFTER_SHA"
CAPTURE=$?
echo "capture exit=$CAPTURE"

# 6) restore harness-only patch + record provenance/head
git -C "$WT_AFTER" checkout -- frontend/src/lib/embedded/config.ts
python3 - "$WT_AFTER" "$LOGS/config-patch-sha256-after.txt" <<'PY'
import hashlib
import json
import subprocess
import sys
from pathlib import Path
worktree = sys.argv[1]
out = Path(sys.argv[2])
config = Path(worktree) / 'frontend/src/lib/embedded/config.ts'
restored_sha = hashlib.sha256(config.read_bytes()).hexdigest()
head_sha = hashlib.sha256(
    subprocess.run(
        ['git', '-C', worktree, 'show', 'HEAD:frontend/src/lib/embedded/config.ts'],
        capture_output=True,
        check=True,
    ).stdout
).hexdigest()
record = {
    'worktree': 'after',
    'path': 'frontend/src/lib/embedded/config.ts',
    'restored_sha256': restored_sha,
    'sha256_at_head': head_sha,
    'restored_clean': restored_sha == head_sha,
}
out.write_text(json.dumps(record) + '\n')
print(json.dumps(record))
PY
{
  echo "AFTER_SHA=$AFTER_SHA"
  git -C "$WT_AFTER" rev-parse HEAD
  git -C "$WT_AFTER" status --porcelain
  date -Iseconds
} | tee "$LOGS/after-head.txt"
echo "== done =="
exit "$CAPTURE"
