#!/usr/bin/env bash
# test-mirror-parity.sh — Validates that plugins/sentinel/ mirrors root files
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MIRROR="$PROJECT_ROOT/plugins/sentinel"

pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  FAIL=$((FAIL + 1))
}

echo "=== Mirror Parity Tests ==="
echo ""

# Define pairs to compare: root-relative-path -> mirror-relative-path
# Format: "root_path|mirror_path"
PAIRS=(
  "agents/manifest-generator.md|agents/manifest-generator.md"
  "agents/api-sweeper.md|agents/api-sweeper.md"
  "agents/browser-sweeper.md|agents/browser-sweeper.md"
  "skills/sentinel/SKILL.md|skills/sentinel/SKILL.md"
  "skills/sentinel-setup/SKILL.md|skills/sentinel-setup/SKILL.md"
  "commands/sentinel.md|commands/sentinel.md"
  "settings.json|settings.json"
  "LICENSE|LICENSE"
  "README.md|README.md"
)

for pair in "${PAIRS[@]}"; do
  root_rel="${pair%%|*}"
  mirror_rel="${pair##*|}"

  root_file="$PROJECT_ROOT/$root_rel"
  mirror_file="$MIRROR/$mirror_rel"

  # Check both files exist
  if [[ ! -f "$root_file" ]]; then
    # Root file doesn't exist — skip (may be optional like commands/)
    if [[ ! -f "$mirror_file" ]]; then
      pass "$root_rel: neither root nor mirror exists (OK, optional)"
    else
      fail "$root_rel: exists in mirror but not in root"
    fi
    continue
  fi

  if [[ ! -f "$mirror_file" ]]; then
    fail "$root_rel: exists in root but not in mirror ($mirror_rel)"
    continue
  fi

  # Compare file contents
  if diff -q "$root_file" "$mirror_file" > /dev/null 2>&1; then
    pass "$root_rel matches mirror"
  else
    fail "$root_rel DIFFERS from mirror"
    # Show first difference for debugging
    echo -e "    ${RED}First difference:${NC}"
    diff --unified=1 "$root_file" "$mirror_file" | head -15 | sed 's/^/    /'
    echo ""
  fi
done

# --- Summary ---
echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Mirror parity tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"

exit "$FAIL"
