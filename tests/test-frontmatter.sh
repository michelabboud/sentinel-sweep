#!/usr/bin/env bash
# test-frontmatter.sh — Validates YAML frontmatter in all skill and agent markdown files
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

# Extract frontmatter from a markdown file (between first two --- lines)
extract_frontmatter() {
  local file="$1"
  sed -n '/^---$/,/^---$/p' "$file" | sed '1d;$d'
}

# Get a field value from frontmatter text
get_field() {
  local fm="$1"
  local field="$2"
  echo "$fm" | grep -E "^${field}:" | head -1 | sed "s/^${field}:[[:space:]]*//" | sed 's/^"\(.*\)"$/\1/' | sed "s/^'\(.*\)'$/\1/"
}

# Check if frontmatter has duplicate field names
check_duplicates() {
  local fm="$1"
  local file="$2"
  local dupes
  dupes=$(echo "$fm" | grep -oE '^[a-zA-Z_-]+:' | sort | uniq -d)
  if [[ -z "$dupes" ]]; then
    pass "$file: no duplicate frontmatter fields"
  else
    fail "$file: duplicate frontmatter fields: $dupes"
  fi
}

echo "=== Frontmatter Validation Tests ==="
echo ""

# Collect all skill and agent markdown files (root level only, not mirror)
SKILL_FILES=()
while IFS= read -r -d '' f; do
  SKILL_FILES+=("$f")
done < <(find "$PROJECT_ROOT/skills" -maxdepth 3 -name "SKILL.md" -print0 2>/dev/null)

AGENT_FILES=()
while IFS= read -r -d '' f; do
  AGENT_FILES+=("$f")
done < <(find "$PROJECT_ROOT/agents" -maxdepth 1 -name "*.md" -print0 2>/dev/null)

ALL_FILES=("${SKILL_FILES[@]}" "${AGENT_FILES[@]}")

for filepath in "${ALL_FILES[@]}"; do
  rel="${filepath#$PROJECT_ROOT/}"
  echo "-- $rel --"

  # Check file has frontmatter
  first_line=$(head -1 "$filepath")
  if [[ "$first_line" != "---" ]]; then
    fail "$rel: no YAML frontmatter found (file does not start with ---)"
    continue
  fi

  fm=$(extract_frontmatter "$filepath")
  if [[ -z "$fm" ]]; then
    fail "$rel: empty frontmatter"
    continue
  fi

  # Skills require 'name' field; agents use 'name' too
  is_skill=false
  if [[ "$rel" == skills/* ]]; then
    is_skill=true
  fi

  # Check 'name' for skills
  if $is_skill; then
    name_val=$(get_field "$fm" "name")
    if [[ -n "$name_val" ]]; then
      pass "$rel: has 'name' field ($name_val)"
    else
      fail "$rel: missing required 'name' field"
    fi
  fi

  # Check 'name' for agents
  if [[ "$rel" == agents/* ]]; then
    name_val=$(get_field "$fm" "name")
    if [[ -n "$name_val" ]]; then
      pass "$rel: has 'name' field ($name_val)"
    else
      fail "$rel: missing required 'name' field"
    fi
  fi

  # Check 'description'
  desc_val=$(get_field "$fm" "description")
  if [[ -n "$desc_val" ]]; then
    pass "$rel: has 'description' field"
  else
    fail "$rel: missing required 'description' field"
  fi

  # Check 'version'
  version_val=$(get_field "$fm" "version")
  if [[ -n "$version_val" ]]; then
    pass "$rel: has 'version' field ($version_val)"
    # Validate semver format (X.Y.Z)
    if [[ "$version_val" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      pass "$rel: version '$version_val' is valid semver"
    else
      fail "$rel: version '$version_val' is not valid semver (expected X.Y.Z)"
    fi
  else
    fail "$rel: missing required 'version' field"
  fi

  # Check 'allowed-tools' is valid JSON array (if present)
  tools_line=$(echo "$fm" | grep -E "^allowed-tools:" | head -1 || true)
  if [[ -n "$tools_line" ]]; then
    tools_val=$(echo "$tools_line" | sed 's/^allowed-tools:[[:space:]]*//')
    # Basic JSON array validation: starts with [, ends with ], contains quoted strings
    if [[ "$tools_val" =~ ^\[.*\]$ ]]; then
      # Deeper check: try parsing with bash (check balanced brackets and quoted items)
      # Simple validation: ensure no unquoted words between brackets
      if echo "$tools_val" | grep -qE '^\[("[^"]*"(,[[:space:]]*"[^"]*")*)?\]$'; then
        pass "$rel: allowed-tools is valid JSON array"
      else
        fail "$rel: allowed-tools has malformed JSON array: $tools_val"
      fi
    else
      fail "$rel: allowed-tools is not a JSON array: $tools_val"
    fi
  fi

  # Check for duplicate field names
  check_duplicates "$fm" "$rel"

  echo ""
done

# Thin-host least-privilege contract
echo "-- Thin-host tool boundaries --"

COMMAND_FILE="$PROJECT_ROOT/commands/sentinel.md"
COMMAND_FM=$(extract_frontmatter "$COMMAND_FILE")
COMMAND_TOOLS=$(get_field "$COMMAND_FM" "allowed-tools")
SKILL_FM=$(extract_frontmatter "$PROJECT_ROOT/skills/run/SKILL.md")
SKILL_TOOLS=$(get_field "$SKILL_FM" "allowed-tools")

if [[ "$COMMAND_TOOLS" == '["Bash", "Read"]' ]]; then
  pass "commands/sentinel.md: allowed-tools is exactly Bash + Read"
else
  fail "commands/sentinel.md: expected Bash + Read only, got $COMMAND_TOOLS"
fi

if [[ "$SKILL_TOOLS" == '["Bash", "Read"]' ]]; then
  pass "skills/run/SKILL.md: allowed-tools is exactly Bash + Read"
else
  fail "skills/run/SKILL.md: expected Bash + Read only, got $SKILL_TOOLS"
fi

for filepath in "${AGENT_FILES[@]}"; do
  rel="${filepath#$PROJECT_ROOT/}"
  fm=$(extract_frontmatter "$filepath")
  tools_val=$(get_field "$fm" "tools")
  if [[ "$tools_val" == '["Read"]' ]]; then
    pass "$rel: tools is exactly Read"
  else
    fail "$rel: expected Read only, got $tools_val"
  fi
done

echo ""

# --- Summary ---
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Frontmatter tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"

exit "$FAIL"
