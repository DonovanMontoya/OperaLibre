#!/bin/sh
set -eu

# Xcode runs this for every build; only an archive (ACTION=install), which is
# what reaches TestFlight or the App Store, has to come from the release tag
# named by MARKETING_VERSION. The checkout must match the tag except for the
# build numbers `node script/version.mjs build` changes, and the web bundle
# (gitignored, so git cannot vouch for it) must be built for this version
# after the tag was checked out.
[ "${ACTION:-}" = install ] || exit 0
VERSION="${MARKETING_VERSION:?MARKETING_VERSION is not set}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SYNC="OPERALIBRE_VERSION=$VERSION npm run sync:ios"
fail() {
  echo "error: $1" >&2
  exit 1
}

TAGS="$(git -C "$REPO" tag --points-at HEAD)" || fail "cannot read git tags in $REPO."
TAG="$(printf '%s\n' "$TAGS" | grep -Fx -e "$VERSION" -e "v$VERSION" | head -n 1)"
[ -n "$TAG" ] || fail "archive $VERSION from its release tag: git checkout $VERSION, then npm ci and $SYNC."

PBXPROJ=apps/web/ios/App/App.xcodeproj/project.pbxproj
GRADLE=apps/web/android/app/build.gradle
if [ -n "$(git -C "$REPO" status --porcelain -- . ":!$PBXPROJ" ":!$GRADLE")" ]; then
  fail "the $TAG checkout has uncommitted or untracked files; archive the tag as released."
fi
if git -C "$REPO" diff -U0 HEAD -- "$PBXPROJ" "$GRADLE" | grep -E '^[-+][^-+]' |
  grep -Evq '^[-+][[:space:]]*(CURRENT_PROJECT_VERSION = [0-9]+;|versionCode [0-9]+)$'; then
  fail "the $TAG checkout changes more than the build number in the Xcode or Android project."
fi

# HEAD is rewritten when a checkout changes it, but a branch can advance under
# an unchanged HEAD (pull, reset); the reflog records every move.
BUNDLE="$REPO/apps/web/ios/App/App/public/VERSION.txt"
GIT_DIR="$(git -C "$REPO" rev-parse --absolute-git-dir)"
if [ "$(cat "$BUNDLE" 2>/dev/null)" != "$VERSION" ] || [ "$BUNDLE" -ot "$GIT_DIR/HEAD" ] ||
  { [ -e "$GIT_DIR/logs/HEAD" ] && [ "$BUNDLE" -ot "$GIT_DIR/logs/HEAD" ]; }; then
  fail "the web bundle was not built for $TAG in this checkout; run $SYNC."
fi
echo "Archiving $VERSION (${CURRENT_PROJECT_VERSION:-?}) from release tag $TAG"
