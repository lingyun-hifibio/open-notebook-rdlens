#!/usr/bin/env bash
# Issue #1136 — local verification commands (no PR CI exists in the fork repo).
#
# Usage:
#   WT_AFTER=/path/to/fork-after AFTER_SHA=<40-hex-head> ./verify_local.sh
#
# Runs in the AFTER worktree/frontend and records command + exit code + tail in
# $EVIDENCE/logs/local-verification.txt (the same summary is added to
# after-manifest.json by the evidence worker):
#   1. npx tsc -b                       (type check)
#   2. npx vitest run <targeted files>  (new/affected unit tests)
#   3. npm run build                    (Next production build; run AFTER the
#                                        dev server is stopped — both use .next)
#
# These are local command results, not CI: the fork repo runs no GitHub Actions
# checks (see README §Limitations).
set -uo pipefail

WT_AFTER="${WT_AFTER:?usage: WT_AFTER=<path-to-after-worktree> AFTER_SHA=<sha> ./verify_local.sh}"
AFTER_SHA="${AFTER_SHA:-unknown}"
HERE="$(cd "$(dirname "$0")" && pwd)"
EVIDENCE="$(cd "$HERE/.." && pwd)"
LOG="$EVIDENCE/logs/local-verification.txt"

: > "$LOG"
echo "local verification (issue #1136) — head=$AFTER_SHA" | tee -a "$LOG"
echo "worktree=$WT_AFTER" | tee -a "$LOG"
echo "started=$(date -Iseconds)" | tee -a "$LOG"
echo "node=$(node -v)" | tee -a "$LOG"

cd "$WT_AFTER/frontend" || { echo "frontend dir missing" | tee -a "$LOG"; exit 1; }
echo "head-rev=$(git -C "$WT_AFTER" rev-parse HEAD)" | tee -a "$LOG"

run_step() {
  local name="$1"
  shift
  echo "" | tee -a "$LOG"
  echo "=== $name ===" | tee -a "$LOG"
  echo "\$ $*" | tee -a "$LOG"
  "$@" > /tmp/issue1136-verify-step.log 2>&1
  local code=$?
  echo "exit=$code" | tee -a "$LOG"
  tail -n 40 /tmp/issue1136-verify-step.log | sed 's/^/  /' | tee -a "$LOG"
  return $code
}

run_step "tsc -b" npx tsc -b
TSC=$?
run_step "eslint (8 changed files, final head)" \
  npx eslint \
  src/components/research/NotesPanel.tsx \
  src/components/research/NotesPanel.test.tsx \
  src/components/research/ResearchWorkbench.tsx \
  src/components/research/ResearchWorkbench.test.tsx \
  src/components/research/issue585/NoteRecoveryInbox.tsx \
  src/components/research/issue585/NoteRecoveryInbox.test.tsx \
  src/lib/research/issue585/note-draft-cache.ts \
  src/lib/research/issue585/note-draft-cache.test.ts
ESLINT=$?
run_step "vitest (targeted issue585 / NotesPanel / ResearchWorkbench)" \
  npx vitest run \
  src/lib/research/issue585/note-draft-cache.test.ts \
  src/lib/research/issue585/use-note-editor.test.tsx \
  src/components/research/issue585/NoteRecoveryInbox.test.tsx \
  src/components/research/NotesPanel.test.tsx \
  src/components/research/ResearchWorkbench.test.tsx
VITEST=$?
run_step "next production build" npm run build
BUILD=$?
# Full suite is recorded separately: fork baseline has 14 known SourceListPanel
# failures (documented in the implementation PR), so it is not a pass/fail gate.
run_step "vitest (full suite)" npx vitest run
FULL=$?

echo "" | tee -a "$LOG"
echo "=== summary ===" | tee -a "$LOG"
echo "head=$AFTER_SHA tsc=$TSC eslint=$ESLINT vitest=$VITEST build=$BUILD full=$FULL" | tee -a "$LOG"
echo "finished=$(date -Iseconds)" | tee -a "$LOG"
[ "$TSC" = 0 ] && [ "$ESLINT" = 0 ] && [ "$VITEST" = 0 ] && [ "$BUILD" = 0 ]
