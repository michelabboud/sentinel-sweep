#!/usr/bin/env bash
# test-bump-version.sh — Regression tests for bump-version.sh
# Ensures version bumping doesn't corrupt IP addresses, URLs, or other content
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$PROJECT_ROOT/scripts/bump-version.sh"

pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  FAIL=$((FAIL + 1))
}

echo "=== Bump Version Regression Tests ==="
echo ""

# Save current state
ORIGINAL_VERSION=$(tr -d '[:space:]' < "$PROJECT_ROOT/VERSION")

# -- Test: Script exists and is valid --
echo "-- Script validation --"

if [[ -f "$SCRIPT" ]]; then
  pass "bump-version.sh exists"
else
  fail "bump-version.sh not found"
  exit 1
fi

if bash -n "$SCRIPT" 2>/dev/null; then
  pass "bump-version.sh has valid bash syntax"
else
  fail "bump-version.sh has syntax errors"
fi

# -- Test: Regex escaping (the v1.8.1 fix) --
echo ""
echo "-- Regex safety tests --"

# The OLD_ESCAPED variable should escape dots
OLD_ESCAPED="${ORIGINAL_VERSION//./\\.}"
if echo "127.0.0.1" | grep -qP "$OLD_ESCAPED"; then
  fail "Escaped version regex matches inside 127.0.0.1 (version: $ORIGINAL_VERSION)"
else
  pass "Escaped version regex does NOT match inside 127.0.0.1"
fi

# Test all historically dangerous version patterns
DANGEROUS_VERSIONS=("1.7.0" "1.2.0" "1.0.0" "2.7.0" "1.27.0")
for v in "${DANGEROUS_VERSIONS[@]}"; do
  escaped="${v//./\\.}"
  if echo "127.0.0.1" | sed "s/\"${escaped}\"/REPLACED/g" | grep -q "REPLACED"; then
    fail "Version $v (escaped) corrupts quoted 127.0.0.1"
  else
    pass "Version $v (escaped) is safe for quoted 127.0.0.1"
  fi
done

# Verify the script uses escaped dots (not raw version string)
if grep -q 'OLD_ESCAPED.*//\./\\\\\.}' "$SCRIPT"; then
  pass "Script escapes dots in OLD_VERSION for regex safety"
else
  # Alternative check for the bash substitution pattern
  if grep -q 'OLD_ESCAPED=' "$SCRIPT" && grep -q '\\\.' "$SCRIPT"; then
    pass "Script escapes dots in OLD_VERSION for regex safety"
  else
    fail "Script does not appear to escape dots for regex safety"
  fi
fi

# Verify the script does NOT use blind global replace
if grep -q "sed -i \"s/\$OLD_VERSION/\$NEW_VERSION/g\"" "$SCRIPT"; then
  fail "Script uses unsafe blind sed replace (s/\$OLD_VERSION/\$NEW_VERSION/g)"
else
  pass "Script does NOT use unsafe blind sed replace"
fi

# -- Test: Version format validation --
echo ""
echo "-- Input validation --"

# Script should reject non-semver input (exit code != 0)
if ! bash "$SCRIPT" "not-a-version" >/dev/null 2>&1; then
  pass "Rejects non-semver input"
else
  fail "Does not reject non-semver input"
fi

if ! bash "$SCRIPT" "1.2" >/dev/null 2>&1; then
  pass "Rejects incomplete semver (1.2)"
else
  fail "Does not reject incomplete semver"
fi

if bash "$SCRIPT" "$ORIGINAL_VERSION" 2>&1 | grep -q "Already"; then
  pass "No-op when bumping to same version"
else
  fail "Does not detect same-version no-op"
fi

# -- Test: Targeted replacement patterns --
echo ""
echo "-- Replacement pattern coverage --"

# Check that the script targets specific patterns, not blind replace
# Check the script uses frontmatter version pattern
if grep -qF 'version:' "$SCRIPT" && grep -qF 'OLD_ESCAPED' "$SCRIPT"; then
  pass "Script targets YAML frontmatter version pattern"
else
  fail "Script missing YAML frontmatter version pattern"
fi

if grep -qF '"version":' "$SCRIPT"; then
  pass "Script targets JSON version pattern"
else
  fail "Script missing JSON version pattern"
fi

if grep -qF 'bump-version.sh' "$SCRIPT"; then
  pass "Script targets bump-version.sh self-reference"
else
  fail "Script missing bump-version.sh self-reference"
fi

# -- Test: IP addresses in agent files survive --
echo ""
echo "-- Content preservation --"

# Check that 127.0.0.1 exists in api-sweeper (it should always be there)
if grep -q "127.0.0.1" "$PROJECT_ROOT/agents/api-sweeper.md"; then
  pass "127.0.0.1 present in api-sweeper.md"
else
  fail "127.0.0.1 missing from api-sweeper.md (may have been corrupted)"
fi

# Check that localhost references are intact
if grep -q "localhost" "$PROJECT_ROOT/agents/api-sweeper.md"; then
  pass "localhost references intact in api-sweeper.md"
else
  fail "localhost references missing from api-sweeper.md"
fi

# --- Summary ---
echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Bump version tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"
echo ""

exit "$FAIL"
