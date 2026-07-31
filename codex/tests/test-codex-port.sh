#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
SHELL_RUNNER="$ROOT/codex/bin/sentinel-codex.sh"
PYTHON_RUNNER="$ROOT/codex/bin/sentinel_codex.py"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sentinel-codex-port.XXXXXXXX")"
trap 'rm -rf -- "$TMP_DIR"' EXIT

[[ -x "$SHELL_RUNNER" ]] || { echo "shell runner is not executable" >&2; exit 1; }
[[ -x "$PYTHON_RUNNER" ]] || { echo "python runner is not executable" >&2; exit 1; }
ln -s "$SHELL_RUNNER" "$TMP_DIR/sentinel"
SHELL_ENTRY="$TMP_DIR/sentinel"

EXPECTED_VERSION="$(tr -d '\r\n' < "$ROOT/VERSION")"
[[ "$($SHELL_ENTRY --version)" == "$EXPECTED_VERSION" ]]
[[ "$($PYTHON_RUNNER --version)" == "$EXPECTED_VERSION" ]]

if "$SHELL_ENTRY" >"$TMP_DIR/no-command.out" 2>"$TMP_DIR/no-command.err"; then
  echo "shell runner accepted an empty invocation" >&2
  exit 1
fi
[[ ! -s "$TMP_DIR/no-command.out" ]]
grep -q '^Error \[CLI_COMMAND_REQUIRED\]:' "$TMP_DIR/no-command.err"

mkdir -p "$TMP_DIR/fake-bin"
cat >"$TMP_DIR/fake-bin/node" <<'FAKE_NODE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--version" ]]; then
  printf 'v18.20.8\n'
  exit 0
fi
printf '%s\0' "$@" >"$SENTINEL_CAPTURE"
exit "${SENTINEL_FAKE_EXIT:-0}"
FAKE_NODE
chmod 0755 "$TMP_DIR/fake-bin/node"

SHELL_CAPTURE="$TMP_DIR/shell.args"
set +e
PATH="$TMP_DIR/fake-bin:$PATH" \
  SENTINEL_CAPTURE="$SHELL_CAPTURE" \
  SENTINEL_FAKE_EXIT=2 \
  "$SHELL_ENTRY" setup --target "space path/פרויקט" --config "" --json
SHELL_STATUS=$?
set -e
[[ "$SHELL_STATUS" -eq 2 ]]

PYTHON_CAPTURE="$TMP_DIR/python.args"
set +e
PATH="$TMP_DIR/fake-bin:$PATH" \
  SENTINEL_CAPTURE="$PYTHON_CAPTURE" \
  SENTINEL_FAKE_EXIT=2 \
  "$PYTHON_RUNNER" setup --target "space path/פרויקט" --config "" --json
PYTHON_STATUS=$?
set -e
[[ "$PYTHON_STATUS" -eq 2 ]]

python3 - "$ROOT" "$SHELL_CAPTURE" "$PYTHON_CAPTURE" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
expected = [
    str(root / "runtime" / "cli.mjs"),
    "setup",
    "--target",
    "space path/פרויקט",
    "--config",
    "",
    "--json",
]
for capture_path in sys.argv[2:]:
    raw = Path(capture_path).read_bytes()
    actual = [part.decode("utf-8") for part in raw.split(b"\0")[:-1]]
    if actual != expected:
        raise SystemExit(f"argument mismatch: {actual!r}")
PY

mkdir -p "$TMP_DIR/old-bin"
cat >"$TMP_DIR/old-bin/node" <<'OLD_NODE'
#!/usr/bin/env bash
printf 'v17.9.1\n'
exit 0
OLD_NODE
chmod 0755 "$TMP_DIR/old-bin/node"

if PATH="$TMP_DIR/old-bin:$PATH" "$PYTHON_RUNNER" --version \
    >"$TMP_DIR/old.out" 2>"$TMP_DIR/old.err"; then
  echo "python runner accepted Node 17" >&2
  exit 1
fi
[[ ! -s "$TMP_DIR/old.out" ]]
grep -q 'Node.js 18 or newer is required' "$TMP_DIR/old.err"

mkdir -p "$TMP_DIR/racy-bin"
cat >"$TMP_DIR/racy-bin/node" <<'RACY_NODE'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  chmod 0644 "$0"
  printf 'v18.20.8\n'
  exit 0
fi
exit 0
RACY_NODE
chmod 0755 "$TMP_DIR/racy-bin/node"

if PATH="$TMP_DIR/racy-bin:$PATH" "$PYTHON_RUNNER" --version \
    >"$TMP_DIR/racy.out" 2>"$TMP_DIR/racy.err"; then
  echo "python runner hid an exec failure" >&2
  exit 1
fi
[[ ! -s "$TMP_DIR/racy.out" ]]
grep -q '^sentinel: could not execute Node.js$' "$TMP_DIR/racy.err"
if grep -q 'Traceback' "$TMP_DIR/racy.err"; then
  echo "python runner leaked a traceback" >&2
  exit 1
fi

echo "codex compatibility wrappers: PASS"
