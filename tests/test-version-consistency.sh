#!/usr/bin/env bash
# test-version-consistency.sh — Validates version numbers match across all locations
# Source of truth: VERSION file at project root
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
  python3 - "$file" <<'PY' 2>/dev/null || echo "__error__"
import json
import sys
with open(sys.argv[1], encoding='utf-8') as handle:
    data = json.load(handle)
val = data.get('version', '__missing__')
print(val if val else '__missing__')
PY
}

marketplace_version() {
  local file="$1"
  python3 - "$file" <<'PY' 2>/dev/null || echo "__error__"
import json
import sys
with open(sys.argv[1], encoding='utf-8') as handle:
    data = json.load(handle)
plugins = data.get('plugins', [])
print(plugins[0].get('version', '__missing__') if plugins else '__missing__')
PY
}

# Extract version from YAML frontmatter of a markdown file
frontmatter_version() {
  local file="$1"
  sed -n '/^---$/,/^---$/p' "$file" | sed '1d;$d' | grep -E '^version:' | head -1 | sed 's/^version:[[:space:]]*//' | sed 's/^"\(.*\)"$/\1/' | sed "s/^'\(.*\)'$/\1/" || true
}

# Extract latest version from CHANGELOG.md header
changelog_version() {
  local file="$1"
  grep -E '^\#\#\s+\[' "$file" | head -1 | sed 's/.*\[\([0-9][0-9.]*\)\].*/\1/' || true
}

echo "=== Version Consistency Tests ==="
echo ""

# --- Source of truth: VERSION file ---
VERSION_FILE="$PROJECT_ROOT/VERSION"
if [[ -f "$VERSION_FILE" ]]; then
  EXPECTED=$(tr -d '[:space:]' < "$VERSION_FILE")
  pass "VERSION file exists: $EXPECTED"
else
  echo -e "  ${RED}FATAL${NC} VERSION file not found at project root"
  exit 1
fi

# VERSION is the source of truth, so this suite validates its SHAPE and then holds
# every other surface to it. A frozen literal here (it was pinned to 2.0.0) fails
# every release after the one it was written for, which is a release blocker rather
# than a safety property — the real guarantee is that nothing drifts from VERSION.
if [[ "$EXPECTED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  pass "VERSION is valid semver ($EXPECTED)"
else
  fail "VERSION must be semver (for example, 2.0.1), got $EXPECTED"
fi

echo ""
echo "-- Checking all locations match VERSION ($EXPECTED) --"

# Check a file's version against EXPECTED
check_version() {
  local label="$1"
  local actual="$2"
  if [[ "$actual" == "$EXPECTED" ]]; then
    pass "$label: $actual"
  elif [[ "$actual" == "__missing__" || "$actual" == "__error__" ]]; then
    fail "$label: version not found"
  else
    fail "$label: expected $EXPECTED, got $actual"
  fi
}

# 1. Marketplace and package metadata in root and mirror
for scope in "$PROJECT_ROOT" "$PROJECT_ROOT/plugins/sentinel"; do
  if [[ "$scope" == "$PROJECT_ROOT" ]]; then
    label="root"
  else
    label="mirror"
  fi

  f="$scope/.claude-plugin/marketplace.json"
  if [[ -f "$f" ]]; then
    check_version "$label .claude-plugin/marketplace.json" "$(marketplace_version "$f")"
  else
    fail "$label .claude-plugin/marketplace.json: file not found"
  fi

  f="$scope/.claude-plugin/plugin.json"
  if [[ -f "$f" ]]; then
    check_version "$label .claude-plugin/plugin.json" "$(json_version "$f")"
  else
    fail "$label .claude-plugin/plugin.json: file not found"
  fi

  f="$scope/package.json"
  if [[ -f "$f" ]]; then
    check_version "$label package.json" "$(json_version "$f")"
  else
    fail "$label package.json: file not found"
  fi

  f="$scope/VERSION"
  if [[ -f "$f" ]]; then
    check_version "$label VERSION" "$(tr -d '[:space:]' < "$f")"
  else
    fail "$label VERSION: file not found"
  fi
done

# 2. Claude skill and explanation-agent frontmatter in root and mirror
for scope in "$PROJECT_ROOT" "$PROJECT_ROOT/plugins/sentinel"; do
  if [[ "$scope" == "$PROJECT_ROOT" ]]; then
    label="root"
  else
    label="mirror"
  fi
  for rel in skills/run/SKILL.md agents/manifest-generator.md agents/api-sweeper.md agents/browser-sweeper.md; do
    f="$scope/$rel"
    if [[ -f "$f" ]]; then
      v=$(frontmatter_version "$f")
      check_version "$label $rel" "${v:-__missing__}"
    else
      fail "$label $rel: file not found"
    fi
  done
done

# 3. Codex frontmatter has the explicit compatibility suffix
CODEX_EXPECTED="$EXPECTED-codex.1"
for rel in codex/commands/sentinel.md codex/agents/manifest-generator.md codex/agents/api-sweeper.md codex/agents/browser-sweeper.md; do
  f="$PROJECT_ROOT/$rel"
  if [[ ! -f "$f" ]]; then
    fail "$rel: file not found"
    continue
  fi
  v=$(frontmatter_version "$f")
  if [[ "$v" == "$CODEX_EXPECTED" ]]; then
    pass "$rel: $v"
  else
    fail "$rel: expected $CODEX_EXPECTED, got ${v:-__missing__}"
  fi
done

# 4. CHANGELOG.md latest header
f="$PROJECT_ROOT/CHANGELOG.md"
if [[ -f "$f" ]]; then
  v=$(changelog_version "$f")
  check_version "CHANGELOG.md latest header" "${v:-__missing__}"
else
  fail "CHANGELOG.md: file not found"
fi

# 5. Current-release documentation markers (historical entries are intentionally ignored)
for rel in README.md CLAUDE.md; do
  f="$PROJECT_ROOT/$rel"
  if [[ -f "$f" ]] && grep -qF "Sentinel $EXPECTED" "$f"; then
    pass "$rel names current release Sentinel $EXPECTED"
  else
    fail "$rel must name current release Sentinel $EXPECTED"
  fi
done

# 6. The executable CLI reports the same version from root and mirror.
for scope in "$PROJECT_ROOT" "$PROJECT_ROOT/plugins/sentinel"; do
  if [[ "$scope" == "$PROJECT_ROOT" ]]; then
    label="root"
  else
    label="mirror"
  fi
  cli="$scope/runtime/cli.mjs"
  if [[ ! -f "$cli" ]]; then
    fail "$label CLI: runtime/cli.mjs not found"
    continue
  fi
  if actual=$(node "$cli" --version 2>/dev/null); then
    check_version "$label CLI --version" "$actual"
  else
    fail "$label CLI --version failed"
  fi
done

# --- Summary ---
echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Version consistency tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"

exit "$FAIL"
