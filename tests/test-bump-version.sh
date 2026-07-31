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
TARGET_VERSION="2.0.0"
FIXTURE_OLD_VERSION="1.9.9"
TMP_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf -- "$TMP_ROOT"
}
trap cleanup EXIT

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

pass "Same-version repair behavior is exercised only in the isolated fixture below"

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

if grep -qF 'JSON_VERSION_FILES' "$SCRIPT" && grep -qF '\"version\":' "$SCRIPT"; then
  pass "Script targets explicit JSON version surfaces"
else
  fail "Script missing explicit JSON version surfaces"
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

# -- Test: Complete bump and mirror synchronization in an isolated copy --
echo ""
echo "-- Isolated complete bump and mirror sync --"

copy_fixture() {
  local destination="$1"
  mkdir -p "$destination/scripts"
  cp -a "$PROJECT_ROOT/.claude-plugin" "$destination/"
  cp -a "$PROJECT_ROOT/agents" "$destination/"
  cp -a "$PROJECT_ROOT/commands" "$destination/"
  cp -a "$PROJECT_ROOT/runtime" "$destination/"
  cp -a "$PROJECT_ROOT/schemas" "$destination/"
  cp -a "$PROJECT_ROOT/skills" "$destination/"
  cp -a "$PROJECT_ROOT/codex" "$destination/"
  cp -a "$PROJECT_ROOT/plugins" "$destination/"
  cp -a "$PROJECT_ROOT/scripts/bump-version.sh" "$destination/scripts/"
  for rel in VERSION package.json settings.json LICENSE README.md SECURITY.md CONTRIBUTING.md CHANGELOG.md CLAUDE.md ARCHITECTURE.md; do
    cp -a "$PROJECT_ROOT/$rel" "$destination/$rel"
  done
}

prepare_old_fixture() {
  local destination="$1"
  local source_version
  local source_escaped
  source_version=$(tr -d '[:space:]' < "$destination/VERSION")
  source_escaped="${source_version//./\\.}"

  printf '%s\n' "$FIXTURE_OLD_VERSION" > "$destination/VERSION"
  for rel in package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json; do
    sed -i "s/\"version\": \"${source_escaped}\"/\"version\": \"${FIXTURE_OLD_VERSION}\"/g" "$destination/$rel"
  done
  for rel in skills/run/SKILL.md agents/manifest-generator.md agents/api-sweeper.md agents/browser-sweeper.md; do
    sed -i "s/^version: ${source_escaped}$/version: ${FIXTURE_OLD_VERSION}/" "$destination/$rel"
  done
  for rel in codex/commands/sentinel.md codex/agents/manifest-generator.md codex/agents/api-sweeper.md codex/agents/browser-sweeper.md; do
    sed -i "s/^version: ${source_escaped}-codex\.[0-9]\+$/version: ${FIXTURE_OLD_VERSION}-codex.1/" "$destination/$rel"
  done
  sed -i "0,/^## \[[0-9][0-9.]*\]/s//## [$FIXTURE_OLD_VERSION]/" "$destination/CHANGELOG.md"
  printf '\nCurrent release: Sentinel %s\nVersion test IP: 127.0.0.1\n' "$FIXTURE_OLD_VERSION" >> "$destination/README.md"
  printf '\nCurrent release: Sentinel %s\n' "$FIXTURE_OLD_VERSION" >> "$destination/CLAUDE.md"
}

fixture_json_version() {
  local file="$1"
  python3 - "$file" <<'PY'
import json
import sys
with open(sys.argv[1], encoding='utf-8') as handle:
    print(json.load(handle)['version'])
PY
}

fixture_marketplace_version() {
  local file="$1"
  python3 - "$file" <<'PY'
import json
import sys
with open(sys.argv[1], encoding='utf-8') as handle:
    print(json.load(handle)['plugins'][0]['version'])
PY
}

fixture_frontmatter_version() {
  sed -n '/^---$/,/^---$/p' "$1" | sed '1d;$d' | sed -n 's/^version:[[:space:]]*//p' | head -1
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label (expected $expected, got ${actual:-__missing__})"
  fi
}

FIXTURE="$TMP_ROOT/Sentinel Fixture"
copy_fixture "$FIXTURE"
prepare_old_fixture "$FIXTURE"

if bash "$FIXTURE/scripts/bump-version.sh" "$TARGET_VERSION" >"$TMP_ROOT/bump.out" 2>"$TMP_ROOT/bump.err"; then
  pass "Bumps an isolated copied fixture"
else
  fail "Fails to bump an isolated copied fixture"
  sed -n '1,80p' "$TMP_ROOT/bump.err" | sed 's/^/    /'
fi

assert_equal "$TARGET_VERSION" "$(tr -d '[:space:]' < "$FIXTURE/VERSION")" "Updates canonical VERSION"
assert_equal "$TARGET_VERSION" "$(fixture_json_version "$FIXTURE/package.json")" "Updates canonical package.json"
assert_equal "$TARGET_VERSION" "$(fixture_json_version "$FIXTURE/.claude-plugin/plugin.json")" "Updates canonical plugin metadata"
assert_equal "$TARGET_VERSION" "$(fixture_marketplace_version "$FIXTURE/.claude-plugin/marketplace.json")" "Updates canonical marketplace metadata"

