#!/usr/bin/env bash
# test-feature-coverage.sh — Validates that v1.7+ features are properly declared
# in SKILL.md, agent files, README, and schemas
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

echo "=== Feature Coverage Tests (v1.7+) ==="
echo ""

SKILL="$PROJECT_ROOT/skills/run/SKILL.md"
MANIFEST_GEN="$PROJECT_ROOT/agents/manifest-generator.md"
API_SWEEPER="$PROJECT_ROOT/agents/api-sweeper.md"
BROWSER_SWEEPER="$PROJECT_ROOT/agents/browser-sweeper.md"
README="$PROJECT_ROOT/README.md"
FINDINGS_SCHEMA="$PROJECT_ROOT/schemas/findings.schema.json"
MANIFEST_SCHEMA="$PROJECT_ROOT/schemas/sentinel-manifest.schema.json"
SETTINGS_SCHEMA="$PROJECT_ROOT/schemas/settings.schema.json"
HISTORY_SCHEMA="$PROJECT_ROOT/schemas/sweep-history.schema.json"

# -- Subcommand declarations in SKILL.md --
echo "-- New subcommands in SKILL.md --"

SUBCOMMANDS=("export" "config" "serve" "pr")
for cmd in "${SUBCOMMANDS[@]}"; do
  if grep -q "Subcommand: \`$cmd\`" "$SKILL"; then
    pass "Subcommand '$cmd' declared in SKILL.md"
  else
    fail "Subcommand '$cmd' missing from SKILL.md"
  fi
done

# -- Flag declarations in SKILL.md --
echo ""
echo "-- New flags in SKILL.md --"

FLAGS=("ci" "changed-only" "dashboard" "format" "verify" "visual-regression" "port")
for flag in "${FLAGS[@]}"; do
  if grep -qF -- "--$flag" "$SKILL"; then
    pass "Flag '--$flag' referenced in SKILL.md"
  else
    fail "Flag '--$flag' missing from SKILL.md"
  fi
done

# -- Health score dashboard in SKILL.md --
echo ""
echo "-- Health score dashboard --"

if grep -q "Health Score\|healthScore\|healthGrade\|categoryScores" "$SKILL"; then
  pass "Health score computation defined in SKILL.md"
else
  fail "Health score computation missing from SKILL.md"
fi

if grep -q "healthScore" "$HISTORY_SCHEMA"; then
  pass "healthScore field in sweep-history.schema.json"
else
  fail "healthScore field missing from sweep-history.schema.json"
fi

# -- CI mode in SKILL.md --
echo ""
echo "-- CI mode --"

if grep -q "ciMode" "$SKILL"; then
  pass "ciMode variable defined in SKILL.md"
else
  fail "ciMode variable missing from SKILL.md"
fi

if grep -q "exitCode\|exit code" "$SKILL"; then
  pass "Exit code logic defined for CI mode"
else
  fail "Exit code logic missing from CI mode"
fi

# -- Incremental sweep --
echo ""
echo "-- Incremental sweep (--changed-only) --"

if grep -q "changedOnly\|changed-only\|git diff" "$SKILL"; then
  pass "Changed-only logic defined in SKILL.md"
else
  fail "Changed-only logic missing from SKILL.md"
fi

if grep -q "commitSha" "$HISTORY_SCHEMA"; then
  pass "commitSha field in sweep-history.schema.json"
else
  fail "commitSha field missing from sweep-history.schema.json"
fi

# -- Visual regression in browser-sweeper --
echo ""
echo "-- Visual regression --"

if grep -q "Visual Regression\|pixel.diff\|diffPercent" "$BROWSER_SWEEPER"; then
  pass "Visual regression section in browser-sweeper.md"
else
  fail "Visual regression section missing from browser-sweeper.md"
fi

if grep -q '"visual"' "$FINDINGS_SCHEMA"; then
  pass "visual category in findings.schema.json"
else
  fail "visual category missing from findings.schema.json"
fi

# -- Security headers in api-sweeper --
echo ""
echo "-- Security headers audit --"

if grep -q "Security Headers\|HSTS\|Content-Security-Policy\|X-Content-Type-Options" "$API_SWEEPER"; then
  pass "Security headers audit in api-sweeper.md"
else
  fail "Security headers audit missing from api-sweeper.md"
fi

# -- Response time percentiles in api-sweeper --
echo ""
echo "-- Response time percentiles --"

if grep -q "responseTimePercentiles\|p50.*p95.*p99\|percentile" "$API_SWEEPER"; then
  pass "Response time percentiles in api-sweeper.md"
else
  fail "Response time percentiles missing from api-sweeper.md"
fi

if grep -q "responseTimePercentiles" "$FINDINGS_SCHEMA"; then
  pass "responseTimePercentiles in findings.schema.json metadata"
else
  fail "responseTimePercentiles missing from findings.schema.json"
fi

# -- Cross-cutting analyzers in manifest-generator --
echo ""
echo "-- Cross-cutting analyzers in manifest-generator --"

declare -A ANALYZERS=(
  ["6.5 i18n"]="Section 6.5"
  ["6.6 a11y"]="Section 6.6"
  ["6.7 Dead Endpoint"]="Section 6.7"
  ["6.8 WebSocket"]="Section 6.8"
  ["6.9 Versioning"]="Section 6.9"
  ["6.10 Migration"]="Section 6.10"
  ["6.11 Rate Limiting"]="Section 6.11"
  ["6.12 CSS/Tailwind"]="Section 6.12"
  ["6.13 N+1"]="Section 6.13"
  ["6.14 Vulnerability"]="Section 6.14"
)

