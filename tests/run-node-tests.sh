#!/usr/bin/env bash
# run-node-tests.sh — Run Sentinel's dependency-free Node.js test suites.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

mapfile -d '' TEST_FILES < <(
  find tests \
    -type f \
    -name '*.test.mjs' \
    -not -path '*/fixtures/*' \
    -print0 \
    | sort -z
)

if [[ "${#TEST_FILES[@]}" -eq 0 ]]; then
  echo "No Node.js tests found" >&2
  exit 1
fi

node --test "${TEST_FILES[@]}"
