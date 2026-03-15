#!/usr/bin/env bash
# test-structure.sh — Validates plugin file structure and Hello Protocol compliance
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

echo "=== Plugin Structure Tests ==="
echo ""

# --- Required root files ---
echo "-- Required root files --"

REQUIRED_ROOT_FILES=(
  "skills/run/SKILL.md"
  "skills/sentinel-setup/SKILL.md"
  "agents/manifest-generator.md"
  "agents/api-sweeper.md"
  "agents/browser-sweeper.md"
  "settings.json"
  ".claude-plugin/plugin.json"
)

for f in "${REQUIRED_ROOT_FILES[@]}"; do
  if [[ -f "$PROJECT_ROOT/$f" ]]; then
    pass "$f exists"
  else
    fail "$f is missing"
  fi
done

# --- Plugin mirror files ---
echo ""
echo "-- Plugin mirror directory (plugins/sentinel/) --"

REQUIRED_MIRROR_FILES=(
  "plugins/sentinel/skills/run/SKILL.md"
  "plugins/sentinel/skills/sentinel-setup/SKILL.md"
  "plugins/sentinel/agents/manifest-generator.md"
  "plugins/sentinel/agents/api-sweeper.md"
  "plugins/sentinel/agents/browser-sweeper.md"
  "plugins/sentinel/settings.json"
  "plugins/sentinel/.claude-plugin/plugin.json"
  "plugins/sentinel/LICENSE"
  "plugins/sentinel/README.md"
)

for f in "${REQUIRED_MIRROR_FILES[@]}"; do
  if [[ -f "$PROJECT_ROOT/$f" ]]; then
    pass "mirror: $f exists"
  else
    fail "mirror: $f is missing"
  fi
done

# --- Command/Skill parity ---
echo ""
echo "-- Command/Skill body parity --"

CMD_BODY=$(sed -n '/^You are the Sentinel/,$p' "$PROJECT_ROOT/commands/sentinel.md")
SKILL_BODY=$(sed -n '/^You are the Sentinel/,$p' "$PROJECT_ROOT/skills/run/SKILL.md")

if [[ "$CMD_BODY" == "$SKILL_BODY" ]]; then
  pass "commands/sentinel.md body matches skills/run/SKILL.md body"
else
  fail "commands/sentinel.md and skills/run/SKILL.md bodies have drifted"
fi

# --- Marketplace.json in mirror ---
echo ""
echo "-- Marketplace.json mirror --"

if [[ -f "$PROJECT_ROOT/plugins/sentinel/.claude-plugin/marketplace.json" ]]; then
  pass "marketplace.json exists in plugin mirror"
else
  fail "marketplace.json missing from plugin mirror"
fi

# --- Broken symlinks ---
echo ""
echo "-- Broken symlinks --"

broken_links=$(find "$PROJECT_ROOT" -xtype l -not -path '*/.git/*' 2>/dev/null || true)
if [[ -z "$broken_links" ]]; then
  pass "No broken symlinks found"
else
  while IFS= read -r link; do
    fail "Broken symlink: $link"
  done <<< "$broken_links"
fi

# --- Hello Protocol in agents ---
echo ""
echo "-- Hello Protocol in agent files --"

AGENT_FILES=(
  "agents/manifest-generator.md"
  "agents/api-sweeper.md"
  "agents/browser-sweeper.md"
)

for f in "${AGENT_FILES[@]}"; do
  filepath="$PROJECT_ROOT/$f"
  if [[ ! -f "$filepath" ]]; then
    fail "$f: file not found (cannot check Hello Protocol)"
    continue
  fi
  if grep -qi "hello protocol\|hello.*sweeper\|hello.*generator\|hello.*ID" "$filepath"; then
    pass "$f has Hello Protocol section"
  else
    fail "$f is missing Hello Protocol section"
  fi
done

# --- Summary ---
echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Structure tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"

exit "$FAIL"
