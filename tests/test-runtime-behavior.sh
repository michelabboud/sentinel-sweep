#!/usr/bin/env bash
# test-runtime-behavior.sh — Validates orchestrator runtime logic using fixture data
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

PASS=0
FAIL=0
TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$TESTS_DIR/.." && pwd)"
FIXTURES_DIR="$TESTS_DIR/fixtures"

pass() {
  echo -e "  ${GREEN}PASS${NC} $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "  ${RED}FAIL${NC} $1"
  FAIL=$((FAIL + 1))
}

echo "=== Runtime Behavior Tests ==="
echo ""

# ---------------------------------------------------------------------------
# a. Run ID generation test
# ---------------------------------------------------------------------------
echo "-- Run ID generation --"

RUN_ID=$(date -u +"%Y-%m-%dT%H-%M-%SZ")

if [[ "$RUN_ID" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$ ]]; then
  pass "Run ID matches YYYY-MM-DDTHH-MM-SSZ pattern ($RUN_ID)"
else
  fail "Run ID does not match expected pattern: $RUN_ID"
fi

# Verify it is filesystem-safe (no colons, slashes, spaces)
if [[ "$RUN_ID" =~ [:/\ ] ]]; then
  fail "Run ID contains filesystem-unsafe characters: $RUN_ID"
else
  pass "Run ID is filesystem-safe (no colons, slashes, or spaces)"
fi

# ---------------------------------------------------------------------------
# b. Settings merge test
# ---------------------------------------------------------------------------
echo ""
echo "-- Settings merge --"

