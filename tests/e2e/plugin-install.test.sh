#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

fail() {
  echo "plugin-install: $1" >&2
  exit 1
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
MIRROR="$ROOT/plugins/sentinel"
CLAUDE_BIN="${SENTINEL_CLAUDE_BIN:-$(command -v claude || true)}"
ORIGINAL_PATH="$PATH"
[[ -n "$CLAUDE_BIN" && -x "$CLAUDE_BIN" ]] || fail "Claude Code is unavailable"
[[ "$($CLAUDE_BIN --version)" == 2.1.214* ]] || fail "Claude Code 2.1.214 is required"
[[ -d "$MIRROR" && ! -L "$MIRROR" ]] || fail "installable plugin mirror is unavailable"

TEMPORARY="$(mktemp -d /tmp/sentinel-plugin-install-XXXXXX)"
cleanup() {
  rm -rf -- "$TEMPORARY"
}
trap cleanup EXIT

MARKETPLACE="$TEMPORARY/marketplace"
HOME_DIR="$TEMPORARY/home"
CLAUDE_DIR="$TEMPORARY/claude config"
UNRELATED="$TEMPORARY/unrelated cwd"
mkdir -p -- "$MARKETPLACE/.claude-plugin" "$MARKETPLACE/plugins" \
  "$HOME_DIR" "$CLAUDE_DIR" "$UNRELATED"
cp -a -- "$ROOT/.claude-plugin/marketplace.json" "$MARKETPLACE/.claude-plugin/marketplace.json"
cp -a -- "$MIRROR" "$MARKETPLACE/plugins/sentinel"

run_claude() {
  env -i \
    HOME="$HOME_DIR" \
    CLAUDE_CONFIG_DIR="$CLAUDE_DIR" \
    PATH="$ORIGINAL_PATH" \
    LC_ALL=C \
    "$CLAUDE_BIN" "$@"
}

run_claude plugin validate --strict "$MARKETPLACE"
run_claude plugin marketplace add --scope user "$MARKETPLACE"
run_claude plugin install --scope user sentinel@sentinel-marketplace
run_claude plugin list --json > "$TEMPORARY/plugins.json"

node - "$TEMPORARY/plugins.json" <<'NODE'
const fs = require('node:fs');
const plugins = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(plugins)
    || !plugins.some((entry) => entry.id === 'sentinel@sentinel-marketplace'
      || entry.name === 'sentinel')) process.exit(1);
NODE

INSTALLED="$(find "$CLAUDE_DIR/plugins/cache/sentinel-marketplace/sentinel" \
  -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -n "$INSTALLED" && -d "$INSTALLED" ]] || fail "installed plugin cache is unavailable"
for COMPONENT in \
  commands/sentinel.md \
  skills/run/SKILL.md \
  agents/api-sweeper.md \
  agents/browser-sweeper.md \
  agents/manifest-generator.md \
  runtime/cli.mjs; do
  [[ -f "$INSTALLED/$COMPONENT" && ! -L "$INSTALLED/$COMPONENT" ]] \
    || fail "installed plugin omitted $COMPONENT"
done

HELP="$(cd "$UNRELATED" && node "$INSTALLED/runtime/cli.mjs" --help)"
[[ "$HELP" == *"sentinel sweep --target"* ]] || fail "installed plugin CLI help is unavailable"
INSTALLED_VERSION="$(cd "$UNRELATED" && node "$INSTALLED/runtime/cli.mjs" --version)"
ROOT_VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
MIRROR_VERSION="$(tr -d '[:space:]' < "$MIRROR/VERSION")"
[[ "$INSTALLED_VERSION" == "$ROOT_VERSION" && "$MIRROR_VERSION" == "$ROOT_VERSION" ]] \
  || fail "installed plugin CLI version is inconsistent"

HOME="$HOME_DIR" bash "$ROOT/codex/install.sh" sentinel-e2e >/dev/null \
  2>"$TEMPORARY/codex-install.stderr" \
  </dev/null
[[ ! -s "$TEMPORARY/codex-install.stderr" ]] || fail "Codex installer wrote stderr"
CODEX_COMMAND="$HOME_DIR/.local/bin/sentinel-e2e"
[[ -L "$CODEX_COMMAND" ]] || fail "Codex command was not installed as a symlink"
"$CODEX_COMMAND" --help >/dev/null
"$CODEX_COMMAND" --version >/dev/null

FAKE_BIN="$TEMPORARY/fake-bin"
CAPTURE="$TEMPORARY/argv.capture"
mkdir -p -- "$FAKE_BIN"
cat > "$FAKE_BIN/node" <<'NODE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1-}" == "--version" ]]; then
  printf '%s\n' 'v18.20.8'
  exit 0
fi
printf '%s\0' "$@" > "$SENTINEL_ARGV_CAPTURE"
exit "${SENTINEL_FAKE_NODE_EXIT:-0}"
NODE
chmod 0700 "$FAKE_BIN/node"

assert_forwarded() {
  local expected_exit="$1"
  shift
  : > "$CAPTURE"
  set +e
  SENTINEL_ARGV_CAPTURE="$CAPTURE" \
    SENTINEL_FAKE_NODE_EXIT="$expected_exit" \
    PATH="$FAKE_BIN:/usr/bin:/bin" \
    "$CODEX_COMMAND" "$@"
  local actual_exit="$?"
  set -e
  [[ "$actual_exit" -eq "$expected_exit" ]] \
    || fail "Codex wrapper changed exit $expected_exit to $actual_exit"
  python3 - "$CAPTURE" "$ROOT/runtime/cli.mjs" "$@" <<'PY'
import pathlib
import sys

actual = pathlib.Path(sys.argv[1]).read_bytes().split(b'\0')
if actual and actual[-1] == b'':
    actual.pop()
expected = [value.encode() for value in sys.argv[2:]]
if actual != expected:
    raise SystemExit(f'argv mismatch: {actual!r} != {expected!r}')
PY
}

assert_forwarded 0
assert_forwarded 1 --help
assert_forwarded 2 "space ערך" ""

echo "plugin-install: PASS"
