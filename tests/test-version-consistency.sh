#!/usr/bin/env bash
# test-version-consistency.sh — Validates version numbers match across all locations
# Source of truth: VERSION file at project root
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  FAIL=$((FAIL + 1))
}

# Extract version from a JSON file using python3
json_version() {
  local file="$1"
  local expr="${2:-.get('version', '__missing__')}"
  python3 -c "
import json
data = json.load(open('$file'))
val = data${expr}
print(val if val else '__missing__')
" 2>/dev/null || echo "__error__"
}

# Extract version from YAML frontmatter of a markdown file
frontmatter_version() {
  local file="$1"
  sed -n '/^---$/,/^---$/p' "$file" | sed '1d;$d' | grep -E '^version:' | head -1 | sed 's/^version:[[:space:]]*//' | sed 's/^"\(.*\)"$/\1/' | sed "s/^'\(.*\)'$/\1/"
}

# Extract latest version from CHANGELOG.md header
changelog_version() {
  local file="$1"
  grep -E '^\#\#\s+\[' "$file" | head -1 | sed 's/.*\[\([0-9][0-9.]*\)\].*/\1/'
}

echo "=== Version Consistency Tests ==="
echo ""

# --- Source of truth: VERSION file ---
VERSION_FILE="$PROJECT_ROOT/VERSION"
if [[ -f "$VERSION_FILE" ]]; then
  EXPECTED=$(tr -d '[:space:]' < "$VERSION_FILE")
  pass "VERSION file exists: $EXPECTED"
else
  echo -e "  ${RED}FATAL${NC} VERSION file not found at project root"
  exit 1
fi

echo ""
echo "-- Checking all locations match VERSION ($EXPECTED) --"

# Check a file's version against EXPECTED
check_version() {
  local label="$1"
  local actual="$2"
  if [[ "$actual" == "$EXPECTED" ]]; then
    pass "$label: $actual"
  elif [[ "$actual" == "__missing__" || "$actual" == "__error__" ]]; then
    fail "$label: version not found"
  else
    fail "$label: expected $EXPECTED, got $actual"
  fi
}

# 1. .claude-plugin/plugin.json
f="$PROJECT_ROOT/.claude-plugin/plugin.json"
if [[ -f "$f" ]]; then
  check_version "root .claude-plugin/plugin.json" "$(json_version "$f")"
else
  fail "root .claude-plugin/plugin.json: file not found"
fi

# 2. .claude-plugin/marketplace.json
f="$PROJECT_ROOT/.claude-plugin/marketplace.json"
if [[ -f "$f" ]]; then
  v=$(python3 -c "
import json
data = json.load(open('$f'))
plugins = data.get('plugins', [])
print(plugins[0].get('version', '__missing__') if plugins else '__missing__')
" 2>/dev/null || echo "__error__")
  check_version "root .claude-plugin/marketplace.json" "$v"
else
  fail "root .claude-plugin/marketplace.json: file not found"
fi

# 3. skills/run/SKILL.md frontmatter
f="$PROJECT_ROOT/skills/run/SKILL.md"
if [[ -f "$f" ]]; then
  v=$(frontmatter_version "$f")
  check_version "root skills/run/SKILL.md" "${v:-__missing__}"
else
  fail "root skills/run/SKILL.md: file not found"
fi

# 4. plugins/sentinel/.claude-plugin/plugin.json
f="$PROJECT_ROOT/plugins/sentinel/.claude-plugin/plugin.json"
if [[ -f "$f" ]]; then
  check_version "mirror .claude-plugin/plugin.json" "$(json_version "$f")"
else
  fail "mirror .claude-plugin/plugin.json: file not found"
fi

# 5. plugins/sentinel/skills/run/SKILL.md frontmatter
f="$PROJECT_ROOT/plugins/sentinel/skills/run/SKILL.md"
if [[ -f "$f" ]]; then
  v=$(frontmatter_version "$f")
  check_version "mirror skills/run/SKILL.md" "${v:-__missing__}"
else
  fail "mirror skills/run/SKILL.md: file not found"
fi

# 6. CHANGELOG.md latest header
f="$PROJECT_ROOT/CHANGELOG.md"
if [[ -f "$f" ]]; then
  v=$(changelog_version "$f")
  check_version "CHANGELOG.md latest header" "${v:-__missing__}"
else
  fail "CHANGELOG.md: file not found"
fi

# --- Summary ---
echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Version consistency tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"

exit "$FAIL"
