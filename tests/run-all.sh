#!/usr/bin/env bash
# run-all.sh — Runs all Sentinel integration tests and reports pass/fail summary
set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"

TOTAL_SUITES=0
PASSED_SUITES=0
FAILED_SUITES=0
FAILED_NAMES=()

TESTS=(
  "run-node-tests.sh"
  "test-structure.sh"
  "test-frontmatter.sh"
  "test-manifest-schema.sh"
  "test-mirror-parity.sh"
  "test-version-consistency.sh"
  "test-runtime-behavior.sh"
  "test-bump-version.sh"
  "test-feature-coverage.sh"
  "test-secret-scan.sh"
)

# Optional tests — run if available but don't fail the suite if runner is missing
OPTIONAL_TESTS=(
  "../codex/tests/test-codex-port.sh"
)

echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}   Sentinel Plugin Integration Tests${NC}"
echo -e "${BOLD}========================================${NC}"
echo ""

for test in "${TESTS[@]}"; do
  test_path="$TESTS_DIR/$test"
  ((TOTAL_SUITES++))

  if [[ ! -f "$test_path" ]]; then
    echo -e "${RED}MISSING${NC} $test — file not found"
    ((FAILED_SUITES++))
    FAILED_NAMES+=("$test")
    continue
  fi

  if [[ ! -x "$test_path" ]]; then
    echo -e "${YELLOW}WARNING${NC} $test is not executable, running with bash"
  fi

  echo -e "${BOLD}>>> $test${NC}"
  echo ""

  if bash "$test_path"; then
    echo ""
    echo -e "  ${GREEN}SUITE PASSED${NC}"
    ((PASSED_SUITES++))
  else
    echo ""
    echo -e "  ${RED}SUITE FAILED${NC}"
    ((FAILED_SUITES++))
    FAILED_NAMES+=("$test")
  fi

  echo ""
done

# --- Final Summary ---
echo -e "${BOLD}========================================${NC}"
echo -e "${BOLD}   Final Summary${NC}"
echo -e "${BOLD}========================================${NC}"
echo ""
echo -e "  Suites run:    $TOTAL_SUITES"
echo -e "  Suites passed: ${GREEN}$PASSED_SUITES${NC}"
echo -e "  Suites failed: ${RED}$FAILED_SUITES${NC}"

if [[ ${#FAILED_NAMES[@]} -gt 0 ]]; then
  echo ""
  echo -e "  ${RED}Failed suites:${NC}"
  for name in "${FAILED_NAMES[@]}"; do
    echo -e "    - $name"
  done
fi

echo ""

if [[ "$FAILED_SUITES" -gt 0 ]]; then
  echo -e "${RED}RESULT: FAIL${NC}"
  exit 1
else
  echo -e "${GREEN}RESULT: ALL PASSED${NC}"
  exit 0
fi
