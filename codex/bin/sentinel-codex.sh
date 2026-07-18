#!/usr/bin/env bash
set -euo pipefail

SELF_PATH="$(readlink -f -- "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd -- "$(dirname -- "$SELF_PATH")" && pwd -P)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"

exec node "$ROOT/runtime/cli.mjs" "$@"
