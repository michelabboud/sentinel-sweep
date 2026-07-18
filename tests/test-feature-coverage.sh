#!/usr/bin/env bash
# test-feature-coverage.sh — Validates honest Sentinel 2.0 host claims and capabilities
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

require_in_file() {
  local file="$1"
  local value="$2"
  local label="$3"
  if grep -qF -- "$value" "$file"; then
    pass "$label"
  else
    fail "$label"
  fi
}

echo "=== Sentinel 2.0 Feature Coverage Tests ==="
echo ""

echo "-- Deterministic support matrix --"
CLAIM_FILES=(
  "$PROJECT_ROOT/commands/sentinel.md"
  "$PROJECT_ROOT/skills/run/SKILL.md"
  "$PROJECT_ROOT/.claude-plugin/plugin.json"
  "$PROJECT_ROOT/.claude-plugin/marketplace.json"
)

for file in "${CLAIM_FILES[@]}"; do
  rel="${file#$PROJECT_ROOT/}"
  require_in_file "$file" 'OpenAPI 3.0/3.1 JSON' "$rel claims OpenAPI 3.0/3.1 JSON"
  require_in_file "$file" 'static literal Vue Router' "$rel claims static literal Vue Router"
  require_in_file "$file" 'bearer-token role' "$rel claims bearer-token roles"
  require_in_file "$file" 'Chrome/Chromium' "$rel claims system Chrome/Chromium"
  require_in_file "$file" 'complete, partial, or unsupported' "$rel reports explicit coverage status"

  if grep -Eqi '14\+ frameworks|supports Python|all frameworks|any web app|full parser' "$file"; then
    fail "$rel contains an unsupported broad execution claim"
  else
    pass "$rel avoids unsupported broad execution claims"
  fi
done

echo ""
echo "-- Thin-host command surface --"
SKILL="$PROJECT_ROOT/skills/run/SKILL.md"
SUBCOMMANDS=(setup manifest api browser sweep report dashboard export trends diff clean)
for subcommand in "${SUBCOMMANDS[@]}"; do
  require_in_file "$SKILL" "| \`$subcommand\` |" "host exposes '$subcommand' through the core"
done

echo ""
echo "-- Read-only explanation agents --"
for file in "$PROJECT_ROOT"/agents/*.md; do
  rel="${file#$PROJECT_ROOT/}"
  require_in_file "$file" 'tools: ["Read"]' "$rel is Read-only"
  require_in_file "$file" 'canonical' "$rel consumes a canonical artifact"
  require_in_file "$file" 'untrusted data' "$rel treats artifact content as untrusted"
  require_in_file "$file" 'instruction injection' "$rel rejects instruction injection"

  if grep -Eqi 'tools:.*(Bash|Write|Edit|Glob|Grep|mcp__|browser_|playwright)' "$file"; then
    fail "$rel retains execution or mutation tools"
  else
    pass "$rel has no execution, mutation, or network tools"
  fi
done

echo ""
echo "-- Core-owned policy boundary --"
HOST="$PROJECT_ROOT/commands/sentinel.md"
require_in_file "$HOST" 'The packaged Node.js core owns all of those behaviors' "core owns discovery and execution"
require_in_file "$HOST" 'does not ask the operator for mutation approval' "host does not approve mutations"
require_in_file "$HOST" 'never promotes target content into trusted config' "target content cannot become authority"
require_in_file "$HOST" 'never recalculate findings, identities, safety, roles, or status' "host does not reinterpret canonical results"

echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Feature coverage tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"

exit "$FAIL"
