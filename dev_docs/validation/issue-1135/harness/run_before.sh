#!/usr/bin/env bash
# Issue #1135 — BEFORE evidence run (fork baseline origin/main 34f531d, no
# "enable protected editing" entry).
#
# Reproduces the synthetic harness: route-mocked Research Gateway + synthetic
# host page + real fork Next.js app in embedded mode, then captures E1/E2/E3/
# E7/E8 at 1440x900 / 1024x768 (fresh browser context per scene, gateway reset
# per scene). E4/E5/E6 are recorded as N/A baseline gaps (no enable mutation
# exists at this revision) — see capture.js / README.
#
# Usage:
#   WT_BEFORE=/path/to/fork-before ./run_before.sh
#
# Expected preconditions (see README §Environment):
#   - $WT_BEFORE is a git worktree of the fork repo checked out at the BEFORE
#     revision with frontend/node_modules symlinked (this harness used a symlink
#     to /home/lchen/workspace/open-notebook-rdlens/frontend/node_modules).
#   - ports 8931 (Next dev), 8990 (host), 8961 (gateway) are free.
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
DEV_PORT=8931
HOST_PORT=8990
GATEWAY_PORT=8961
SHA="${BEFORE_SHA:-34f531d}"

mkdir -p "$LOGS" "$EVIDENCE/screenshots/before"
echo "== BEFORE evidence run: worktree=$WT_BEFORE sha=$SHA =="
date -Iseconds

# 0) port check
for port in "$DEV_PORT" "$HOST_PORT" "$GATEWAY_PORT"; do
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -q ":$port$"; then
    echo "port $port already in use — stop it first"; exit 6
  fi
done

# 1) harness-only config.ts patch (static NEXT_PUBLIC_* member access)
python3 - "$WT_BEFORE/frontend/src/lib/embedded/config.ts" > "$LOGS/config-patch-before.txt" <<'PY'
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
print(f"worktree=before original_sha256={original_sha} patched_sha256={patched_sha} changed={original != patched}")
PY
cat "$LOGS/config-patch-before.txt"

# 2) synthetic gateway + host page
cd "$HERE"
nohup node gateway_mock.js "$GATEWAY_PORT" > "$LOGS/gateway-before.log" 2>&1 &
GW_PID=$!
nohup node host_server.js "$HOST_PORT" "http://127.0.0.1:$DEV_PORT/research?legacy=1" > "$LOGS/host-before.log" 2>&1 &
HOST_PID=$!
DEV_PID=''
cleanup() {
  kill ${DEV_PID:-} ${GW_PID:-} ${HOST_PID:-} 2>/dev/null || true
  sleep 1
  kill -9 ${DEV_PID:-} ${GW_PID:-} ${HOST_PID:-} 2>/dev/null || true
  git -C "$WT_BEFORE" checkout -- frontend/src/lib/embedded/config.ts 2>/dev/null || true
  echo "== BEFORE cleanup (ports $DEV_PORT/$HOST_PORT/$GATEWAY_PORT released) =="
}
trap cleanup EXIT

# 3) Next dev for the baseline worktree
(
  cd "$WT_BEFORE/frontend" || exit 1
  NEXT_ALLOWED_DEV_ORIGINS=127.0.0.1 \
  NEXT_PUBLIC_RD_EMBEDDED_MODE=1 \
  NEXT_PUBLIC_RD_GATEWAY_URL="http://127.0.0.1:$GATEWAY_PORT" \
  NEXT_PUBLIC_RD_PARENT_ORIGIN="http://127.0.0.1:$HOST_PORT" \
  nohup node_modules/.bin/next dev --webpack -p "$DEV_PORT" > "$LOGS/dev-before.log" 2>&1 &
  echo $!
) > /tmp/issue1135-dev-before.pid
DEV_PID=$(cat /tmp/issue1135-dev-before.pid)

echo "waiting for dev server on $DEV_PORT (pid=$DEV_PID) ..."
code=000
for _ in $(seq 1 150); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$DEV_PORT/research" || true)
  [ "$code" = "200" ] && break
  sleep 2
done
[ "$code" = "200" ] || { echo "dev server did not become ready (last=$code)"; tail -40 "$LOGS/dev-before.log"; exit 3; }
curl -sf "http://127.0.0.1:$GATEWAY_PORT/health" >/dev/null || { echo "gateway not up"; exit 4; }
curl -sf "http://127.0.0.1:$HOST_PORT/health" >/dev/null || { echo "host not up"; exit 5; }

# 4) capture
cd "$HERE"
node capture.js --phase=before --host="http://127.0.0.1:$HOST_PORT/" --head="$SHA"
CAPTURE=$?
echo "capture exit=$CAPTURE"

# 5) restore harness-only patch + record restored sha256
git -C "$WT_BEFORE" checkout -- frontend/src/lib/embedded/config.ts
python3 - "$WT_BEFORE" "$LOGS/config-patch-sha256.txt" <<'PY'
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
    'worktree': 'before',
    'path': 'frontend/src/lib/embedded/config.ts',
    'restored_sha256': restored_sha,
    'sha256_at_head': head_sha,
    'restored_clean': restored_sha == head_sha,
}
out.write_text(json.dumps(record) + '\n')
print(json.dumps(record))
PY
cat "$LOGS/config-patch-before.txt"
git -C "$WT_BEFORE" status --porcelain
echo "== done =="
exit "$CAPTURE"
