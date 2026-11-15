#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
APP_NAME="OperaLibre"
BUNDLE_ID="com.operalibre.desktop"
MIN_SYSTEM_VERSION="13.0"

case "$MODE" in
  run|--debug|debug|--logs|logs|--telemetry|telemetry|--verify|verify) ;;
  *)
    echo "usage: $0 [run|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
APP_CONTENTS="$APP_BUNDLE/Contents"
APP_MACOS="$APP_CONTENTS/MacOS"
APP_RESOURCES="$APP_CONTENTS/Resources"
APP_BINARY="$APP_MACOS/$APP_NAME"
INFO_PLIST="$APP_CONTENTS/Info.plist"
APP_ICON_SOURCE="$ROOT_DIR/apps/macos/Resources/OperaLibre.icns"
if [[ ! -f "$APP_ICON_SOURCE" ]]; then
  APP_ICON_SOURCE="$ROOT_DIR/apps/web/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
fi

cd "$ROOT_DIR"

# The macOS app follows the server line (AGENTS.md "Versions"), so it reports
# the server crate's version. Bundle versions must be plain X.Y.Z.
APP_VERSION="$(sed -n 's/^version = "\(.*\)"$/\1/p' apps/server/Cargo.toml | head -n 1)"
APP_VERSION="${APP_VERSION%%-*}"
if [[ ! "$APP_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "could not read the server version from apps/server/Cargo.toml" >&2
  exit 1
fi
# The app binds a fixed port. Stop the copy this checkout built if it holds
# that port, and never an installed OperaLibre or another checkout's build.
APP_PORT=49201
APP_URL="http://127.0.0.1:$APP_PORT/index.html"

port_owner() {
  /usr/sbin/lsof -nP -t -iTCP:"$APP_PORT" -sTCP:LISTEN 2>/dev/null | head -n 1 || true
}

is_this_build() {
  local macos_dir
  macos_dir="$(cd "$APP_MACOS" 2>/dev/null && pwd -P)" || return 1
  [[ "$(ps -o comm= -p "$1")" == "$macos_dir/$APP_NAME" ]]
}

stop_previous_build() {
  local pid
  pid="$(port_owner)"
  [[ -n "$pid" ]] || return 0
  if ! is_this_build "$pid"; then
    echo "port $APP_PORT is held by $(ps -o comm= -p "$pid") (pid $pid); quit it first" >&2
    exit 1
  fi
  kill "$pid"
  for _ in {1..50}; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  echo "the previous build (pid $pid) did not quit" >&2
  exit 1
}

stop_previous_build

npm run build -w @operalibre/web
swift build --product "$APP_NAME"
BUILD_BINARY="$(swift build --show-bin-path)/$APP_NAME"

rm -rf "$APP_BUNDLE"
mkdir -p "$APP_MACOS" "$APP_RESOURCES/Web"
cp "$BUILD_BINARY" "$APP_BINARY"
cp -R "$ROOT_DIR/apps/web/dist/." "$APP_RESOURCES/Web/"
cp "$APP_ICON_SOURCE" "$APP_RESOURCES/OperaLibre.icns"
chmod +x "$APP_BINARY"

cat >"$INFO_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleExecutable</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundleIconFile</key>
  <string>OperaLibre.icns</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$APP_VERSION</string>
  <key>CFBundleVersion</key>
  <string>$APP_VERSION</string>
  <key>LSMinimumSystemVersion</key>
  <string>$MIN_SYSTEM_VERSION</string>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSLocalNetworkUsageDescription</key>
  <string>OperaLibre connects to your audiobook server on the local network.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
    <key>NSAllowsArbitraryLoadsInWebContent</key>
    <true/>
    <key>NSAllowsLocalNetworking</key>
    <true/>
  </dict>
</dict>
</plist>
PLIST

open_app() {
  /usr/bin/open -n "$APP_BUNDLE"
}

case "$MODE" in
  run)
    open_app
    ;;
  --debug|debug)
    lldb -- "$APP_BINARY"
    ;;
  --logs|logs)
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_NAME\""
    ;;
  --telemetry|telemetry)
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    open_app
    for _ in {1..100}; do
      if /usr/bin/curl -fs -o /dev/null "$APP_URL"; then
        is_this_build "$(port_owner)"
        exit
      fi
      sleep 0.1
    done
    echo "the app did not start serving $APP_URL" >&2
    exit 1
    ;;
esac
