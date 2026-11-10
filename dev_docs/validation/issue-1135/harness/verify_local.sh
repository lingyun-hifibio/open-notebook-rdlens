#!/usr/bin/env bash
# Issue #1135 — local verification commands (no PR CI exists in the fork repo).
#
# Usage:
#   WT_AFTER=/path/to/fork-after AFTER_SHA=<40-hex-head> ./verify_local.sh
#
# Runs in the AFTER worktree/frontend and records command + exit code + tail in
# $EVIDENCE/logs/local-verification.txt (the same summary is added to
# after-manifest.json by finalize_evidence.sh):
#   1. npx tsc -b                                (type check)
#   2. npx eslint <changed/new files>            (lint, from git diff origin/main)
#   3. npx vitest run <changed/new test files>   (targeted tests)
#   4. npm run build                             (Next production build)
#   5. npx vitest run                            (full suite; recorded separately —
#      the fork baseline has known pre-existing failures, see README)
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
echo "local verification (issue #1135) — head=$AFTER_SHA" | tee -a "$LOG"
echo "worktree=$WT_AFTER" | tee -a "$LOG"
echo "started=$(date -Iseconds)" | tee -a "$LOG"
echo "node=$(node -v)" | tee -a "$LOG"

cd "$WT_AFTER/frontend" || { echo "frontend dir missing" | tee -a "$LOG"; exit 1; }
echo "head-rev=$(git -C "$WT_AFTER" rev-parse HEAD)" | tee -a "$LOG"

# Changed vs new files introduced by the implementation branch (base = origin/main).
CHANGED=$(git -C "$WT_AFTER" diff --name-only origin/main -- frontend/src | sed 's#^frontend/##')
CHANGED_ABS=$(printf '%s\n' "$CHANGED" | sed "s#^#$WT_AFTER/frontend/#")
TEST_FILES=$(printf '%s\n' "$CHANGED" | grep -E '\.(test|spec)\.(ts|tsx)$' || true)
SOURCE_FILES=$(printf '%s\n' "$CHANGED" | grep -vE '\.(test|spec)\.(ts|tsx)$' || true)
echo "" | tee -a "$LOG"
echo "changed files ($(printf '%s\n' "$CHANGED" | sed '/^$/d' | wc -l)):" | tee -a "$LOG"
printf '%s\n' "$CHANGED" | sed '/^$/d' | sed 's/^/  /' | tee -a "$LOG"
echo "targeted test files:" | tee -a "$LOG"
printf '%s\n' "$TEST_FILES" | sed '/^$/d' | sed 's/^/  /' | tee -a "$LOG"

run_step() {
  local name="$1"
  shift
  echo "" | tee -a "$LOG"
  echo "=== $name ===" | tee -a "$LOG"
  echo "\$ $*" | tee -a "$LOG"
  "$@" > /tmp/issue1135-verify-step.log 2>&1
  local code=$?
  echo "exit=$code" | tee -a "$LOG"
  tail -n 40 /tmp/issue1135-verify-step.log | sed 's/^/  /' | tee -a "$LOG"
  return $code
}

run_step "tsc -b" npx tsc -b
TSC=$?
if [ -n "$(printf '%s' "$CHANGED" | tr -d '[:space:]')" ]; then
  # shellcheck disable=SC2086
  run_step "eslint (${SOURCE_FILES//$'\n'/ } ${TEST_FILES//$'\n'/ })" npx eslint $CHANGED
  ESLINT=$?
else
  ESLINT=0
fi
if [ -n "$(printf '%s' "$TEST_FILES" | tr -d '[:space:]')" ]; then
  run_step "vitest (targeted: changed test files)" npx vitest run $TEST_FILES
  VITEST=$?
else
  VITEST=0
fi
run_step "next production build" npm run build
BUILD=$?
# Full suite is recorded separately: the fork baseline has known pre-existing
# SourceListPanel.test.tsx failures (identical at origin/main), so it is not a
# pass/fail gate for this PR.
run_step "vitest (full suite)" npx vitest run
FULL=$?

echo "" | tee -a "$LOG"
echo "=== summary ===" | tee -a "$LOG"
echo "head=$AFTER_SHA tsc=$TSC eslint=$ESLINT vitest=$VITEST build=$BUILD full=$FULL" | tee -a "$LOG"
echo "finished=$(date -Iseconds)" | tee -a "$LOG"
[ "$TSC" = 0 ] && [ "$ESLINT" = 0 ] && [ "$VITEST" = 0 ] && [ "$BUILD" = 0 ]
