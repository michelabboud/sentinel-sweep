#!/usr/bin/env bash
# bump-version.sh — update canonical live version surfaces and rebuild the plugin mirror
# Usage: ./scripts/bump-version.sh <new-version>
# Example: ./scripts/bump-version.sh 2.0.0
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
VERSION_FILE="$PROJECT_ROOT/VERSION"
MIRROR_ROOT="$PROJECT_ROOT/plugins/sentinel"

die() {
  echo "Error: $*" >&2
  exit 1
}

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <new-version>" >&2
  echo "Example: $0 2.0.0" >&2
  exit 1
fi

NEW_VERSION="$1"
if ! [[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "Version must be semver (for example, 2.0.0)"
fi

[[ -f "$VERSION_FILE" && ! -L "$VERSION_FILE" ]] || die "VERSION must be a regular, non-symlink file"
OLD_VERSION=$(tr -d '[:space:]' < "$VERSION_FILE")
if ! [[ "$OLD_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "Current VERSION is not valid semver"
fi

# Escape every dot before using a version in a regular expression. This is the
# regression boundary that prevents versions such as 1.7.0 from matching IPs.
OLD_ESCAPED="${OLD_VERSION//./\\.}"
NEW_SERIES="${NEW_VERSION%.*}"

CANONICAL_DIRS=(
  ".claude-plugin"
  "agents"
  "commands"
  "runtime"
  "schemas"
  "skills"
)

CANONICAL_FILES=(
  "VERSION"
  "package.json"
  "settings.json"
  "LICENSE"
  "README.md"
  "SECURITY.md"
  "CONTRIBUTING.md"
  "CHANGELOG.md"
  "CLAUDE.md"
  "ARCHITECTURE.md"
)

JSON_VERSION_FILES=(
  ".claude-plugin/plugin.json"
  ".claude-plugin/marketplace.json"
  "package.json"
)

CLAUDE_FRONTMATTER_FILES=(
  "skills/run/SKILL.md"
  "agents/manifest-generator.md"
  "agents/api-sweeper.md"
  "agents/browser-sweeper.md"
)

CODEX_FRONTMATTER_FILES=(
  "codex/commands/sentinel.md"
  "codex/agents/manifest-generator.md"
  "codex/agents/api-sweeper.md"
  "codex/agents/browser-sweeper.md"
)

RELEASE_DOC_FILES=(
  "README.md"
  "CLAUDE.md"
)

require_regular_file() {
  local rel="$1"
  local path="$PROJECT_ROOT/$rel"
  [[ -f "$path" && ! -L "$path" ]] || die "$rel must be a regular, non-symlink file"
}

for dir in "${CANONICAL_DIRS[@]}"; do
  canonical_dir="$PROJECT_ROOT/$dir"
  [[ -d "$canonical_dir" && ! -L "$canonical_dir" ]] || die "$dir must be a regular directory"
  if find "$canonical_dir" -type l -print -quit | grep -q .; then
    die "$dir contains a symlink; release assets must be regular files"
  fi
  if find "$canonical_dir" -mindepth 1 ! -type d ! -type f -print -quit | grep -q .; then
    die "$dir contains a non-regular release asset"
  fi
done

for rel in "${CANONICAL_FILES[@]}" "${CODEX_FRONTMATTER_FILES[@]}"; do
  require_regular_file "$rel"
done

[[ -d "$MIRROR_ROOT" && ! -L "$MIRROR_ROOT" ]] || die "plugins/sentinel must be a regular directory"
if find "$MIRROR_ROOT" -type l -print -quit | grep -q .; then
  die "plugins/sentinel contains a symlink; refusing an ambiguous destination"
fi
if find "$MIRROR_ROOT" -mindepth 1 ! -type d ! -type f -print -quit | grep -q .; then
  die "plugins/sentinel contains a non-regular release asset"
fi

# Build the exact allowed mirror inventory from canonical root assets. Unexpected
# mirror files fail closed instead of being silently retained or broadly deleted.
declare -A EXPECTED_MIRROR=()
MIRROR_INVENTORY=()

add_inventory_file() {
  local source="$1"
  local rel="${source#$PROJECT_ROOT/}"
  [[ "$rel" != "$source" && "$rel" != /* && "$rel" != *$'\n'* ]] || die "Unsafe canonical inventory path"
  [[ "$rel" != ".." && "$rel" != ../* && "$rel" != */../* && "$rel" != */.. ]] || die "Canonical inventory escapes project root"
  EXPECTED_MIRROR["$rel"]=1
  MIRROR_INVENTORY+=("$rel")
}

for dir in "${CANONICAL_DIRS[@]}"; do
  while IFS= read -r -d '' source; do
    add_inventory_file "$source"
  done < <(find "$PROJECT_ROOT/$dir" -type f -print0)
done
for rel in "${CANONICAL_FILES[@]}"; do
  add_inventory_file "$PROJECT_ROOT/$rel"
done

while IFS= read -r -d '' existing; do
  rel="${existing#$MIRROR_ROOT/}"
  [[ "$rel" != "$existing" && "$rel" != /* && "$rel" != *$'\n'* ]] || die "Unsafe mirror inventory path"
  if [[ -z "${EXPECTED_MIRROR[$rel]+present}" ]]; then
    die "Unexpected mirror asset plugins/sentinel/$rel; remove or classify it explicitly"
  fi
done < <(find "$MIRROR_ROOT" -type f -print0)

# Validate every live version surface before modifying anything. A partially
# migrated or manually corrupted surface must not yield a half-written bump.
for rel in "${JSON_VERSION_FILES[@]}"; do
  require_regular_file "$rel"
  if ! grep -qF -- "\"version\": \"$OLD_VERSION\"" "$PROJECT_ROOT/$rel" &&
     ! grep -qF -- "\"version\": \"$NEW_VERSION\"" "$PROJECT_ROOT/$rel"; then
    die "$rel does not contain the current or requested live version"
  fi
done

for rel in "${CLAUDE_FRONTMATTER_FILES[@]}"; do
  require_regular_file "$rel"
  if ! grep -Eq "^version: (${OLD_ESCAPED}|${NEW_VERSION//./\\.})$" "$PROJECT_ROOT/$rel"; then
    die "$rel does not contain the current or requested frontmatter version"
  fi
done

for rel in "${CODEX_FRONTMATTER_FILES[@]}"; do
  if ! grep -Eq "^version: (${OLD_ESCAPED}-codex\.[0-9]+|${NEW_VERSION//./\\.}-codex\.1)$" "$PROJECT_ROOT/$rel"; then
    die "$rel does not contain a recognized Codex compatibility version"
  fi
done

CHANGELOG_FIRST=$(sed -n 's/^## \[\([0-9][0-9.]*\)\].*/\1/p' "$PROJECT_ROOT/CHANGELOG.md" | head -1)
if [[ "$CHANGELOG_FIRST" != "$OLD_VERSION" && "$CHANGELOG_FIRST" != "$NEW_VERSION" ]]; then
  die "CHANGELOG.md first release must be $OLD_VERSION or $NEW_VERSION"
fi

# Below, a top entry still headed OLD_VERSION is renamed to NEW_VERSION — correct
# when that entry is the unreleased one being shipped, but destructive once
# OLD_VERSION has actually shipped: it would rewrite published release history in
# place. An existing tag is the evidence that it shipped.
if [[ "$CHANGELOG_FIRST" == "$OLD_VERSION" ]] \
  && git -C "$PROJECT_ROOT" rev-parse -q --verify "refs/tags/v${OLD_VERSION}" >/dev/null 2>&1; then
  die "CHANGELOG.md's top entry is the released v${OLD_VERSION}. Add the ${NEW_VERSION} entry above it first, then re-run this script."
fi

if [[ "$OLD_VERSION" == "$NEW_VERSION" ]]; then
  echo "Already at version $NEW_VERSION; verifying and repairing mirror parity"
else
  echo "Bumping $OLD_VERSION -> $NEW_VERSION"
fi
echo ""

printf '%s\n' "$NEW_VERSION" > "$VERSION_FILE"
echo "  Updated VERSION"

for rel in "${JSON_VERSION_FILES[@]}"; do
  sed -i "s/\"version\": \"${OLD_ESCAPED}\"/\"version\": \"${NEW_VERSION}\"/g" "$PROJECT_ROOT/$rel"
  echo "  Updated $rel"
done

for rel in "${CLAUDE_FRONTMATTER_FILES[@]}"; do
  sed -i "s/^version: ${OLD_ESCAPED}$/version: ${NEW_VERSION}/" "$PROJECT_ROOT/$rel"
  echo "  Updated $rel"
done

for rel in "${CODEX_FRONTMATTER_FILES[@]}"; do
  sed -i "s/^version: ${OLD_ESCAPED}-codex\.[0-9]\+$/version: ${NEW_VERSION}-codex.1/" "$PROJECT_ROOT/$rel"
  echo "  Updated $rel"
done

if [[ "$CHANGELOG_FIRST" == "$OLD_VERSION" ]]; then
  sed -i "0,/^## \[${OLD_ESCAPED}\]/s//## [${NEW_VERSION}]/" "$PROJECT_ROOT/CHANGELOG.md"
  echo "  Updated CHANGELOG.md current release header"
fi

for rel in "${RELEASE_DOC_FILES[@]}"; do
  path="$PROJECT_ROOT/$rel"
  sed -i \
    -e "s/^Current release: Sentinel ${OLD_ESCAPED}$/Current release: Sentinel ${NEW_VERSION}/" \
    -e "s/^\*\*Current release:\*\* Sentinel ${OLD_ESCAPED}$/\*\*Current release:\*\* Sentinel ${NEW_VERSION}/" \
    -e "s/^# Sentinel ${OLD_ESCAPED}$/# Sentinel ${NEW_VERSION}/" \
    -e "s/^Sentinel ${OLD_ESCAPED} is/Sentinel ${NEW_VERSION} is/" \
    -e "s/Version\*\*: ${OLD_ESCAPED}/Version**: ${NEW_VERSION}/g" \
    "$path"

  # At a new major/minor .0 release, normalize an explicit major/minor current
  # release sentence without rewriting historical mentions elsewhere.
  if [[ "$NEW_VERSION" == "$NEW_SERIES.0" ]]; then
    sed -i "s/^Sentinel ${NEW_SERIES//./\\.} is/Sentinel ${NEW_VERSION} is/" "$path"
  fi
  echo "  Updated $rel current-release markers"
done

echo ""
echo "Syncing exact plugin mirror inventory..."
for rel in "${MIRROR_INVENTORY[@]}"; do
  src="$PROJECT_ROOT/$rel"
  dst="$MIRROR_ROOT/$rel"
  parent="$(dirname "$dst")"
  [[ "$parent" == "$MIRROR_ROOT" || "$parent" == "$MIRROR_ROOT/"* ]] || die "Mirror destination escapes plugins/sentinel for $rel"
  mkdir -p -- "$parent"
  [[ -d "$parent" && ! -L "$parent" ]] || die "Unsafe mirror parent for $rel"
  [[ "$(realpath -m -- "$parent")" == "$parent" ]] || die "Mirror parent changed identity for $rel"
  cp -p -- "$src" "$dst"
  cmp -s "$src" "$dst" || die "Mirror verification failed for $rel"
  echo "  Synced plugins/sentinel/$rel"
done

echo ""
echo "Done. Version is $NEW_VERSION and the plugin mirror is byte-identical."
echo "Next: run structure, mirror, version, bump, and full release gates."
