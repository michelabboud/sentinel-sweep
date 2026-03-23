#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REPORT_BASE="$REPO_ROOT/sentinel-reports"
LATEST_LINK="$REPORT_BASE/latest"

if [[ ! -e "$LATEST_LINK" ]]; then
  echo "No latest run found at: $LATEST_LINK"
  echo "Run: ./codex/bin/sentinel-codex.sh sweep --dry-run"
  exit 1
fi

LATEST_RUN_DIR="$(cd "$LATEST_LINK" && pwd)"
BRIEFS_DIR="$LATEST_RUN_DIR/subagent-briefs"

if [[ ! -d "$BRIEFS_DIR" ]]; then
  echo "No subagent briefs found in latest run:"
  echo "$BRIEFS_DIR"
  exit 1
fi

echo "Latest run: $LATEST_RUN_DIR"
echo "Briefs:"

found=0
for f in \
  "manifest-generator-task.md" \
  "api-sweeper-task.md" \
  "browser-sweeper-task.md" \
  "report-synthesizer-task.md" \
  "diff-analyst-task.md" \
  "trends-analyst-task.md"
do
  p="$BRIEFS_DIR/$f"
  if [[ -f "$p" ]]; then
    echo "$p"
    found=1
  fi
done

if [[ "$found" -eq 0 ]]; then
  echo "(none)"
  exit 1
fi
