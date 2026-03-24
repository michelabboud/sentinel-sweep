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

# Escape dots for regex safety: 1.7.0 → 1\.7\.0
OLD_ESCAPED="${OLD_VERSION//./\\.}"

# Update VERSION file
echo "$NEW_VERSION" > "$VERSION_FILE"
echo "  Updated VERSION"

# JSON files — match "version": "X.Y.Z" pattern only
JSON_FILES=(
  ".claude-plugin/plugin.json"
  ".claude-plugin/marketplace.json"
)

for f in "${JSON_FILES[@]}"; do
  filepath="$PROJECT_ROOT/$f"
  if [[ -f "$filepath" ]]; then
    sed -i "s/\"version\": \"${OLD_ESCAPED}\"/\"version\": \"${NEW_VERSION}\"/g" "$filepath"
    echo "  Updated $f"
  fi
done

# Markdown files — targeted patterns only (never blind global replace)
MD_FILES=(
  "skills/run/SKILL.md"
  "skills/sentinel-setup/SKILL.md"
  "commands/sentinel.md"
  "agents/manifest-generator.md"
  "agents/api-sweeper.md"
  "agents/browser-sweeper.md"
  "CLAUDE.md"
  "README.md"
)

for f in "${MD_FILES[@]}"; do
  filepath="$PROJECT_ROOT/$f"
  if [[ -f "$filepath" ]]; then
    # YAML frontmatter: version: X.Y.Z (exact line)
    sed -i "s/^version: ${OLD_ESCAPED}$/version: ${NEW_VERSION}/" "$filepath"
    # Quoted strings: "X.Y.Z"
    sed -i "s/\"${OLD_ESCAPED}\"/\"${NEW_VERSION}\"/g" "$filepath"
    # v-prefixed with word boundary: vX.Y.Z
    sed -i "s/v${OLD_ESCAPED}\b/v${NEW_VERSION}/g" "$filepath"
    # Sentinel X.Y.Z (in prose)
    sed -i "s/Sentinel ${OLD_ESCAPED}/Sentinel ${NEW_VERSION}/g" "$filepath"
    # **Version**: X.Y.Z (in CLAUDE.md)
    sed -i "s/Version\*\*: ${OLD_ESCAPED}/Version**: ${NEW_VERSION}/g" "$filepath"
    # bump-version.sh example
    sed -i "s/bump-version\.sh ${OLD_ESCAPED}/bump-version.sh ${NEW_VERSION}/g" "$filepath"
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
