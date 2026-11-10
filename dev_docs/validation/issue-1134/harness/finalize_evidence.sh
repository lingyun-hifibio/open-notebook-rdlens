#!/usr/bin/env bash
# Issue #1134 — finalize evidence package (run AFTER the final AFTER capture).
#
# - restores the harness-only config.ts patch in both worktrees and records git
#   status + original/patched/restored sha256;
# - records the exact BEFORE/AFTER full SHAs and worktree cleanliness;
# - runs the tolerant pixel-equivalence gate for surfaces that must not change
#   visually (E9/E10/E11) and merges it into after-manifest.json;
# - merges worktree provenance + implementation diff into both manifests;
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
  local head status config_sha config_head
  head=$(git -C "$wt" rev-parse HEAD)
  status=$(git -C "$wt" status --porcelain | tr '\n' '|' | sed 's/|$//')
  config_sha=$(sha256sum "$wt/frontend/src/lib/embedded/config.ts" | cut -d' ' -f1)
  config_head=$(git -C "$wt" show HEAD:frontend/src/lib/embedded/config.ts | sha256sum | cut -d' ' -f1)
  printf '{"name":"%s","worktree":"%s","head":"%s","status_porcelain":"%s","config_ts":{"sha256_current":"%s","sha256_at_head":"%s","restored_clean":%s}}\n' \
    "$name" "$wt" "$head" "$status" "$config_sha" "$config_head" \
    "$([ "$config_sha" = "$config_head" ] && echo true || echo false)" > "$out"
}

# Restore harness-only patches first (both phases ran with the static-env patch).
git -C "$WT_BEFORE" checkout -- frontend/src/lib/embedded/config.ts 2>/dev/null || true
git -C "$WT_AFTER" checkout -- frontend/src/lib/embedded/config.ts 2>/dev/null || true
record_worktree before "$WT_BEFORE" "$LOGS/worktree-before.json"
record_worktree after "$WT_AFTER" "$LOGS/worktree-after.json"
cat "$LOGS/worktree-before.json" "$LOGS/worktree-after.json"

# Harness-patch sha256 provenance captured while the patch was applied during
# capture (original → patched) and after restore (restored == original at head).
python3 - "$LOGS" <<'PY'
import json
import re
import sys
from pathlib import Path
logs = Path(sys.argv[1])
records = {}
for name, logfile in (('before', 'config-patch-before.txt'), ('after', 'config-patch-after.txt')):
    path = logs / logfile
    if not path.exists():
        continue
    match = re.search(
        r'original_sha256=([0-9a-f]{64}) patched_sha256=([0-9a-f]{64})', path.read_text()
    )
    if match:
        records[name] = {
            'original_sha256': match.group(1),
            'patched_sha256': match.group(2),
        }
for name, restored_file in (('before', 'config-patch-sha256.txt'), ('after', 'config-patch-sha256-after.txt')):
    path = logs / restored_file
    if not path.exists():
        continue
    try:
        restored = json.loads(path.read_text().splitlines()[0])
    except Exception:
        continue
    record = records.setdefault(name, {})
    record['restored_sha256'] = restored.get('restored_sha256')
    record['sha256_at_head'] = restored.get('sha256_at_head')
    record['restored_clean'] = restored.get('restored_clean')
(logs / 'config-patch-sha256.json').write_text(json.dumps(records, indent=2) + '\n')
print('config patch provenance:', json.dumps(records))
PY

# Tolerant pixel equivalence for surfaces that must not change visually
# (E9 Admin read-only / E10 capability-off blocked view / E11 legacy old delete
# path vs BEFORE). Byte sha256 equality is informational only: next dev can
# shift a handful of anti-aliasing pixels between runs.
echo "== pixel equivalence (unchanged surfaces) =="
python3 "$HERE/verify_pixel_equivalence.py" "$EVIDENCE"
PIXEL_EXIT=$?
echo "pixel equivalence exit=$PIXEL_EXIT"

# Merge provenance + pixel gate + implementation diff into the manifests.
python3 - "$EVIDENCE" "$AFTER_SHA" "$PIXEL_EXIT" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

evidence = Path(sys.argv[1])
after_sha = sys.argv[2]
pixel_exit = int(sys.argv[3]) if len(sys.argv) > 3 else None

def load(path):
    return json.loads(path.read_text())

before_wt = load(evidence / 'logs' / 'worktree-before.json')
after_wt = load(evidence / 'logs' / 'worktree-after.json')
patch_records = {}
patch_path = evidence / 'logs' / 'config-patch-sha256.json'
if patch_path.exists():
    patch_records = json.loads(patch_path.read_text())

def strip_paths(start: Path, root: Path) -> str:
    return str(start).replace(str(root) + '/', '')

before_manifest_path = evidence / 'before-manifest.json'
after_manifest_path = evidence / 'after-manifest.json'
before_manifest = load(before_manifest_path) if before_manifest_path.exists() else None
after_manifest = load(after_manifest_path) if after_manifest_path.exists() else None

pixel_log = evidence / 'logs' / 'pixel-equivalence.txt'
pixel_summary = ''
pixel_lines = []
if pixel_log.exists():
    pixel_lines = [line for line in pixel_log.read_text().splitlines() if line.strip()]
    for line in pixel_lines:
        if line.startswith('summary:'):
            pixel_summary = line

changed = subprocess.run(
    ['git', '-C', after_wt['worktree'], 'diff', '--name-only', 'origin/main', 'HEAD'],
    capture_output=True, text=True, check=False,
).stdout.split()
untracked = subprocess.run(
    ['git', '-C', after_wt['worktree'], 'ls-files', '--others', '--exclude-standard'],
    capture_output=True, text=True, check=False,
).stdout.split()

if after_manifest is not None:
    after_manifest['final_head'] = after_sha
    after_manifest['baseline_full_sha'] = before_wt['head']
    after_manifest['worktree_provenance'] = {
        'before': before_wt,
        'after': after_wt,
        'harness_only_patch': {
            'file': 'frontend/src/lib/embedded/config.ts',
            'change': 'dynamic process.env[CONST] lookups -> static process.env.NEXT_PUBLIC_* member access (Next dev does not inline dynamic lookups); reverted after capture',
            'records': patch_records,
            'restored_clean': bool(
                before_wt['config_ts']['restored_clean'] and after_wt['config_ts']['restored_clean']
            ),
        },
    }
    after_manifest['pixel_equivalence'] = {
        'log': 'logs/pixel-equivalence.txt',
        'exit_code': pixel_exit,
        'summary': pixel_summary,
        'pairs': [line for line in pixel_lines if line.startswith('PASS ') or line.startswith('FAIL ')],
        'note': 'tolerant per-pixel comparison (Pillow) of AFTER vs BEFORE screenshots for surfaces that must not change visually (E9/E10/E11); byte sha256 equality is recorded in scenes[].pixel_compare as information, not as a hard gate',
    }
    after_manifest['implementation_diff'] = {
        'changed_files': len(changed),
        'files': changed,
        'untracked_files': untracked,
        'note': 'implementation branch only (fork branch agent/note-delete-ui-a35682a0d739); the evidence branch is not part of the implementation PR diff',
    }
    after_manifest_path.write_text(json.dumps(after_manifest, indent=2, ensure_ascii=False) + '\n')

if before_manifest is not None:
    before_manifest['baseline_full_sha'] = before_wt['head']
    before_manifest['worktree_provenance'] = {
        'before': before_wt,
        'harness_only_patch': after_manifest['worktree_provenance']['harness_only_patch'] if after_manifest else None,
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
