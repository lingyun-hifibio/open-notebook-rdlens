#!/usr/bin/env bash
# Issue #1017 — reproduce BOTH sides serially (BEFORE then AFTER).
#
# Usage:
#   WT_BEFORE=/path/to/baseline-copy \
#   WT_AFTER=/path/to/impl-worktree \
#   AFTER_SHA=<impl-head-sha> ./run_all.sh
#
# BEFORE_SHA defaults to fork origin/main d959635 (the baseline identified in
# the evidence README). Runs are serial (the gateway mock uses port 8941 and
# each side owns its dev/host ports); see run_side.sh for preconditions.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

SIDE=before WT_BEFORE="${WT_BEFORE:?set WT_BEFORE}" BEFORE_SHA="${BEFORE_SHA:-d959635ebf5f642b6e8a75fb9a89896fe366683d}" \
  "$HERE/run_side.sh"
BEFORE=$?

SIDE=after WT_AFTER="${WT_AFTER:?set WT_AFTER}" AFTER_SHA="${AFTER_SHA:?set AFTER_SHA}" \
  "$HERE/run_side.sh"
AFTER=$?

echo "before_exit=$BEFORE after_exit=$AFTER"
[ "$BEFORE" = 0 ] && [ "$AFTER" = 0 ]
