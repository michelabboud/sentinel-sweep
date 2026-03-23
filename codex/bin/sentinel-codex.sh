#!/usr/bin/env bash
set -euo pipefail
SELF_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$SELF_PATH")" && pwd)"
exec "$SCRIPT_DIR/sentinel_codex.py" "$@"
