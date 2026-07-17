#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-debug}"
case "$MODE" in
  debug|--debug)
    GRADLE_TASK="assembleDebug"
    OUTPUT="debug/app-debug.apk"
    ;;
  release|--release)
    GRADLE_TASK="assembleRelease"
    OUTPUT="release/app-release-unsigned.apk"
    ;;
  *)
    echo "usage: $0 [debug|--debug|release|--release]" >&2
    exit 2
    ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="$ROOT_DIR/apps/web"

cd "$ROOT_DIR"
npm run build -w @operalibre/web
(
  cd "$WEB_DIR"
  npx cap sync android
  cd android
  ./gradlew "$GRADLE_TASK"
)

echo "Built $WEB_DIR/android/app/build/outputs/apk/$OUTPUT"
