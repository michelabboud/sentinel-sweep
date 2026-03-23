#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$REPO_ROOT/codex/bin/sentinel-codex.sh"

BIN_DIR="${HOME}/.local/bin"
CMD_NAME="${1:-sentinel}"
LINK_PATH="$BIN_DIR/$CMD_NAME"

mkdir -p "$BIN_DIR"

if [[ ! -x "$TARGET" ]]; then
  echo "Missing executable: $TARGET"
  exit 1
fi

if [[ -L "$LINK_PATH" || -f "$LINK_PATH" ]]; then
  rm -f "$LINK_PATH"
fi

ln -s "$TARGET" "$LINK_PATH"

echo "Installed command: $CMD_NAME -> $TARGET"
echo "Link path: $LINK_PATH"
echo ""
echo "If '$BIN_DIR' is not on PATH, add this to your shell profile:"
echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
echo ""
echo "Usage:"
echo "  $CMD_NAME setup"
echo "  $CMD_NAME sweep --dry-run"
