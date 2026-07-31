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

# --- Required canonical root files ---
echo "-- Required root files --"

REQUIRED_ROOT_FILES=(
  "VERSION"
  "package.json"
  "LICENSE"
  "README.md"
  "SECURITY.md"
  "CONTRIBUTING.md"
  "CHANGELOG.md"
  "CLAUDE.md"
  "ARCHITECTURE.md"
  "PROGRESS.md"
  "settings.json"
  ".claude-plugin/plugin.json"
  ".claude-plugin/marketplace.json"
  "commands/sentinel.md"
  "skills/run/SKILL.md"
  "agents/manifest-generator.md"
  "agents/api-sweeper.md"
  "agents/browser-sweeper.md"
  "runtime/cli.mjs"
  "runtime/api/http.mjs"
  "runtime/api/schema-check.mjs"
  "runtime/api/sweep.mjs"
  "runtime/browser/cdp.mjs"
  "runtime/browser/chrome.mjs"
  "runtime/browser/sweep.mjs"
  "runtime/browser/websocket.mjs"
  "runtime/discovery/index.mjs"
  "runtime/discovery/openapi.mjs"
  "runtime/discovery/vue-router.mjs"
  "runtime/policy/execution.mjs"
  "runtime/export.mjs"
  "runtime/findings.mjs"
  "runtime/history.mjs"
  "runtime/report.mjs"
  "runtime/lib/config.mjs"
  "runtime/lib/errors.mjs"
  "runtime/lib/findings-contract.mjs"
  "runtime/lib/fs-boundary.mjs"
  "runtime/lib/identity.mjs"
  "runtime/lib/json-snapshot.mjs"
  "runtime/lib/origin.mjs"
  "runtime/lib/output-boundary.mjs"
  "runtime/lib/schema.mjs"
  "runtime/lib/secrets.mjs"
  "schemas/settings.schema.json"
  "schemas/sentinel-manifest.schema.json"
  "schemas/findings.schema.json"
  "schemas/sweep-history.schema.json"
)

for f in "${REQUIRED_ROOT_FILES[@]}"; do
  if [[ -f "$PROJECT_ROOT/$f" && ! -L "$PROJECT_ROOT/$f" ]]; then
    pass "$f exists as a regular file"
  else
    fail "$f is missing or is a symlink"
  fi
done

# --- Required Codex delivery assets ---
echo ""
echo "-- Required Codex assets --"

REQUIRED_CODEX_FILES=(
  "codex/CODEX.md"
  "codex/README.md"
  "codex/commands/sentinel.md"
  "codex/agents/manifest-generator.md"
  "codex/agents/api-sweeper.md"
  "codex/agents/browser-sweeper.md"
  "codex/bin/sentinel-codex.sh"
  "codex/bin/sentinel_codex.py"
  "codex/config.example.json"
  "codex/install.sh"
  "codex/uninstall.sh"
)

for f in "${REQUIRED_CODEX_FILES[@]}"; do
  if [[ -f "$PROJECT_ROOT/$f" && ! -L "$PROJECT_ROOT/$f" ]]; then
    pass "$f exists as a regular file"
  else
    fail "$f is missing or is a symlink"
  fi
done

echo ""
echo "-- Obsolete Codex assets stay removed --"

OBSOLETE_CODEX_FILES=(
  "codex/bin/dispatch-example.md"
  "codex/bin/print-latest-briefs.sh"
  "codex/settings.local.json"
)

for f in "${OBSOLETE_CODEX_FILES[@]}"; do
  if [[ ! -e "$PROJECT_ROOT/$f" && ! -L "$PROJECT_ROOT/$f" ]]; then
    pass "$f is absent"
  else
    fail "$f is obsolete and must remain absent"
  fi
done

# --- Plugin mirror files ---
echo ""
echo "-- Plugin mirror directory (plugins/sentinel/) --"

REQUIRED_MIRROR_FILES=(
  "plugins/sentinel/VERSION"
  "plugins/sentinel/package.json"
  "plugins/sentinel/settings.json"
  "plugins/sentinel/LICENSE"
  "plugins/sentinel/README.md"
  "plugins/sentinel/SECURITY.md"
  "plugins/sentinel/CONTRIBUTING.md"
  "plugins/sentinel/CHANGELOG.md"
  "plugins/sentinel/CLAUDE.md"
  "plugins/sentinel/ARCHITECTURE.md"
  "plugins/sentinel/.claude-plugin/plugin.json"
  "plugins/sentinel/.claude-plugin/marketplace.json"
  "plugins/sentinel/commands/sentinel.md"
  "plugins/sentinel/skills/run/SKILL.md"
  "plugins/sentinel/agents/manifest-generator.md"
  "plugins/sentinel/agents/api-sweeper.md"
  "plugins/sentinel/agents/browser-sweeper.md"
  "plugins/sentinel/runtime/cli.mjs"
  "plugins/sentinel/runtime/api/http.mjs"
  "plugins/sentinel/runtime/api/schema-check.mjs"
  "plugins/sentinel/runtime/api/sweep.mjs"
  "plugins/sentinel/runtime/browser/cdp.mjs"
  "plugins/sentinel/runtime/browser/chrome.mjs"
  "plugins/sentinel/runtime/browser/sweep.mjs"
  "plugins/sentinel/runtime/browser/websocket.mjs"
  "plugins/sentinel/runtime/discovery/index.mjs"
  "plugins/sentinel/runtime/discovery/openapi.mjs"
  "plugins/sentinel/runtime/discovery/vue-router.mjs"
  "plugins/sentinel/runtime/policy/execution.mjs"
  "plugins/sentinel/runtime/export.mjs"
  "plugins/sentinel/runtime/findings.mjs"
  "plugins/sentinel/runtime/history.mjs"
  "plugins/sentinel/runtime/report.mjs"
  "plugins/sentinel/runtime/lib/config.mjs"
  "plugins/sentinel/runtime/lib/errors.mjs"
  "plugins/sentinel/runtime/lib/findings-contract.mjs"
  "plugins/sentinel/runtime/lib/fs-boundary.mjs"
  "plugins/sentinel/runtime/lib/identity.mjs"
  "plugins/sentinel/runtime/lib/json-snapshot.mjs"
  "plugins/sentinel/runtime/lib/origin.mjs"
  "plugins/sentinel/runtime/lib/output-boundary.mjs"
  "plugins/sentinel/runtime/lib/schema.mjs"
  "plugins/sentinel/runtime/lib/secrets.mjs"
  "plugins/sentinel/schemas/settings.schema.json"
  "plugins/sentinel/schemas/sentinel-manifest.schema.json"
  "plugins/sentinel/schemas/findings.schema.json"
  "plugins/sentinel/schemas/sweep-history.schema.json"
)

for f in "${REQUIRED_MIRROR_FILES[@]}"; do
  if [[ -f "$PROJECT_ROOT/$f" && ! -L "$PROJECT_ROOT/$f" ]]; then
    pass "mirror: $f exists as a regular file"
  else
    fail "mirror: $f is missing or is a symlink"
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