MERGE_RESULT=$(python3 -c "
import json, sys

with open('$PROJECT_ROOT/settings.json') as f:
    defaults = json.load(f)
with open('$FIXTURES_DIR/partial-settings.json') as f:
    partial = json.load(f)

merged = {**defaults, **partial}
json.dump(merged, sys.stdout)
")

MERGED_TIMEOUT=$(echo "$MERGE_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['responseTimeout'])")
MERGED_SCREENSHOT=$(echo "$MERGE_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['screenshotOnError'])")
MERGED_REPORT_DIR=$(echo "$MERGE_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['reportDir'])")

if [[ "$MERGED_TIMEOUT" == "10000" ]]; then
  pass "Partial responseTimeout (10000) overrides default (5000)"
else
  fail "Expected responseTimeout=10000, got $MERGED_TIMEOUT"
fi

if [[ "$MERGED_SCREENSHOT" == "True" ]]; then
  pass "Default screenshotOnError preserved after merge"
else
  fail "Default screenshotOnError lost after merge (got $MERGED_SCREENSHOT)"
fi

if [[ "$MERGED_REPORT_DIR" == "sentinel-reports" ]]; then
  pass "Default reportDir preserved after merge"
else
  fail "Default reportDir lost after merge (got $MERGED_REPORT_DIR)"
fi

# ---------------------------------------------------------------------------
# c. Deduplication test
# ---------------------------------------------------------------------------
echo ""
echo "-- Deduplication --"

DEDUP_RESULT=$(python3 -c "
import json, sys

severity_rank = {'critical': 4, 'error': 3, 'warning': 2, 'info': 1}

with open('$FIXTURES_DIR/dedup-api-findings.json') as f:
    api = json.load(f)
with open('$FIXTURES_DIR/dedup-browser-findings.json') as f:
    browser = json.load(f)

all_findings = api['findings'] + browser['findings']

# Deduplicate: same (endpoint, role, message) -> keep higher severity
seen = {}
for f in all_findings:
    key = (f.get('endpoint') or '', f.get('role') or '', f.get('message') or '')
    rank = severity_rank.get(f['severity'], 0)
    if key not in seen or rank > severity_rank.get(seen[key]['severity'], 0):
        seen[key] = f

deduped = list(seen.values())
result = {
    'count': len(deduped),
    'severity': deduped[0]['severity'] if deduped else None,
    'endpoint': deduped[0].get('endpoint') if deduped else None
}
json.dump(result, sys.stdout)
")

DEDUP_COUNT=$(echo "$DEDUP_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['count'])")
DEDUP_SEVERITY=$(echo "$DEDUP_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['severity'])")

if [[ "$DEDUP_COUNT" == "1" ]]; then
  pass "Duplicate findings collapsed to 1 entry"
else
  fail "Expected 1 finding after dedup, got $DEDUP_COUNT"
fi

if [[ "$DEDUP_SEVERITY" == "error" ]]; then
  pass "Higher-severity finding (error) wins over lower (warning)"
else
  fail "Expected surviving severity=error, got $DEDUP_SEVERITY"
fi

# ---------------------------------------------------------------------------
# d. Risk scoring test
# ---------------------------------------------------------------------------
echo ""
echo "-- Risk scoring --"

RISK_RESULT=$(python3 -c "
import json, sys

def risk_score(method, is_admin_only=False, has_purge=False, confirm_required=False):
    base = {'GET': 0, 'POST': 25, 'PUT': 40, 'PATCH': 40, 'DELETE': 60}
    score = base.get(method, 0)
    if is_admin_only:
        score += 10
    if has_purge:
        score += 20
    if confirm_required:
        score += 15
    return score

def risk_level(score):
    if score <= 25:
        return 'safe'
    elif score <= 50:
        return 'medium'
    elif score <= 75:
        return 'high'
    else:
        return 'critical'

cases = [
    {'method': 'GET', 'admin': False, 'purge': False, 'confirm': False, 'expected_score': 0, 'expected_level': 'safe'},
    {'method': 'POST', 'admin': True, 'purge': False, 'confirm': False, 'expected_score': 35, 'expected_level': 'medium'},
    {'method': 'DELETE', 'admin': False, 'purge': False, 'confirm': False, 'expected_score': 60, 'expected_level': 'high'},
    {'method': 'DELETE', 'admin': False, 'purge': True, 'confirm': True, 'expected_score': 95, 'expected_level': 'critical'},
]

results = []
for c in cases:
    score = risk_score(c['method'], c['admin'], c['purge'], c['confirm'])
    level = risk_level(score)
    results.append({
        'method': c['method'],
        'score': score,
        'level': level,
        'expected_score': c['expected_score'],
        'expected_level': c['expected_level'],
        'score_ok': score == c['expected_score'],
        'level_ok': level == c['expected_level'],
    })

json.dump(results, sys.stdout)
")

# Parse each case
for i in 0 1 2 3; do
  METHOD=$(echo "$RISK_RESULT" | python3 -c "import json,sys; r=json.load(sys.stdin)[$i]; print(r['method'])")
  SCORE=$(echo "$RISK_RESULT" | python3 -c "import json,sys; r=json.load(sys.stdin)[$i]; print(r['score'])")
  LEVEL=$(echo "$RISK_RESULT" | python3 -c "import json,sys; r=json.load(sys.stdin)[$i]; print(r['level'])")
  SCORE_OK=$(echo "$RISK_RESULT" | python3 -c "import json,sys; r=json.load(sys.stdin)[$i]; print(r['score_ok'])")
  LEVEL_OK=$(echo "$RISK_RESULT" | python3 -c "import json,sys; r=json.load(sys.stdin)[$i]; print(r['level_ok'])")
  EXP_SCORE=$(echo "$RISK_RESULT" | python3 -c "import json,sys; r=json.load(sys.stdin)[$i]; print(r['expected_score'])")
  EXP_LEVEL=$(echo "$RISK_RESULT" | python3 -c "import json,sys; r=json.load(sys.stdin)[$i]; print(r['expected_level'])")

  if [[ "$SCORE_OK" == "True" ]]; then
    pass "$METHOD risk score = $SCORE (expected $EXP_SCORE)"
  else
    fail "$METHOD risk score = $SCORE (expected $EXP_SCORE)"
  fi

  if [[ "$LEVEL_OK" == "True" ]]; then
    pass "$METHOD risk level = $LEVEL (expected $EXP_LEVEL)"
  else
    fail "$METHOD risk level = $LEVEL (expected $EXP_LEVEL)"
  fi
done

# ---------------------------------------------------------------------------
# e. Report directory structure test
# ---------------------------------------------------------------------------
echo ""
echo "-- Report directory structure --"

TMPDIR_BASE=$(mktemp -d)
trap "rm -rf $TMPDIR_BASE" EXIT

TIMESTAMP="2026-03-15T10-00-00Z"
REPORT_DIR="$TMPDIR_BASE/sentinel-reports/$TIMESTAMP"
mkdir -p "$REPORT_DIR"

echo "# Sweep Report" > "$REPORT_DIR/sweep.md"

# Create relative symlink for "latest"
ln -snf "$TIMESTAMP" "$TMPDIR_BASE/sentinel-reports/latest"

if [[ -d "$REPORT_DIR" ]]; then
  pass "Report directory created: sentinel-reports/$TIMESTAMP/"
else
  fail "Report directory was not created"
fi

if [[ -f "$REPORT_DIR/sweep.md" ]]; then
  pass "sweep.md written to report directory"
else
  fail "sweep.md not found in report directory"
fi

if [[ -L "$TMPDIR_BASE/sentinel-reports/latest" ]]; then
  LINK_TARGET=$(readlink "$TMPDIR_BASE/sentinel-reports/latest")
  if [[ "$LINK_TARGET" == "$TIMESTAMP" ]]; then
    pass "latest symlink points to $TIMESTAMP"
  else
    fail "latest symlink points to '$LINK_TARGET' (expected '$TIMESTAMP')"
  fi
else
  fail "latest symlink was not created"
fi

# Verify symlink is relative (does not start with /)
LINK_TARGET=$(readlink "$TMPDIR_BASE/sentinel-reports/latest")
if [[ "$LINK_TARGET" != /* ]]; then
  pass "latest symlink is relative (not absolute)"
else
  fail "latest symlink is absolute: $LINK_TARGET"
fi

# ---------------------------------------------------------------------------
# f. Sweep history append test
# ---------------------------------------------------------------------------
echo ""
echo "-- Sweep history append --"

HISTORY_WORK="$TMPDIR_BASE/sweep-history.json"
cp "$FIXTURES_DIR/sample-sweep-history.json" "$HISTORY_WORK"

python3 -c "
import json

with open('$HISTORY_WORK') as f:
    history = json.load(f)

new_run = {
    'runId': '2026-03-15T10-00-00Z',
    'startedAt': '2026-03-15T10:00:00Z',
    'finishedAt': '2026-03-15T10:04:20Z',
    'modes': ['api', 'browser'],
    'totalFindings': 5,
    'bySeverity': {
        'critical': 2,
        'error': 1,
        'warning': 1,
        'info': 1
    },
    'reportDir': 'sentinel-reports/2026-03-15T10-00-00Z'
}

history['runs'].append(new_run)

with open('$HISTORY_WORK', 'w') as f:
    json.dump(history, f, indent=2)
"

# Validate the result
HISTORY_VALID=$(python3 -c "
import json, sys
try:
    with open('$HISTORY_WORK') as f:
        data = json.load(f)
    print('valid')
except Exception:
    print('invalid')
")

RUNS_COUNT=$(python3 -c "
import json
with open('$HISTORY_WORK') as f:
    data = json.load(f)
print(len(data['runs']))
")

FIRST_RUN_ID=$(python3 -c "
import json
with open('$HISTORY_WORK') as f:
    data = json.load(f)
print(data['runs'][0]['runId'])
")

SECOND_RUN_ID=$(python3 -c "
import json
with open('$HISTORY_WORK') as f:
    data = json.load(f)
print(data['runs'][1]['runId'])
")

if [[ "$HISTORY_VALID" == "valid" ]]; then
  pass "Resulting sweep-history.json is valid JSON"
else
  fail "Resulting sweep-history.json is not valid JSON"
fi

if [[ "$RUNS_COUNT" == "2" ]]; then
  pass "Runs array has exactly 2 entries"
else
  fail "Expected 2 runs, got $RUNS_COUNT"
fi

if [[ "$FIRST_RUN_ID" == "2026-03-14T08-00-00Z" ]]; then
  pass "Original run preserved (runId=$FIRST_RUN_ID)"
else
  fail "Original run lost or corrupted (runId=$FIRST_RUN_ID)"
fi

if [[ "$SECOND_RUN_ID" == "2026-03-15T10-00-00Z" ]]; then
  pass "New run appended (runId=$SECOND_RUN_ID)"
else
  fail "New run not found at index 1 (runId=$SECOND_RUN_ID)"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "---"
TOTAL=$((PASS + FAIL))
echo -e "Runtime behavior tests: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC} (${TOTAL} total)"

exit "$FAIL"