for label in "${!ANALYZERS[@]}"; do
  pattern="${ANALYZERS[$label]}"
  if grep -qF "$pattern" "$MANIFEST_GEN"; then
    pass "Analyzer: $label"
  else
    fail "Analyzer missing: $label"
  fi
done

# -- Schema fields for cross-cutting analysis --
echo ""
echo "-- Cross-cutting fields in manifest schema --"

SCHEMA_FIELDS=("i18n" "a11y" "deadCode" "deadCss" "n1Queries" "vulnerabilities" "apiVersioning" "migrationDrift" "rateLimiting")
for field in "${SCHEMA_FIELDS[@]}"; do
  if grep -q "\"$field\"" "$MANIFEST_SCHEMA"; then
    pass "Field '$field' in sentinel-manifest.schema.json"
  else
    fail "Field '$field' missing from sentinel-manifest.schema.json"
  fi
done

# -- Multi-service support --
echo ""
echo "-- Multi-service support --"

if grep -q '"service"' "$FINDINGS_SCHEMA"; then
  pass "service field in findings.schema.json"
else
  fail "service field missing from findings.schema.json"
fi

if grep -q '"services"' "$SETTINGS_SCHEMA"; then
  pass "services array in settings.schema.json"
else
  fail "services array missing from settings.schema.json"
fi

if grep -q '"services"' "$MANIFEST_SCHEMA"; then
  pass "services array in sentinel-manifest.schema.json"
else
  fail "services array missing from sentinel-manifest.schema.json"
fi

# -- Framework enum completeness --
echo ""
echo "-- Framework enums in manifest schema --"

FRONTEND_ENUMS=("vue" "nuxt" "nextjs" "react" "sveltekit" "angular" "remix")
for fw in "${FRONTEND_ENUMS[@]}"; do
  if grep -q "\"$fw\"" "$MANIFEST_SCHEMA"; then
    pass "Frontend enum: $fw"
  else
    fail "Frontend enum missing: $fw"
  fi
done

BACKEND_SAMPLE=("fastapi" "express" "django" "nestjs" "flask" "hono" "koa" "actix" "axum" "rocket" "gin" "echo" "chi" "laravel" "graphql" "grpc" "trpc")
for fw in "${BACKEND_SAMPLE[@]}"; do
  if grep -q "\"$fw\"" "$MANIFEST_SCHEMA"; then
    pass "Backend enum: $fw"
  else
    fail "Backend enum missing: $fw"
  fi
done

# -- Auth method enums --
echo ""
echo "-- Auth method enums --"

AUTH_METHODS=("jwt" "nextauth" "session" "apikey" "oauth_pkce")
for method in "${AUTH_METHODS[@]}"; do
  if grep -q "\"$method\"" "$MANIFEST_SCHEMA"; then
    pass "Auth method enum: $method"
  else
    fail "Auth method enum missing: $method"
  fi
done

# -- Endpoint protocol and sweepable fields --
echo ""
echo "-- Endpoint extensions --"

if grep -q '"protocol"' "$MANIFEST_SCHEMA"; then
  pass "protocol field (websocket) in endpoint schema"
else
  fail "protocol field missing from endpoint schema"
fi

if grep -q '"sweepable"' "$MANIFEST_SCHEMA"; then
  pass "sweepable field in endpoint schema"
else
  fail "sweepable field missing from endpoint schema"
fi

# -- README coverage --
echo ""
echo "-- README feature coverage --"

declare -A README_FEATURES=(
  ["Health score"]="Health score"
  ["CI/CD mode"]="CI/CD mode"
  ["Incremental sweep"]="Incremental sweep"
  ["Visual diff"]="Visual diff"
  ["Auto-fix"]="Auto-fix"
  ["Collection export"]="Collection export"
  ["Interactive config"]="Interactive config"
  ["Parallel manifest"]="Parallel manifest"
  ["Live dashboard"]="Live dashboard"
  ["GitHub PR"]="GitHub PR"
  ["Visual regression"]="Visual regression"
  ["N+1 query"]="N+1 query"
  ["Vulnerability scanning"]="vulnerability scanning"
  ["Response time"]="Response time"
)

for label in "${!README_FEATURES[@]}"; do
  search="${README_FEATURES[$label]}"
  if grep -qiF "$search" "$README"; then
    pass "README mentions: $label"
  else
    fail "README missing: $label"
  fi
done

# -- Codex port version sync --
echo ""
echo "-- Codex port version sync --"

ROOT_VERSION=$(tr -d '[:space:]' < "$PROJECT_ROOT/VERSION")
CODEX_FILES=(
  "codex/agents/manifest-generator.md"
  "codex/agents/api-sweeper.md"
  "codex/agents/browser-sweeper.md"
  "codex/commands/sentinel.md"
)

for f in "${CODEX_FILES[@]}"; do
  filepath="$PROJECT_ROOT/$f"
  if [[ -f "$filepath" ]]; then
    codex_ver=$(grep "^version:" "$filepath" | sed 's/version: //' | sed 's/-codex.*//')
    if [[ "$codex_ver" == "$ROOT_VERSION" ]]; then
      pass "Codex $f matches root version ($ROOT_VERSION)"
    else
      fail "Codex $f version mismatch: $codex_ver vs root $ROOT_VERSION"
    fi
  else
    fail "Codex file missing: $f"
  fi
done

# --- Summary ---
echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Feature coverage tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"
echo ""

exit "$FAIL"
