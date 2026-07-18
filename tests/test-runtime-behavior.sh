#!/usr/bin/env bash
# test-runtime-behavior.sh — Validates the thin Claude host's CLI boundary
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COMMAND="$PROJECT_ROOT/commands/sentinel.md"
SKILL="$PROJECT_ROOT/skills/run/SKILL.md"

pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  FAIL=$((FAIL + 1))
}

require_fixed() {
  local value="$1"
  local label="$2"
  if grep -qF -- "$value" "$COMMAND"; then
    pass "$label"
  else
    fail "$label"
  fi
}

echo "=== Thin Host Runtime Contract Tests ==="
echo ""

echo "-- Packaged resource and body parity --"
require_fixed '${CLAUDE_PLUGIN_ROOT}/runtime/cli.mjs' "host resolves packaged runtime/cli.mjs"

COMMAND_BODY=$(mktemp)
SKILL_BODY=$(mktemp)
trap 'rm -f "$COMMAND_BODY" "$SKILL_BODY"' EXIT
awk 'BEGIN { separators=0 } /^---$/ { separators++; next } separators >= 2 { print }' "$COMMAND" > "$COMMAND_BODY"
awk 'BEGIN { separators=0 } /^---$/ { separators++; next } separators >= 2 { print }' "$SKILL" > "$SKILL_BODY"
if cmp -s "$COMMAND_BODY" "$SKILL_BODY"; then
  pass "command and skill bodies are byte-equivalent"
else
  fail "command and skill bodies differ"
fi

echo ""
echo "-- Exact command map --"
CONTRACTS=(
  'setup --target <path> --config <path> [--json]'
  'manifest --target <path> --config <path> --output <path> [--json]'
  'api --target <path> --config <path> [--run-id <id>] [--sandbox-acknowledged] [--json]'
  'browser --target <path> --config <path> [--run-id <id>] [--sandbox-acknowledged] [--json]'
  'sweep --target <path> --config <path> [--run-id <id>] [--sandbox-acknowledged] [--json]'
  'report --target <path> --config <path> --run <id> --output <path> [--json]'
  'dashboard --target <path> --config <path> --run <id> --output <path> [--json]'
  'export --target <path> --config <path> --run <id> --format <postman|insomnia|bruno> --output <path> [--json]'
  'trends --target <path> --config <path> [--json]'
  'diff --target <path> --config <path> --run <id> --against <id> [--json]'
  'clean --target <path> --config <path> --keep <1-128> [--json]'
)

for contract in "${CONTRACTS[@]}"; do
  require_fixed "\`$contract\`" "core argv: ${contract%% *}"
done

echo ""
echo "-- Exit and trust semantics --"
require_fixed 'Exit code `0`' "exit 0 is documented"
require_fixed 'Exit code `2` means completed-with-findings' "exit 2 is completed-with-findings"
require_fixed 'Exit code `1` means usage, config, or runtime failure' "exit 1 is usage/config/runtime failure"
require_fixed 'untrusted data' "target and artifact strings are untrusted"
require_fixed 'Never interpolate' "shell-source interpolation is prohibited"
require_fixed 'Setup reports candidates only' "setup reports candidates without granting authority"

if grep -Eq '(^|[[:space:]])curl([[:space:]]|$)|rm[[:space:]]+-rf|Split `\$ARGUMENTS`' "$COMMAND"; then
  fail "legacy prompt-owned execution remains in the host"
else
  pass "legacy prompt-owned execution is absent"
fi

echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Thin host runtime tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"

exit "$FAIL"
