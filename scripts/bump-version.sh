#!/usr/bin/env bash
# bump-version.sh — Bump version across all files from VERSION source of truth
# Usage: ./scripts/bump-version.sh <new-version>
# Example: ./scripts/bump-version.sh 1.3.0
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION_FILE="$PROJECT_ROOT/VERSION"

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <new-version>"
  echo "Example: $0 1.3.0"
  exit 1
fi

NEW_VERSION="$1"

if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Version must be semver (e.g., 1.3.0)"
  exit 1
fi

if [[ ! -f "$VERSION_FILE" ]]; then
  echo "Error: VERSION file not found"
  exit 1
fi

OLD_VERSION=$(tr -d '[:space:]' < "$VERSION_FILE")

if [[ "$OLD_VERSION" == "$NEW_VERSION" ]]; then
  echo "Already at version $NEW_VERSION"
  exit 0
fi

echo "Bumping $OLD_VERSION → $NEW_VERSION"
echo ""

# Update VERSION file
echo "$NEW_VERSION" > "$VERSION_FILE"
echo "  Updated VERSION"

# Files to update (relative to PROJECT_ROOT)
FILES=(
  ".claude-plugin/plugin.json"
  ".claude-plugin/marketplace.json"
  "skills/run/SKILL.md"
  "skills/sentinel-setup/SKILL.md"
  "commands/sentinel.md"
  "agents/manifest-generator.md"
  "agents/api-sweeper.md"
  "agents/browser-sweeper.md"
  "CLAUDE.md"
  "README.md"
)

for f in "${FILES[@]}"; do
  filepath="$PROJECT_ROOT/$f"
  if [[ -f "$filepath" ]]; then
    sed -i "s/$OLD_VERSION/$NEW_VERSION/g" "$filepath"
    echo "  Updated $f"
  fi
done

# Sync plugin mirror
echo ""
echo "Syncing plugin mirror..."
MIRROR_FILES=(
  ".claude-plugin/plugin.json"
  ".claude-plugin/marketplace.json"
  "skills/run/SKILL.md"
  "skills/sentinel-setup/SKILL.md"
  "commands/sentinel.md"
  "agents/manifest-generator.md"
  "agents/api-sweeper.md"
  "agents/browser-sweeper.md"
  "README.md"
)

for f in "${MIRROR_FILES[@]}"; do
  src="$PROJECT_ROOT/$f"
  dst="$PROJECT_ROOT/plugins/sentinel/$f"
  if [[ -f "$src" ]] && [[ -d "$(dirname "$dst")" ]]; then
    cp "$src" "$dst"
    echo "  Synced plugins/sentinel/$f"
  fi
done

echo ""
echo "Done. Version is now $NEW_VERSION"
echo ""
echo "Next steps:"
echo "  1. Add CHANGELOG.md entry for [$NEW_VERSION]"
echo "  2. Run: bash tests/test-version-consistency.sh"
echo "  3. Commit and tag: git tag v$NEW_VERSION"
