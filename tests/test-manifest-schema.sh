#!/usr/bin/env bash
# test-manifest-schema.sh — Validates findings JSON fixtures against the schema contract
# documented in Section 5 of the orchestrator skill (skills/run/SKILL.md)
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES_DIR="$PROJECT_ROOT/tests/fixtures"

pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  FAIL=$((FAIL + 1))
}

# Validate a JSON file is parseable
check_valid_json() {
  local file="$1"
  local label="$2"
  if python3 -c "import json; json.load(open('$file'))" 2>/dev/null; then
    pass "$label: valid JSON"
    return 0
  else
    fail "$label: invalid JSON — file cannot be parsed"
    return 1
  fi
}

# Check that a metadata field exists using python3
check_metadata_field() {
  local file="$1"
  local field="$2"
  local label="$3"
  local result
  result=$(python3 -c "
import json
data = json.load(open('$file'))
md = data.get('metadata', {})
if '$field' in md:
    print('exists')
else:
    print('missing')
" 2>/dev/null || echo "error")
  if [[ "$result" == "exists" ]]; then
    pass "$label"
    return 0
  else
    fail "$label"
    return 1
  fi
}

# Check that a metadata field has a specific value
check_metadata_value() {
  local file="$1"
  local field="$2"
  local expected="$3"
  local label="$4"
  local result
  result=$(python3 -c "
import json
data = json.load(open('$file'))
md = data.get('metadata', {})
val = md.get('$field', '__missing__')
print(str(val))
" 2>/dev/null || echo "__error__")
  if [[ "$result" == "$expected" ]]; then
    pass "$label"
  else
    fail "$label (expected '$expected', got '$result')"
  fi
}

# Validate all findings in a file have required fields and valid values
validate_findings() {
  local file="$1"
  local label="$2"

  local result
  result=$(python3 - "$file" "$label" << 'PYEOF'
import json, sys

file_path = sys.argv[1]
label = sys.argv[2]

data = json.load(open(file_path))
findings = data.get('findings', [])

if len(findings) == 0:
    print("FAIL:" + label + ": findings array is empty")
    sys.exit(0)

print("PASS:" + label + ": findings array has " + str(len(findings)) + " entries")

valid_severities = {'critical', 'error', 'warning', 'info'}
valid_categories = {'health', 'rbac', 'crud', 'schema', 'security', 'console', 'layout', 'i18n', 'network'}
required_nullable_fields = ['endpoint', 'route', 'role', 'expected', 'actual', 'fileRef', 'fixSuggestion', 'breakpoint', 'screenshot']

all_ok = True
for i, f in enumerate(findings):
    prefix = 'finding[' + str(i) + ']'

    sev = f.get('severity')
    if sev is None:
        print("FAIL:" + label + ": " + prefix + ": missing severity")
        all_ok = False
    elif sev not in valid_severities:
        print("FAIL:" + label + ": " + prefix + ": invalid severity \"" + str(sev) + "\"")
        all_ok = False

    cat = f.get('category')
    if cat is None:
        print("FAIL:" + label + ": " + prefix + ": missing category")
        all_ok = False
    elif cat not in valid_categories:
        print("FAIL:" + label + ": " + prefix + ": invalid category \"" + str(cat) + "\"")
        all_ok = False

    msg = f.get('message')
    if msg is None:
        print("FAIL:" + label + ": " + prefix + ": missing message")
        all_ok = False

    for field in required_nullable_fields:
        if field not in f:
            print("FAIL:" + label + ": " + prefix + ": missing field \"" + field + "\"")
            all_ok = False

if all_ok:
    print("PASS:" + label + ": all findings have required fields with valid values")
PYEOF
)

  while IFS= read -r line; do
    if [[ "$line" == PASS:* ]]; then
      pass "${line#PASS:}"
    elif [[ "$line" == FAIL:* ]]; then
      fail "${line#FAIL:}"
    fi
  done <<< "$result"
}

echo "=== Findings JSON Schema Tests ==="
echo ""

# --- API findings fixture ---
API_FIXTURE="$FIXTURES_DIR/sample-api-findings.json"
echo "-- API findings fixture: $(basename "$API_FIXTURE") --"

if [[ ! -f "$API_FIXTURE" ]]; then
  fail "API fixture file not found: $API_FIXTURE"
else
  if check_valid_json "$API_FIXTURE" "api-findings"; then
    check_metadata_field "$API_FIXTURE" "mode" "api-findings: metadata.mode exists"
    check_metadata_value "$API_FIXTURE" "mode" "api" "api-findings: metadata.mode is 'api'"
    check_metadata_field "$API_FIXTURE" "rolesTested" "api-findings: metadata.rolesTested exists"
    check_metadata_field "$API_FIXTURE" "endpointsTested" "api-findings: metadata.endpointsTested exists"
    check_metadata_field "$API_FIXTURE" "routesTested" "api-findings: metadata.routesTested exists"
    check_metadata_field "$API_FIXTURE" "startedAt" "api-findings: metadata.startedAt exists"
    check_metadata_field "$API_FIXTURE" "finishedAt" "api-findings: metadata.finishedAt exists"
    validate_findings "$API_FIXTURE" "api-findings"
  fi
fi

echo ""

# --- Browser findings fixture ---
BROWSER_FIXTURE="$FIXTURES_DIR/sample-browser-findings.json"
echo "-- Browser findings fixture: $(basename "$BROWSER_FIXTURE") --"

if [[ ! -f "$BROWSER_FIXTURE" ]]; then
  fail "Browser fixture file not found: $BROWSER_FIXTURE"
else
  if check_valid_json "$BROWSER_FIXTURE" "browser-findings"; then
    check_metadata_field "$BROWSER_FIXTURE" "mode" "browser-findings: metadata.mode exists"
    check_metadata_value "$BROWSER_FIXTURE" "mode" "browser" "browser-findings: metadata.mode is 'browser'"
    check_metadata_field "$BROWSER_FIXTURE" "rolesTested" "browser-findings: metadata.rolesTested exists"
    check_metadata_field "$BROWSER_FIXTURE" "endpointsTested" "browser-findings: metadata.endpointsTested exists"
    check_metadata_field "$BROWSER_FIXTURE" "routesTested" "browser-findings: metadata.routesTested exists"
    check_metadata_field "$BROWSER_FIXTURE" "startedAt" "browser-findings: metadata.startedAt exists"
    check_metadata_field "$BROWSER_FIXTURE" "finishedAt" "browser-findings: metadata.finishedAt exists"
    validate_findings "$BROWSER_FIXTURE" "browser-findings"
  fi
fi

# --- Summary ---
echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Schema tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"

exit "$FAIL"
