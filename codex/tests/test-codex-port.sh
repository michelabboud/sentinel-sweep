#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$ROOT/codex/bin/sentinel-codex.sh"

[[ -x "$RUNNER" ]] || { echo "runner missing: $RUNNER"; exit 1; }

"$RUNNER" manifest > /tmp/sentinel-codex-manifest.out
RUN_ID="$(grep '^Run ID:' /tmp/sentinel-codex-manifest.out | awk '{print $3}' || true)"
if [[ -z "$RUN_ID" ]]; then
  RUN_ID="$(basename "$(readlink "$ROOT/sentinel-reports/latest")")"
fi

BRIEFS_DIR="$ROOT/sentinel-reports/$RUN_ID/subagent-briefs"
[[ -f "$BRIEFS_DIR/manifest-generator-task.md" ]] || { echo "missing manifest brief"; exit 1; }
[[ -f "$BRIEFS_DIR/report-synthesizer-task.md" ]] || { echo "missing report brief"; exit 1; }

"$RUNNER" api --dry-run > /tmp/sentinel-codex-api.out
RUN_ID_API="$(grep '^Run ID:' /tmp/sentinel-codex-api.out | awk '{print $3}')"
BRIEFS_API="$ROOT/sentinel-reports/$RUN_ID_API/subagent-briefs"
[[ -f "$BRIEFS_API/api-sweeper-task.md" ]] || { echo "missing api brief"; exit 1; }

"$RUNNER" sweep --dry-run > /tmp/sentinel-codex-sweep.out
RUN_ID_SWEEP="$(grep '^Run ID:' /tmp/sentinel-codex-sweep.out | awk '{print $3}')"
BRIEFS_SWEEP="$ROOT/sentinel-reports/$RUN_ID_SWEEP/subagent-briefs"
[[ -f "$BRIEFS_SWEEP/api-sweeper-task.md" ]] || { echo "missing sweep api brief"; exit 1; }
[[ -f "$BRIEFS_SWEEP/browser-sweeper-task.md" ]] || { echo "missing browser brief"; exit 1; }

echo "codex port test: PASS"
