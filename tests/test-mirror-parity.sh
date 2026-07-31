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
EXPECTED_INVENTORY="$(mktemp)"
ACTUAL_INVENTORY="$(mktemp)"

cleanup() {
  rm -f -- "$EXPECTED_INVENTORY" "$ACTUAL_INVENTORY"
}
trap cleanup EXIT

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

# Root is canonical. These directory trees and top-level assets are the complete
# installable Claude plugin inventory. Codex assets remain root-only launchers.
PARITY_DIRS=(
  ".claude-plugin"
  "agents"
  "commands"
  "runtime"
  "schemas"
  "skills"
)

PARITY_FILES=(
  "VERSION"
  "package.json"
  "settings.json"
  "LICENSE"
  "README.md"
  "SECURITY.md"
  "CONTRIBUTING.md"
  "CHANGELOG.md"
  "CLAUDE.md"
  "ARCHITECTURE.md"
)

echo "-- Canonical inventory --"

for dir in "${PARITY_DIRS[@]}"; do
  if [[ ! -d "$PROJECT_ROOT/$dir" || -L "$PROJECT_ROOT/$dir" ]]; then
    fail "$dir: canonical directory is missing or is a symlink"
    continue
  fi
  if find "$PROJECT_ROOT/$dir" -type l -print -quit | grep -q .; then
    fail "$dir: canonical directory contains a symlink"
  fi
  while IFS= read -r -d '' root_file; do
    printf '%s\n' "${root_file#$PROJECT_ROOT/}" >> "$EXPECTED_INVENTORY"
  done < <(find "$PROJECT_ROOT/$dir" -type f -print0)
done

for root_rel in "${PARITY_FILES[@]}"; do
  if [[ ! -f "$PROJECT_ROOT/$root_rel" || -L "$PROJECT_ROOT/$root_rel" ]]; then
    fail "$root_rel: canonical file is missing or is a symlink"
    continue
  fi
  printf '%s\n' "$root_rel" >> "$EXPECTED_INVENTORY"
done

sort -u -o "$EXPECTED_INVENTORY" "$EXPECTED_INVENTORY"

if [[ ! -d "$MIRROR" || -L "$MIRROR" ]]; then
  fail "plugins/sentinel: mirror is missing or is a symlink"
else
  if find "$MIRROR" -type l -print -quit | grep -q .; then
    fail "plugins/sentinel: mirror contains a symlink"
  fi
  while IFS= read -r -d '' mirror_file; do
    printf '%s\n' "${mirror_file#$MIRROR/}" >> "$ACTUAL_INVENTORY"
  done < <(find "$MIRROR" -type f -print0)
fi

sort -u -o "$ACTUAL_INVENTORY" "$ACTUAL_INVENTORY"

if diff -u "$EXPECTED_INVENTORY" "$ACTUAL_INVENTORY" >/dev/null; then
  pass "mirror file inventory exactly matches canonical shipped assets"
else
  fail "mirror file inventory differs from canonical shipped assets"
  diff -u "$EXPECTED_INVENTORY" "$ACTUAL_INVENTORY" | sed -n '1,80p' | sed 's/^/    /' || true
fi

echo ""
echo "-- Byte parity --"

while IFS= read -r root_rel; do
  [[ -n "$root_rel" ]] || continue

  root_file="$PROJECT_ROOT/$root_rel"
  mirror_file="$MIRROR/$root_rel"

  if [[ ! -f "$mirror_file" || -L "$mirror_file" ]]; then
    fail "$root_rel: missing from mirror or is a symlink"
    continue
  fi

  if cmp -s "$root_file" "$mirror_file"; then
    pass "$root_rel matches mirror"
  else
    fail "$root_rel DIFFERS from mirror"
    echo -e "    ${RED}First difference:${NC}"
    diff --unified=1 "$root_file" "$mirror_file" | head -15 | sed 's/^/    /' || true
    echo ""
  fi
done < "$EXPECTED_INVENTORY"

# --- Summary ---
echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Mirror parity tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"

exit "$FAIL"
