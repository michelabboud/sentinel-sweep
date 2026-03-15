#!/usr/bin/env bash
# test-version-consistency.sh — Validates version numbers match across all locations
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
  # Match lines like "## [1.1.0] - 2026-03-15"
  grep -E '^\#\#\s+\[' "$file" | head -1 | sed 's/.*\[\([0-9][0-9.]*\)\].*/\1/'
}

echo "=== Version Consistency Tests ==="
echo ""

# Collect all versions
declare -A VERSIONS

# 1. .claude-plugin/plugin.json
f="$PROJECT_ROOT/.claude-plugin/plugin.json"
if [[ -f "$f" ]]; then
  v=$(json_version "$f")
  VERSIONS["root plugin.json"]="$v"
  pass "root .claude-plugin/plugin.json: version $v"
else
  fail "root .claude-plugin/plugin.json: file not found"
  VERSIONS["root plugin.json"]="__missing__"
fi

# 2. .claude-plugin/marketplace.json (nested in plugins array)
f="$PROJECT_ROOT/.claude-plugin/marketplace.json"
if [[ -f "$f" ]]; then
  v=$(python3 -c "
import json
data = json.load(open('$f'))
plugins = data.get('plugins', [])
print(plugins[0].get('version', '__missing__') if plugins else '__missing__')
" 2>/dev/null || echo "__error__")
  VERSIONS["root marketplace.json"]="$v"
  pass "root .claude-plugin/marketplace.json: version $v"
else
  fail "root .claude-plugin/marketplace.json: file not found"
  VERSIONS["root marketplace.json"]="__missing__"
fi

# 3. skills/sentinel/SKILL.md frontmatter
f="$PROJECT_ROOT/skills/sentinel/SKILL.md"
if [[ -f "$f" ]]; then
  v=$(frontmatter_version "$f")
  if [[ -n "$v" ]]; then
    VERSIONS["root SKILL.md"]="$v"
    pass "root skills/sentinel/SKILL.md: version $v"
  else
    VERSIONS["root SKILL.md"]="__missing__"
    fail "root skills/sentinel/SKILL.md: no version in frontmatter"
  fi
else
  VERSIONS["root SKILL.md"]="__missing__"
  fail "root skills/sentinel/SKILL.md: file not found"
fi

# 4. plugins/sentinel/.claude-plugin/plugin.json
f="$PROJECT_ROOT/plugins/sentinel/.claude-plugin/plugin.json"
if [[ -f "$f" ]]; then
  v=$(json_version "$f")
  VERSIONS["mirror plugin.json"]="$v"
  pass "mirror .claude-plugin/plugin.json: version $v"
else
  fail "mirror .claude-plugin/plugin.json: file not found"
  VERSIONS["mirror plugin.json"]="__missing__"
fi

# 5. plugins/sentinel/skills/sentinel/SKILL.md frontmatter
f="$PROJECT_ROOT/plugins/sentinel/skills/sentinel/SKILL.md"
if [[ -f "$f" ]]; then
  v=$(frontmatter_version "$f")
  if [[ -n "$v" ]]; then
    VERSIONS["mirror SKILL.md"]="$v"
    pass "mirror skills/sentinel/SKILL.md: version $v"
  else
    VERSIONS["mirror SKILL.md"]="__missing__"
    fail "mirror skills/sentinel/SKILL.md: no version in frontmatter"
  fi
else
  VERSIONS["mirror SKILL.md"]="__missing__"
  fail "mirror skills/sentinel/SKILL.md: file not found"
fi

# 6. CHANGELOG.md latest header
f="$PROJECT_ROOT/CHANGELOG.md"
if [[ -f "$f" ]]; then
  v=$(changelog_version "$f")
  if [[ -n "$v" ]]; then
    VERSIONS["CHANGELOG.md"]="$v"
    pass "CHANGELOG.md latest header: version $v"
  else
    VERSIONS["CHANGELOG.md"]="__missing__"
    fail "CHANGELOG.md: no version header found"
  fi
else
  VERSIONS["CHANGELOG.md"]="__missing__"
  fail "CHANGELOG.md: file not found"
fi

# --- Cross-compare all versions ---
echo ""
echo "-- Cross-version comparison --"

# Collect unique non-missing versions
unique_versions=()
for key in "${!VERSIONS[@]}"; do
  v="${VERSIONS[$key]}"
  if [[ "$v" != "__missing__" && "$v" != "__error__" ]]; then
    found=false
    for uv in "${unique_versions[@]+"${unique_versions[@]}"}"; do
      if [[ "$uv" == "$v" ]]; then
        found=true
        break
      fi
    done
    if ! $found; then
      unique_versions+=("$v")
    fi
  fi
done

if [[ ${#unique_versions[@]} -eq 0 ]]; then
  fail "No versions could be extracted from any source"
elif [[ ${#unique_versions[@]} -eq 1 ]]; then
  pass "All sources agree on version: ${unique_versions[0]}"
else
  fail "Version mismatch detected! Found ${#unique_versions[@]} different versions:"
  for key in "${!VERSIONS[@]}"; do
    v="${VERSIONS[$key]}"
    echo -e "    $key: $v"
  done
fi

# Check for any missing versions
missing_count=0
for key in "${!VERSIONS[@]}"; do
  v="${VERSIONS[$key]}"
  if [[ "$v" == "__missing__" || "$v" == "__error__" ]]; then
    ((missing_count++))
  fi
done

if [[ "$missing_count" -gt 0 ]]; then
  fail "$missing_count source(s) had missing or unreadable version"
else
  pass "All version sources are present and readable"
fi

# --- Summary ---
echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Version consistency tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"

exit "$FAIL"
