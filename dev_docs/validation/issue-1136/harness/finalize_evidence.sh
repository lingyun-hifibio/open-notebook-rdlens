#!/usr/bin/env bash
# Issue #1136 — finalize evidence package (run AFTER the final AFTER capture).
#
# - restores the harness-only config.ts patch in both worktrees and records
#   git status + original/patched/restored sha256;
# - runs the local verification commands (tsc -b / targeted vitest / build) at
#   the final AFTER head and records command + exit code + tail;
# - merges local verification + worktree provenance into after-manifest.json;
# - writes screenshots.sha256 for all before/after PNGs.
#
# Usage:
#   WT_BEFORE=... WT_AFTER=... AFTER_SHA=<final-sha> ./finalize_evidence.sh
set -uo pipefail

WT_BEFORE="${WT_BEFORE:?usage: WT_BEFORE=<baseline worktree> WT_AFTER=<after worktree> AFTER_SHA=<sha> ./finalize_evidence.sh}"
WT_AFTER="${WT_AFTER:?usage: WT_BEFORE=<baseline worktree> WT_AFTER=<after worktree> AFTER_SHA=<sha> ./finalize_evidence.sh}"
AFTER_SHA="${AFTER_SHA:?usage: WT_BEFORE=<baseline worktree> WT_AFTER=<after worktree> AFTER_SHA=<sha> ./finalize_evidence.sh}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EVIDENCE="$(cd "$HERE/.." && pwd)"
LOGS="$EVIDENCE/logs"
mkdir -p "$LOGS"

echo "== finalize evidence: head=$AFTER_SHA =="
date -Iseconds

record_worktree() {
  local name="$1" wt="$2" out="$3"
  local head status config_sha config_orig
  head=$(git -C "$wt" rev-parse HEAD)
  status=$(git -C "$wt" status --porcelain | tr '\n' '|' | sed 's/|$//')
  config_sha=$(sha256sum "$wt/frontend/src/lib/embedded/config.ts" | cut -d' ' -f1)
  config_orig=$(git -C "$wt" show HEAD:frontend/src/lib/embedded/config.ts | sha256sum | cut -d' ' -f1)
  printf '{"name":"%s","worktree":"%s","head":"%s","status_porcelain":"%s","config_ts":{"sha256_current":"%s","sha256_at_head":"%s","restored_clean":%s}}\n' \
    "$name" "$wt" "$head" "$status" "$config_sha" "$config_orig" \
    "$([ "$config_sha" = "$config_orig" ] && echo true || echo false)" > "$out"
}

# Restore harness-only patches first (both phases ran with the static-env patch).
git -C "$WT_BEFORE" checkout -- frontend/src/lib/embedded/config.ts 2>/dev/null || true
git -C "$WT_AFTER" checkout -- frontend/src/lib/embedded/config.ts 2>/dev/null || true
record_worktree before "$WT_BEFORE" "$LOGS/worktree-before.json"
record_worktree after "$WT_AFTER" "$LOGS/worktree-after.json"
cat "$LOGS/worktree-before.json" "$LOGS/worktree-after.json"
# Harness-patch sha256 provenance captured while the patch was applied during
# capture (original/patched/restored; restored must equal original at head).
PATCH_SHA_FILE="$LOGS/config-patch-sha256.txt"
if [ -f "$PATCH_SHA_FILE" ]; then cat "$PATCH_SHA_FILE"; else echo '[]' > "$PATCH_SHA_FILE"; fi

# Local verification (no PR CI in the fork): tsc/vitest/build at the final head.
echo "== local verification at $AFTER_SHA =="
WT_AFTER="$WT_AFTER" AFTER_SHA="$AFTER_SHA" "$HERE/verify_local.sh"
VERIFY_EXIT=$?
echo "verify_local exit=$VERIFY_EXIT"

# Merge provenance + verification into after-manifest.json (and copy the
# baseline provenance into before-manifest.json for symmetry).
python3 - "$EVIDENCE" "$AFTER_SHA" "$VERIFY_EXIT" <<'PY'
import json
import sys
from pathlib import Path

evidence = Path(sys.argv[1])
after_sha = sys.argv[2]
verify_exit = int(sys.argv[3])

def load(path):
    return json.loads(path.read_text())

before_wt = load(evidence / 'logs' / 'worktree-before.json')
after_wt = load(evidence / 'logs' / 'worktree-after.json')
patch_hashes = [
    json.loads(line)
    for line in (evidence / 'logs' / 'config-patch-sha256.txt').read_text().splitlines()
    if line.strip()
] if (evidence / 'logs' / 'config-patch-sha256.txt').exists() else []
before_wt['config_ts']['original_sha256'] = next(
    (item['config_ts_original_sha256'] for item in patch_hashes if item['worktree'] == 'before'), None)
before_wt['config_ts']['patched_sha256'] = next(
    (item['config_ts_patched_sha256'] for item in patch_hashes if item['worktree'] == 'before'), None)
after_wt['config_ts']['original_sha256'] = next(
    (item['config_ts_original_sha256'] for item in patch_hashes if item['worktree'] == 'after'), None)
after_wt['config_ts']['patched_sha256'] = next(
    (item['config_ts_patched_sha256'] for item in patch_hashes if item['worktree'] == 'after'), None)

after_manifest_path = evidence / 'after-manifest.json'
after_manifest = load(after_manifest_path)
after_manifest['final_head'] = after_sha
after_manifest['worktree_provenance'] = {
    'before': before_wt,
    'after': after_wt,
    'harness_only_patch': {
        'file': 'frontend/src/lib/embedded/config.ts',
        'change': 'dynamic process.env[CONST] lookups -> static process.env.NEXT_PUBLIC_* member access (Next dev does not inline dynamic lookups); reverted after capture',
        'restored_clean': bool(before_wt['config_ts']['restored_clean'] and after_wt['config_ts']['restored_clean']),
    },
}
verification_log = evidence / 'logs' / 'local-verification.txt'
summary_line = ''
for line in verification_log.read_text().splitlines():
    if line.strip().startswith('head= '):
        summary_line = line.strip()
    elif line.strip().startswith('head='):
        summary_line = line.strip()
after_manifest['local_verification'] = {
    'head': after_sha,
    'log': 'logs/local-verification.txt',
    'summary': summary_line,
    'exit_code': verify_exit,
    'pr_ci': 'fork repo has no GitHub Actions checks configured; these local command results are the verification evidence',
}
after_manifest_path.write_text(json.dumps(after_manifest, indent=2, ensure_ascii=False) + '\n')

before_manifest_path = evidence / 'before-manifest.json'
before_manifest = load(before_manifest_path)
before_manifest['worktree_provenance'] = {
    'before': before_wt,
    'harness_only_patch': after_manifest['worktree_provenance']['harness_only_patch'],
}
before_manifest_path.write_text(json.dumps(before_manifest, indent=2, ensure_ascii=False) + '\n')
print('manifest updated:', after_manifest_path, before_manifest_path)
PY

# sha256 of every screenshot.
(
  cd "$EVIDENCE"
  { find screenshots/before screenshots/after -name '*.png' -type f | sort | xargs sha256sum; } > screenshots.sha256
  wc -l screenshots.sha256
)

echo "== finalize done: $EVIDENCE/screenshots.sha256 =="
date -Iseconds
