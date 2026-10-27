#!/bin/sh
set -eu

# Xcode runs this for every build; only an archive (ACTION=install), which is
# what reaches TestFlight or the App Store, has to come from the release tag
# named by MARKETING_VERSION. `node script/version.mjs build` may change the
# project file's build number at that tag; anything else uncommitted fails.
[ "${ACTION:-}" = install ] || exit 0
VERSION="${MARKETING_VERSION:?MARKETING_VERSION is not set}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
if ! git -C "$REPO" tag --points-at HEAD | grep -qx "$VERSION"; then
  echo "error: archive $VERSION from its release tag: git checkout $VERSION (then npm ci and npm run sync:ios)." >&2
  exit 1
fi
if [ -n "$(git -C "$REPO" status --porcelain --untracked-files=no -- . ':!apps/web/ios/App/App.xcodeproj/project.pbxproj')" ]; then
  echo "error: the $VERSION checkout has uncommitted changes; archive the tag as released." >&2
  exit 1
fi
echo "Archiving $VERSION (${CURRENT_PROJECT_VERSION:-?}) from release tag $VERSION"
