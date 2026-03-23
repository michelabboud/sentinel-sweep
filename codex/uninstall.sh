#!/usr/bin/env bash
set -euo pipefail

CMD_NAME="${1:-sentinel}"
LINK_PATH="${HOME}/.local/bin/${CMD_NAME}"

if [[ -L "$LINK_PATH" || -f "$LINK_PATH" ]]; then
  rm -f "$LINK_PATH"
  echo "Removed command: $CMD_NAME"
else
  echo "Command not found: $LINK_PATH"
fi
