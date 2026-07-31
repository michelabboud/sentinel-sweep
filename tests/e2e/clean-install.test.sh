#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C

fail() {
  echo "clean-install: $1" >&2
  exit 1
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
# Documented floor is Node 18+; pinning exactly 18 (EOL 2025-04) would force an
# unmaintained runtime. The PASS line records which runtime actually proved it.
NODE_VERSION="$(node -p 'process.versions.node')"
[[ "${NODE_VERSION%%.*}" -ge 18 ]] || fail "Node 18+ is required (found $NODE_VERSION)"
[[ -d "$ROOT/.git" || -f "$ROOT/.git" ]] || fail "source checkout is not a Git worktree"

TEMPORARY="$(mktemp -d /tmp/sentinel-clean-install-XXXXXX)"
cleanup() {
  rm -rf -- "$TEMPORARY"
}
trap cleanup EXIT

ARCHIVE="$TEMPORARY/sentinel.tar"
EXTRACTED="$TEMPORARY/extracted"
UNRELATED="$TEMPORARY/unrelated cwd"
mkdir -p -- "$EXTRACTED" "$UNRELATED"

HEAD_COMMIT="$(git -C "$ROOT" rev-parse HEAD)"
git -C "$ROOT" archive --format=tar --output="$ARCHIVE" HEAD
[[ "$(git get-tar-commit-id < "$ARCHIVE")" == "$HEAD_COMMIT" ]] \
  || fail "archive commit identity does not match HEAD"
tar -xf "$ARCHIVE" -C "$EXTRACTED"

if find "$EXTRACTED" -type d -name node_modules -print -quit | grep -q .; then
  fail "archive contains node_modules"
fi

while IFS= read -r -d '' RELATIVE; do
  [[ -e "$EXTRACTED/$RELATIVE" || -L "$EXTRACTED/$RELATIVE" ]] \
    || fail "archive omitted $RELATIVE"
  EXPECTED="$(git -C "$ROOT" rev-parse "HEAD:$RELATIVE")"
  ACTUAL="$(git hash-object --no-filters "$EXTRACTED/$RELATIVE")"
  [[ "$ACTUAL" == "$EXPECTED" ]] || fail "archive hash mismatch for $RELATIVE"
done < <(git -C "$ROOT" ls-tree -rz --name-only HEAD)

(
  cd "$EXTRACTED"
  npm test
  npm run lint
  npm run audit
)

if find "$EXTRACTED" -type d -name node_modules -print -quit | grep -q .; then
  fail "clean test execution created node_modules"
fi

HELP="$(cd "$UNRELATED" && node "$EXTRACTED/runtime/cli.mjs" --help)"
VERSION="$(cd "$UNRELATED" && node "$EXTRACTED/runtime/cli.mjs" --version)"
[[ "$HELP" == *"sentinel sweep --target"* ]] || fail "packaged CLI help is unavailable"
[[ "$VERSION" == "$(tr -d '[:space:]' < "$EXTRACTED/VERSION")" ]] \
  || fail "packaged CLI version is inconsistent"

(
  cd "$UNRELATED"
  node --test "$EXTRACTED/tests/e2e/goal-sweep.test.mjs"
)

echo "clean-install: PASS ($HEAD_COMMIT, node $NODE_VERSION)"
