#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

fail() {
  echo "sentinel uninstall: $1" >&2
  exit 1
}

if (( $# > 1 )); then
  fail "invalid command name"
fi

if (( $# == 0 )); then
  CMD_NAME="sentinel"
else
  CMD_NAME="$1"
fi

if (( ${#CMD_NAME} < 1 || ${#CMD_NAME} > 64 )) ||
    [[ ! "$CMD_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
  fail "invalid command name: use 1-64 ASCII letters, digits, dots, underscores, or hyphens, starting with a letter or digit"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$REPO_ROOT/codex/bin/sentinel-codex.sh"
if [[ ! -f "$TARGET" ]]; then
  fail "packaged launcher is unavailable"
fi
TARGET="$(readlink -f -- "$TARGET")" || fail "packaged launcher is unavailable"

mkdir -p -- "${HOME}/.local/bin"
BIN_DIR="$(cd -- "${HOME}/.local/bin" && pwd -P)" || fail "could not resolve install directory"
LINK_PATH="$BIN_DIR/$CMD_NAME"
if [[ "${LINK_PATH%/*}" != "$BIN_DIR" || "${LINK_PATH##*/}" != "$CMD_NAME" ]]; then
  fail "resolved command path is not a direct child of the install directory"
fi

if [[ -L "$LINK_PATH" ]]; then
  EXISTING_TARGET="$(readlink -f -- "$LINK_PATH" 2>/dev/null || true)"
  if [[ "$EXISTING_TARGET" != "$TARGET" ]]; then
    fail "refusing to remove an unrelated symlink at $LINK_PATH"
  fi
  rm -f -- "$LINK_PATH"
  echo "Removed command: $CMD_NAME"
elif [[ -e "$LINK_PATH" ]]; then
  fail "refusing to remove an existing non-owned path at $LINK_PATH"
else
  echo "Command not found: $LINK_PATH"
fi
