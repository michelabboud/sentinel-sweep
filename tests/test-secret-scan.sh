#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCANNER="$ROOT/tests/test-secret-scan.sh"
FAIL=0

SECRET_PATTERNS=(
  '-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----'
  '(AKIA|ASIA)[0-9A-Z]{16}'
  'gh[pousr]_[A-Za-z0-9]{36,255}'
  'github_pat_[A-Za-z0-9_]{82,255}'
  'xox[baprs]-[A-Za-z0-9-]{20,255}'
  'AIza[0-9A-Za-z_-]{35}'
  'sk_(live|test)_[0-9A-Za-z]{20,255}'
  'sk-(proj-)?[A-Za-z0-9_-]{24,255}'
  'sk-ant-[A-Za-z0-9_-]{24,255}'
  'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'
  "(?i)(api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key|password)[[:space:]]*[:=][[:space:]]*[\"'][A-Za-z0-9+/_=-]{24,}[\"']"
  '(?i)authorization[[:space:]]*:[[:space:]]*bearer[[:space:]]+[A-Za-z0-9+/_=-]{24,}'
)
CANARY_PATTERN='target-env-canary-must-never-appear|target-file-must-never-authorize|blocked-filename-canary-must-never-appear'

SELF_TEST_DIR="$(mktemp -d /tmp/sentinel-secret-scan-XXXXXX)"
cleanup() {
  rm -rf -- "$SELF_TEST_DIR"
}
trap cleanup EXIT

SELF_TEST_VALUES=(
  '-----BEGIN PRIVATE KEY-----'
  "AKIA$(printf 'A%.0s' {1..16})"
  "ghp_$(printf 'A%.0s' {1..36})"
  "github_pat_$(printf 'A%.0s' {1..82})"
  "xoxb-$(printf 'A%.0s' {1..20})"
  "AIza$(printf 'A%.0s' {1..35})"
  "sk_live_$(printf 'A%.0s' {1..20})"
  "sk-proj-$(printf 'A%.0s' {1..24})"
  "sk-ant-$(printf 'A%.0s' {1..24})"
  'eyJabcdefghij.abcdefghijk.abcdefghijk'
  'api_key="ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"'
  'Authorization: Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'
)

for index in "${!SECRET_PATTERNS[@]}"; do
  self_test_file="$SELF_TEST_DIR/pattern-$index.txt"
  printf '%s\n' "${SELF_TEST_VALUES[$index]}" > "$self_test_file"
  if ! rg --quiet --no-messages --regexp "${SECRET_PATTERNS[$index]}" -- "$self_test_file"; then
    echo "secret scan self-test failed for pattern family $index" >&2
    exit 1
  fi
done

scan_file() {
  local file="$1"
  local relative="${file#"$ROOT"/}"
  case "$relative" in
    plugins/sentinel/*|tests/test-secret-scan.sh)
      return
      ;;
  esac

  local args=()
  local pattern
  for pattern in "${SECRET_PATTERNS[@]}"; do args+=(--regexp "$pattern"); done
  if rg --line-number --with-filename --no-messages "${args[@]}" -- "$file"; then
    FAIL=1
  else
    local status=$?
    [[ "$status" -eq 1 ]] || exit "$status"
  fi
}

while IFS= read -r -d '' file; do
  scan_file "$file"
done < <(find "$ROOT" -type f \
  -not -path "$ROOT/.git/*" \
  -not -path "$ROOT/node_modules/*" \
  -print0)

while IFS= read -r -d '' file; do
  [[ "$file" == "$SCANNER" ]] && continue
  relative="${file#"$ROOT"/}"
  if rg --quiet --no-messages --regexp "$CANARY_PATTERN" -- "$file"; then
    case "$relative" in
      tests/e2e/goal-sweep.test.mjs|tests/fixtures/goal-app/adversarial/.env|tests/fixtures/goal-app/adversarial/id_rsa)
        ;;
      *)
        echo "unexpected canary copy: $relative" >&2
        FAIL=1
        ;;
    esac
  fi
done < <(find "$ROOT" -type f \
  -not -path "$ROOT/.git/*" \
  -not -path "$ROOT/node_modules/*" \
  -not -path "$ROOT/plugins/sentinel/*" \
  -print0)

if [[ "$FAIL" -ne 0 ]]; then
  echo "secret scan: FAIL" >&2
  exit 1
fi
echo "secret scan: PASS"
