#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-debug}"
case "$MODE" in
  debug|--debug)
    CONFIGURATION="Debug"
    ;;
  release|--release)
    CONFIGURATION="Release"
    ;;
  *)
    echo "usage: $0 [debug|--debug|release|--release]" >&2
    exit 2
    ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/apps/web"
PROJECT="$WEB_DIR/ios/App/App.xcodeproj"
DERIVED_DATA="$ROOT_DIR/dist/ios-derived"

cd "$ROOT_DIR"
npm run build -w @operalibre/web
(
  cd "$WEB_DIR"
  npx cap sync ios
)

xcodebuild \
  -project "$PROJECT" \
  -scheme App \
  -configuration "$CONFIGURATION" \
  -destination "generic/platform=iOS Simulator" \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGNING_ALLOWED=NO \
  build

echo "Built $DERIVED_DATA/Build/Products/$CONFIGURATION-iphonesimulator/OperaLibre.app"