for rel in skills/run/SKILL.md agents/manifest-generator.md agents/api-sweeper.md agents/browser-sweeper.md; do
  assert_equal "$TARGET_VERSION" "$(fixture_frontmatter_version "$FIXTURE/$rel")" "Updates $rel frontmatter"
done

for rel in codex/commands/sentinel.md codex/agents/manifest-generator.md codex/agents/api-sweeper.md codex/agents/browser-sweeper.md; do
  assert_equal "$TARGET_VERSION-codex.1" "$(fixture_frontmatter_version "$FIXTURE/$rel")" "Updates $rel compatibility version"
done

assert_equal "$TARGET_VERSION" "$(sed -n 's/^## \[\([0-9][0-9.]*\)\].*/\1/p' "$FIXTURE/CHANGELOG.md" | head -1)" "Updates only the current CHANGELOG header"
if grep -qF "Current release: Sentinel $TARGET_VERSION" "$FIXTURE/README.md" && grep -qF "Current release: Sentinel $TARGET_VERSION" "$FIXTURE/CLAUDE.md"; then
  pass "Updates current-release documentation markers"
else
  fail "Does not update current-release documentation markers"
fi
if grep -qF '127.0.0.1' "$FIXTURE/README.md"; then
  pass "Preserves IP literals during a real isolated bump"
else
  fail "Corrupts IP literals during a real isolated bump"
fi

PARITY_DIRS=(.claude-plugin agents commands runtime schemas skills)
PARITY_FILES=(VERSION package.json settings.json LICENSE README.md SECURITY.md CONTRIBUTING.md CHANGELOG.md CLAUDE.md ARCHITECTURE.md)
MIRROR_COMPLETE=true
for dir in "${PARITY_DIRS[@]}"; do
  while IFS= read -r -d '' source; do
    rel="${source#$FIXTURE/}"
    if [[ ! -f "$FIXTURE/plugins/sentinel/$rel" ]] || ! cmp -s "$source" "$FIXTURE/plugins/sentinel/$rel"; then
      MIRROR_COMPLETE=false
    fi
  done < <(find "$FIXTURE/$dir" -type f -print0)
done
for rel in "${PARITY_FILES[@]}"; do
  if [[ ! -f "$FIXTURE/plugins/sentinel/$rel" ]] || ! cmp -s "$FIXTURE/$rel" "$FIXTURE/plugins/sentinel/$rel"; then
    MIRROR_COMPLETE=false
  fi
done
if $MIRROR_COMPLETE; then
  pass "Mechanically syncs every canonical installable asset byte-for-byte"
else
  fail "Does not sync the complete canonical installable inventory"
fi

assert_equal "$TARGET_VERSION" "$(node "$FIXTURE/runtime/cli.mjs" --version)" "Canonical CLI reports bumped version"
if [[ -f "$FIXTURE/plugins/sentinel/runtime/cli.mjs" ]]; then
  assert_equal "$TARGET_VERSION" "$(node "$FIXTURE/plugins/sentinel/runtime/cli.mjs" --version)" "Mirror CLI reports bumped version"
else
  fail "Mirror CLI is absent after bump"
fi

# A same-version rerun must repair a missing mirror file rather than exiting early.
rm -f -- "$FIXTURE/plugins/sentinel/runtime/cli.mjs"
if bash "$FIXTURE/scripts/bump-version.sh" "$TARGET_VERSION" >"$TMP_ROOT/repeat.out" 2>"$TMP_ROOT/repeat.err" && cmp -s "$FIXTURE/runtime/cli.mjs" "$FIXTURE/plugins/sentinel/runtime/cli.mjs"; then
  pass "Same-version rerun repairs mirror drift"
else
  fail "Same-version rerun leaves mirror drift"
fi

# Exact destinations are preflighted: a mirror symlink must abort before VERSION changes.
UNSAFE_FIXTURE="$TMP_ROOT/Unsafe Fixture"
copy_fixture "$UNSAFE_FIXTURE"
prepare_old_fixture "$UNSAFE_FIXTURE"
mkdir -p "$UNSAFE_FIXTURE/plugins/sentinel/runtime"
rm -f -- "$UNSAFE_FIXTURE/plugins/sentinel/runtime/cli.mjs"
ln -s "$UNSAFE_FIXTURE/runtime/cli.mjs" "$UNSAFE_FIXTURE/plugins/sentinel/runtime/cli.mjs"
if bash "$UNSAFE_FIXTURE/scripts/bump-version.sh" "$TARGET_VERSION" >"$TMP_ROOT/unsafe.out" 2>"$TMP_ROOT/unsafe.err"; then
  fail "Accepts a symlinked mirror destination"
else
  pass "Rejects a symlinked mirror destination"
fi
assert_equal "$FIXTURE_OLD_VERSION" "$(tr -d '[:space:]' < "$UNSAFE_FIXTURE/VERSION")" "Preflight failure leaves VERSION unchanged"

assert_equal "$ORIGINAL_VERSION" "$(tr -d '[:space:]' < "$PROJECT_ROOT/VERSION")" "Isolated regression never mutates the real worktree"

# --- Summary ---
echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Bump version tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"
echo ""

exit "$FAIL"
