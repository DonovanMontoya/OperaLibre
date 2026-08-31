#!/usr/bin/env sh
# OperaLibre installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/DonovanMontoya/OperaLibre/main/script/install.sh | sh
#
# Pass options through the pipe with `sh -s --`, for example:
#
#   curl -fsSL .../install.sh | sh -s -- --dir ~/OperaLibre --library ~/Audiobooks --yes
#
# The script downloads the newest combined release package for this computer,
# verifies its SHA-256 digest against the published SHA256SUMS.txt, installs it,
# and starts OperaLibre in the background.

set -eu

REPOSITORY="DonovanMontoya/OperaLibre"
DOCS_URL="https://donovanmontoya.github.io/OperaLibre/installing-a-release.html"

INSTALL_DIR="${OPERALIBRE_DIR:-}"
LIBRARY_DIR="${OPERALIBRE_LIBRARY:-}"
VERSION="${OPERALIBRE_VERSION:-}"
DEPLOYMENT_MODE="${OPERALIBRE_MODE:-}"
LIBATION_PATH="${OPERALIBRE_LIBATION_PATH:-}"
LIBATION_CHOICE=""
KIND=""
ASSUME_YES=0
START_AFTER_INSTALL=1

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
OperaLibre installer

Usage: install.sh [options]

Options:
  --dir PATH          Install into PATH (default: ~/OperaLibre)
  --library PATH      Use PATH as the audiobook library folder
  --version VERSION   Install a specific release, such as 0.3.4 (default: latest)
  --mode local|lan    local listens only on this computer; lan allows other
                      devices on a trusted home network
  --server-only       Install the API and media server without the bundled web
                      app, for headless servers and separately hosted frontends
  --libation          Set up the optional Audible import: use an installed
                      Libation, or download one into the OperaLibre folder
  --libation-path P   Use the Libation CLI at P for the Audible import
  --no-libation       Skip the Audible import question
  --yes               Accept every default and never prompt
  --no-start          Install without starting OperaLibre
  --help              Show this message

Environment variables OPERALIBRE_DIR, OPERALIBRE_LIBRARY, OPERALIBRE_VERSION,
OPERALIBRE_MODE, and OPERALIBRE_LIBATION_PATH set the same values as the
matching options. OPERALIBRE_SERVER_ONLY=1 matches --server-only.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) [ "$#" -ge 2 ] || fail "--dir needs a path."; INSTALL_DIR=$2; shift 2 ;;
    --dir=*) INSTALL_DIR=${1#--dir=}; shift ;;
    --library) [ "$#" -ge 2 ] || fail "--library needs a path."; LIBRARY_DIR=$2; shift 2 ;;
    --library=*) LIBRARY_DIR=${1#--library=}; shift ;;
    --version) [ "$#" -ge 2 ] || fail "--version needs a value."; VERSION=$2; shift 2 ;;
    --version=*) VERSION=${1#--version=}; shift ;;
    --mode) [ "$#" -ge 2 ] || fail "--mode needs local or lan."; DEPLOYMENT_MODE=$2; shift 2 ;;
    --mode=*) DEPLOYMENT_MODE=${1#--mode=}; shift ;;
    --server-only) KIND=server; shift ;;
    --libation) LIBATION_CHOICE=yes; shift ;;
    --no-libation) LIBATION_CHOICE=no; shift ;;
    --libation-path) [ "$#" -ge 2 ] || fail "--libation-path needs a path."; LIBATION_PATH=$2; shift 2 ;;
    --libation-path=*) LIBATION_PATH=${1#--libation-path=}; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-start) START_AFTER_INSTALL=0; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; fail "Unknown option: $1" ;;
  esac
done

case "${DEPLOYMENT_MODE}" in
  ""|local|lan) ;;
  *) fail "--mode accepts local or lan, not '${DEPLOYMENT_MODE}'." ;;
esac

if [ -z "$KIND" ] && [ "${OPERALIBRE_SERVER_ONLY:-}" = 1 ]; then
  KIND=server
fi
KIND_REQUESTED=$KIND

if [ -n "$LIBATION_PATH" ] && [ "$LIBATION_CHOICE" != no ]; then
  LIBATION_CHOICE=yes
fi

if [ -n "$LIBATION_PATH" ]; then
  case "$LIBATION_PATH" in
    "~"|"~/"*) LIBATION_PATH="${HOME}${LIBATION_PATH#\~}" ;;
  esac
  [ -x "$LIBATION_PATH" ] ||
    fail "${LIBATION_PATH} is not an executable Libation command-line program."
fi

# The script is normally piped into sh, so stdin is the script itself. Prompts
# and answers use the terminal directly when one is available.
INTERACTIVE=0
if [ "$ASSUME_YES" -eq 0 ] && [ -r /dev/tty ] && [ -w /dev/tty ]; then
  INTERACTIVE=1
fi

ask() {
  ask_prompt=$1
  ask_default=$2
  if [ "$INTERACTIVE" -ne 1 ]; then
    printf '%s' "$ask_default"
    return 0
  fi
  printf '%s [%s]: ' "$ask_prompt" "$ask_default" >/dev/tty
  IFS= read -r ask_reply </dev/tty || ask_reply=""
  [ -n "$ask_reply" ] || ask_reply=$ask_default
  printf '%s' "$ask_reply"
}

confirm() {
  confirm_prompt=$1
  confirm_default=$2
  if [ "$INTERACTIVE" -ne 1 ]; then
    [ "$confirm_default" = "y" ]
    return
  fi
  if [ "$confirm_default" = "y" ]; then
    confirm_hint="Y/n"
  else
    confirm_hint="y/N"
  fi
  printf '%s [%s]: ' "$confirm_prompt" "$confirm_hint" >/dev/tty
  IFS= read -r confirm_reply </dev/tty || confirm_reply=""
  [ -n "$confirm_reply" ] || confirm_reply=$confirm_default
  case "$confirm_reply" in
    [Yy]|[Yy][Ee][Ss]) return 0 ;;
    *) return 1 ;;
  esac
}

expand_home() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s%s' "$HOME" "${1#\~}" ;;
    *) printf '%s' "$1" ;;
  esac
}

absolute_path() {
  case "$1" in
    /*) absolute_candidate=$1 ;;
    *) absolute_candidate="${PWD}/$1" ;;
  esac
  # Tidy up "./" segments and a trailing slash so printed paths stay readable.
  printf '%s' "$absolute_candidate" | sed -e 's|//*|/|g' -e 's|/\./|/|g' -e 's|/\.$||' -e 's|\(.\)/$|\1|'
}

need() {
  command -v "$1" >/dev/null 2>&1
}

# --- Detect the platform ----------------------------------------------------

kernel=$(uname -s)
machine=$(uname -m)

case "$kernel" in
  Darwin) os=macos ;;
  Linux) os=linux ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    fail "This installer supports macOS and Linux. On Windows, download the combined ZIP from ${DOCS_URL}"
    ;;
  *) fail "Unsupported operating system: ${kernel}" ;;
esac

case "$machine" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "Unsupported processor: ${machine}. See ${DOCS_URL}" ;;
esac

PLATFORM="${os}-${arch}"

if need curl; then
  DOWNLOADER=curl
elif need wget; then
  DOWNLOADER=wget
else
  fail "curl or wget is required."
fi

need tar || fail "tar is required."

if need sha256sum; then
  SHA_TOOL=sha256sum
elif need shasum; then
  SHA_TOOL=shasum
else
  fail "sha256sum or shasum is required to verify the download."
fi

fetch() {
  # fetch URL DESTINATION
  if [ "$DOWNLOADER" = curl ]; then
    curl -fsSL --retry 3 -o "$2" "$1"
  else
    wget -qO "$2" "$1"
  fi
}

fetch_stdout() {
  if [ "$DOWNLOADER" = curl ]; then
    curl -fsSL --retry 3 "$1"
  else
    wget -qO - "$1"
  fi
}

digest_of() {
  if [ "$SHA_TOOL" = sha256sum ]; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

say ""
say "OperaLibre installer"
say "===================="
say "Computer: ${PLATFORM}"

# --- Resolve the release ----------------------------------------------------

if [ -z "$VERSION" ]; then
  say "Looking up the newest release..."
  latest_json=$(fetch_stdout "https://api.github.com/repos/${REPOSITORY}/releases/latest") ||
    fail "Could not reach GitHub to look up the newest release."
  VERSION=$(printf '%s' "$latest_json" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$VERSION" ] || fail "Could not read the newest release version from GitHub."
fi

VERSION=${VERSION#v}
BASE_URL="https://github.com/${REPOSITORY}/releases/download/${VERSION}"

say "Release: ${VERSION}"
say ""

# --- Choose where it goes ---------------------------------------------------

default_dir="${HOME}/OperaLibre"
if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR=$(ask "Install folder" "$default_dir")
fi
INSTALL_DIR=$(absolute_path "$(expand_home "$INSTALL_DIR")")

UPGRADE=0
if [ -f "${INSTALL_DIR}/operalibre-server" ]; then
  UPGRADE=1
  existing_version=""
  if [ -f "${INSTALL_DIR}/VERSION.txt" ]; then
    existing_version=$(head -n 1 "${INSTALL_DIR}/VERSION.txt" 2>/dev/null || true)
  fi
  say ""
  if [ -n "$existing_version" ]; then
    say "Found OperaLibre ${existing_version} in ${INSTALL_DIR}."
  else
    say "Found an existing OperaLibre installation in ${INSTALL_DIR}."
  fi
  # Keep the kind that is already installed unless it was named explicitly, so
  # a plain re-run never swaps a headless server for the bundled web app.
  if [ -d "${INSTALL_DIR}/web" ]; then
    installed_kind=combined
  else
    installed_kind=server
  fi
  if [ -n "$KIND_REQUESTED" ] && [ "$KIND_REQUESTED" != "$installed_kind" ]; then
    fail "${INSTALL_DIR} holds a ${installed_kind} installation. Install the ${KIND_REQUESTED} package into another folder with --dir."
  fi
  KIND=$installed_kind
  say "Your data, audiobooks, and server.config folder settings are kept."
  confirm "Update it to ${VERSION}?" y || { say "Nothing was changed."; exit 0; }
elif [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null || true)" ]; then
  fail "${INSTALL_DIR} already exists and is not an OperaLibre installation. Choose another folder with --dir."
fi

[ -n "$KIND" ] || KIND=combined
PACKAGE="operalibre-${VERSION}-${KIND}-${PLATFORM}"
ARCHIVE="${PACKAGE}.tar.gz"

if [ "$UPGRADE" -eq 0 ]; then
  if [ -z "$LIBRARY_DIR" ]; then
    if [ "$INTERACTIVE" -eq 1 ]; then
      say ""
      say "OperaLibre keeps audiobooks in a folder you choose. Press Return to use"
      say "the folder inside the installation, or enter an existing library folder."
    fi
    LIBRARY_DIR=$(ask "Audiobook folder" "${INSTALL_DIR}/audiobooks")
  fi
  LIBRARY_DIR=$(absolute_path "$(expand_home "$LIBRARY_DIR")")

  if [ -z "$DEPLOYMENT_MODE" ]; then
    if [ "$INTERACTIVE" -eq 1 ]; then
      say ""
      say "Network access:"
      say "  local — only this computer can open OperaLibre (most private)"
      say "  lan   — phones and other devices on your trusted home network can too"
    fi
    DEPLOYMENT_MODE=$(ask "Choose local or lan" "local")
  fi
  case "$DEPLOYMENT_MODE" in
    local|lan) ;;
    *) fail "Network access must be local or lan, not '${DEPLOYMENT_MODE}'." ;;
  esac
fi

# --- Download and verify ----------------------------------------------------

WORK_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t operalibre)
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT INT TERM

say ""
say "Downloading ${ARCHIVE}..."
fetch "${BASE_URL}/${ARCHIVE}" "${WORK_DIR}/${ARCHIVE}" ||
  fail "Could not download ${BASE_URL}/${ARCHIVE}"

say "Verifying the download..."
fetch "${BASE_URL}/SHA256SUMS.txt" "${WORK_DIR}/SHA256SUMS.txt" ||
  fail "Could not download the checksum file for release ${VERSION}."

expected=$(awk -v name="$ARCHIVE" '$2 == name || $2 == "*" name { print $1; exit }' "${WORK_DIR}/SHA256SUMS.txt")
[ -n "$expected" ] || fail "${ARCHIVE} is not listed in the release checksums."
actual=$(digest_of "${WORK_DIR}/${ARCHIVE}")
[ "$expected" = "$actual" ] ||
  fail "The download does not match its published SHA-256 digest. Nothing was installed."

say "Digest verified."

mkdir -p "${WORK_DIR}/extract"
tar -xzf "${WORK_DIR}/${ARCHIVE}" -C "${WORK_DIR}/extract" ||
  fail "Could not extract ${ARCHIVE}."
STAGED="${WORK_DIR}/extract/${PACKAGE}"
[ -d "$STAGED" ] || fail "The downloaded package has an unexpected layout."

# --- Install ----------------------------------------------------------------

launcher_path() {
  # launcher_path DIR open|stop
  if [ "$KIND" = server ]; then
    # The server-only package has no background launcher, so the installer
    # writes the two helper scripts below.
    if [ "$2" = stop ]; then
      printf '%s' "$1/stop-operalibre.sh"
    else
      printf '%s' "$1/start-operalibre.sh"
    fi
    return 0
  fi
  if [ "$2" = stop ]; then
    if [ "$os" = macos ]; then
      printf '%s' "$1/Stop OperaLibre.app/Contents/MacOS/operalibre-launcher"
    else
      printf '%s' "$1/stop-operalibre"
    fi
  else
    if [ "$os" = macos ]; then
      printf '%s' "$1/Open OperaLibre.app/Contents/MacOS/operalibre-launcher"
    else
      printf '%s' "$1/open-operalibre"
    fi
  fi
}

if [ "$UPGRADE" -eq 1 ]; then
  stop_launcher=$(launcher_path "$INSTALL_DIR" stop)
  if [ -x "$stop_launcher" ]; then
    say "Stopping the running server..."
    "$stop_launcher" >/dev/null 2>&1 || true
  fi
  say "Installing OperaLibre ${VERSION}..."
  rm -rf "${INSTALL_DIR}/web" \
    "${INSTALL_DIR}/Open OperaLibre.app" \
    "${INSTALL_DIR}/Stop OperaLibre.app"
  for entry in "$STAGED"/* "$STAGED"/.[!.]*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    case "$name" in
      data|audiobooks|server.config) continue ;;
    esac
    cp -R "$entry" "${INSTALL_DIR}/${name}"
  done
else
  say "Installing OperaLibre ${VERSION} into ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"
  for entry in "$STAGED"/* "$STAGED"/.[!.]*; do
    [ -e "$entry" ] || continue
    cp -R "$entry" "${INSTALL_DIR}/$(basename "$entry")"
  done
fi

chmod 700 "${INSTALL_DIR}/data" 2>/dev/null || true

if [ "$KIND" = server ]; then
  # The combined package ships Open/Stop launchers; the server-only package
  # ships a foreground start.sh. Give headless installs the same two actions.
  cat >"${INSTALL_DIR}/start-operalibre.sh" <<'START_HELPER'
#!/usr/bin/env sh
# Written by the OperaLibre installer. Starts the server in the background.
set -eu

cd -- "$(dirname -- "$0")"
mkdir -p audiobooks data
chmod 700 data 2>/dev/null || true

pid_file="data/operalibre-server.pid"
if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  echo "OperaLibre is already running (process $(cat "$pid_file"))."
  exit 0
fi

touch data/server.log
chmod 600 data/server.log 2>/dev/null || true
nohup ./operalibre-server >>data/server.log 2>&1 &
echo "$!" >"$pid_file"
chmod 600 "$pid_file" 2>/dev/null || true
echo "OperaLibre started (process $!). Log: data/server.log"
START_HELPER

  cat >"${INSTALL_DIR}/stop-operalibre.sh" <<'STOP_HELPER'
#!/usr/bin/env sh
# Written by the OperaLibre installer. Stops the background server.
set -eu

cd -- "$(dirname -- "$0")"
pid_file="data/operalibre-server.pid"
if [ ! -f "$pid_file" ]; then
  echo "OperaLibre is not running."
  exit 0
fi

pid=$(cat "$pid_file")
if kill -0 "$pid" 2>/dev/null; then
  kill "$pid" 2>/dev/null || true
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 20 ]; do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
  echo "OperaLibre stopped."
else
  echo "OperaLibre is not running."
fi
rm -f "$pid_file"
STOP_HELPER

  chmod +x "${INSTALL_DIR}/start-operalibre.sh" "${INSTALL_DIR}/stop-operalibre.sh"
fi

set_config() {
  # set_config KEY VALUE
  config="${INSTALL_DIR}/server.config"
  [ -f "$config" ] || return 0
  CONFIG_KEY=$1 CONFIG_VALUE=$2 awk '
    BEGIN { key = ENVIRON["CONFIG_KEY"]; value = ENVIRON["CONFIG_VALUE"]; written = 0 }
    written == 0 && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" { print key " = " value; written = 1; next }
    { print }
    END { if (written == 0) print key " = " value }
  ' "$config" >"${config}.new" && mv "${config}.new" "$config"
}

if [ "$UPGRADE" -eq 0 ]; then
  if [ ! -d "$LIBRARY_DIR" ]; then
    if confirm "${LIBRARY_DIR} does not exist. Create it?" y; then
      mkdir -p "$LIBRARY_DIR" || fail "Could not create ${LIBRARY_DIR}."
    else
      fail "Choose an existing audiobook folder and run the installer again."
    fi
  fi
  set_config library_root "$LIBRARY_DIR"
  set_config deployment_mode "$DEPLOYMENT_MODE"
else
  if [ -n "$LIBRARY_DIR" ]; then
    LIBRARY_DIR=$(absolute_path "$(expand_home "$LIBRARY_DIR")")
    mkdir -p "$LIBRARY_DIR"
    set_config library_root "$LIBRARY_DIR"
  fi
  if [ -n "$DEPLOYMENT_MODE" ]; then
    set_config deployment_mode "$DEPLOYMENT_MODE"
  fi
fi

if [ "$os" = macos ]; then
  # The release files are not notarized yet, so clear the download quarantine.
  xattr -dr com.apple.quarantine "$INSTALL_DIR" >/dev/null 2>&1 || true
fi

# --- Optional Audible import (Libation) -------------------------------------

LIBATION_REPOSITORY="rmcrackan/Libation"
LIBATION_DOCS="https://donovanmontoya.github.io/OperaLibre/libation.html"
LIBATION_CONFIGURED=""

configured_libation_path() {
  sed -n 's/^[[:space:]]*libation_cli_path[[:space:]]*=[[:space:]]*\(.*\)$/\1/p' \
    "${INSTALL_DIR}/server.config" 2>/dev/null | head -n 1
}

find_libation() {
  for candidate in \
    "${INSTALL_DIR}/libation/Libation.app/Contents/MacOS/LibationCli" \
    "${INSTALL_DIR}/libation/usr/lib/libation/LibationCli" \
    "/Applications/Libation.app/Contents/MacOS/LibationCli" \
    "${HOME}/Applications/Libation.app/Contents/MacOS/LibationCli" \
    "/usr/lib/libation/LibationCli" \
    "/opt/Libation/LibationCli" \
    "${HOME}/.local/lib/libation/LibationCli"
  do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  for name in libationcli LibationCli; do
    if need "$name"; then
      command -v "$name"
      return 0
    fi
  done
  return 1
}

libation_asset() {
  # libation_asset TAG — the download for this computer, or nothing.
  libation_version=${1#v}
  case "$os" in
    macos) printf 'Libation.%s-macOS-chardonnay-%s.dmg' "$libation_version" "$arch" ;;
    linux)
      case "$arch" in
        x64) printf 'Libation.%s-linux-chardonnay-amd64.deb' "$libation_version" ;;
        arm64) printf 'Libation.%s-linux-chardonnay-arm64.deb' "$libation_version" ;;
      esac
      ;;
  esac
}

install_libation() {
  # Installs Libation inside the OperaLibre folder, so no administrator
  # password is needed and removing it is just deleting one folder.
  say "Looking up the newest Libation release..."
  libation_json=$(fetch_stdout "https://api.github.com/repos/${LIBATION_REPOSITORY}/releases/latest") || {
    say "Could not reach GitHub to look up Libation."
    return 1
  }
  libation_tag=$(printf '%s' "$libation_json" |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$libation_tag" ] || { say "Could not read the newest Libation version."; return 1; }

  libation_file=$(libation_asset "$libation_tag")
  if [ -z "$libation_file" ]; then
    say "Libation does not publish a package for ${PLATFORM}."
    return 1
  fi

  libation_root="${INSTALL_DIR}/libation"
  rm -rf "$libation_root"
  mkdir -p "$libation_root"

  say "Downloading ${libation_file} (about 90 MB)..."
  if ! fetch "https://github.com/${LIBATION_REPOSITORY}/releases/download/${libation_tag}/${libation_file}" \
    "${WORK_DIR}/${libation_file}"; then
    say "Could not download Libation ${libation_tag}."
    return 1
  fi

  if [ "$os" = macos ]; then
    mount_point="${WORK_DIR}/libation-dmg"
    mkdir -p "$mount_point"
    hdiutil attach -nobrowse -readonly -mountpoint "$mount_point" \
      "${WORK_DIR}/${libation_file}" >/dev/null 2>&1 || {
      say "Could not open the Libation disk image."
      return 1
    }
    cp -R "${mount_point}/Libation.app" "${libation_root}/Libation.app"
    libation_copied=$?
    hdiutil detach "$mount_point" >/dev/null 2>&1 || true
    [ "$libation_copied" -eq 0 ] || { say "Could not copy Libation out of the disk image."; return 1; }
    xattr -dr com.apple.quarantine "${libation_root}/Libation.app" >/dev/null 2>&1 || true
  else
    # The .deb payload is a self-contained folder, so unpack it in place
    # instead of asking for a root password to install a system package.
    if need dpkg-deb; then
      dpkg-deb -x "${WORK_DIR}/${libation_file}" "$libation_root" || {
        say "Could not unpack the Libation package."
        return 1
      }
    elif need ar; then
      (
        cd "$WORK_DIR" && ar x "${libation_file}" data.tar.xz &&
          if tar -xJf data.tar.xz -C "$libation_root" 2>/dev/null; then
            :
          else
            need xz || exit 1
            xz -dc data.tar.xz | tar -x -C "$libation_root"
          fi
      ) || {
        say "Could not unpack the Libation package."
        return 1
      }
    else
      say "Unpacking Libation needs dpkg-deb or ar, and neither is installed."
      return 1
    fi
  fi

  libation_cli=$(find_libation) || {
    say "Libation was downloaded, but its command-line program was not found."
    return 1
  }
  chmod +x "$libation_cli" 2>/dev/null || true
  LIBATION_PATH=$libation_cli
  say "Installed Libation ${libation_tag} in ${libation_root}."
  return 0
}

if [ "$LIBATION_CHOICE" != no ]; then
  existing_libation_config=$(configured_libation_path)
  if [ -n "$existing_libation_config" ] && [ -z "$LIBATION_PATH" ]; then
    # An upgrade that already has the import configured. Leave it alone.
    LIBATION_CONFIGURED=$existing_libation_config
  else
    want_libation=0
    if [ "$LIBATION_CHOICE" = yes ]; then
      want_libation=1
    elif [ "$INTERACTIVE" -eq 1 ]; then
      say ""
      say "Optional: OperaLibre can import your Audible purchases through Libation,"
      say "so owned books appear in your library. It stays hidden if you skip it,"
      say "and you can set it up later. Audible passwords are only ever entered on"
      say "Amazon's own sign-in page."
      if confirm "Set up the Audible import now?" n; then
        want_libation=1
      fi
    fi

    if [ "$want_libation" -eq 1 ]; then
      if [ -n "$LIBATION_PATH" ]; then
        LIBATION_PATH=$(absolute_path "$LIBATION_PATH")
      elif found_libation=$(find_libation); then
        say "Found Libation at ${found_libation}"
        if confirm "Use it?" y; then
          LIBATION_PATH=$found_libation
        fi
      fi

      if [ -z "$LIBATION_PATH" ]; then
        if confirm "Download Libation from its official GitHub release?" y; then
          install_libation || say "Skipping the Audible import for now."
        fi
      fi

      if [ -z "$LIBATION_PATH" ] && [ "$INTERACTIVE" -eq 1 ]; then
        answer=$(ask "Path to an installed Libation command-line program (blank to skip)" "")
        if [ -n "$answer" ]; then
          answer=$(absolute_path "$(expand_home "$answer")")
          if [ -x "$answer" ]; then
            LIBATION_PATH=$answer
          else
            say "${answer} is not an executable file. Skipping the Audible import."
          fi
        fi
      fi

      if [ -n "$LIBATION_PATH" ]; then
        set_config libation_cli_path "$LIBATION_PATH"
        LIBATION_CONFIGURED=$LIBATION_PATH
      else
        say "The Audible import stays off. See ${LIBATION_DOCS} to turn it on later."
      fi
    fi
  fi
fi

PORT=$(sed -n 's/^[[:space:]]*port[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' \
  "${INSTALL_DIR}/server.config" 2>/dev/null | head -n 1)
[ -n "$PORT" ] || PORT=4000

# --- Start ------------------------------------------------------------------

open_launcher=$(launcher_path "$INSTALL_DIR" open)
stop_launcher=$(launcher_path "$INSTALL_DIR" stop)

started=0
if [ "$START_AFTER_INSTALL" -eq 1 ]; then
  say "Starting OperaLibre..."
  # The launcher also tries to open a browser, which fails on headless
  # machines; the server itself still starts, so the port check decides.
  "$open_launcher" >/dev/null 2>&1 || true
  waited=0
  while [ "$waited" -lt 30 ]; do
    # Ask the API, not "/": a server-only install has no web app to serve
    # there, so a 404 would look like a server that never started.
    if [ "$DOWNLOADER" = curl ]; then
      curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null && started=1 && break
    else
      wget -q -O /dev/null --timeout=2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null && started=1 && break
    fi
    sleep 1
    waited=$((waited + 1))
  done
fi

say ""
say "Done."
say ""
if [ "$started" -eq 1 ]; then
  if [ "$KIND" = server ]; then
    say "The OperaLibre API is running at http://localhost:${PORT}"
  else
    say "OperaLibre is running at http://localhost:${PORT}"
    if [ "$UPGRADE" -eq 0 ]; then
      say "Open that address and create the administrator account."
    fi
  fi
elif [ "$START_AFTER_INSTALL" -eq 1 ]; then
  say "OperaLibre was installed, but the server did not answer on port ${PORT}."
  say "Check ${INSTALL_DIR}/data/server.log, then start it again with:"
  say "  \"${open_launcher}\""
else
  say "Start OperaLibre when you are ready with:"
  say "  \"${open_launcher}\""
fi
say ""
if [ -n "$LIBATION_CONFIGURED" ]; then
  say "Audible import is configured. Sign in as the administrator, open Audible,"
  say "and choose Add account to connect an Audible account."
  say ""
fi
if [ "$KIND" = server ] && [ "$UPGRADE" -eq 0 ]; then
  say "This package has no bundled web app. Point an OperaLibre frontend at it,"
  say "or set web_dist_dir in server.config to a folder holding the frontend"
  say "release package. A frontend on another address also needs its origin"
  say "listed in allowed_origins."
  say ""
fi
say "Installed in: ${INSTALL_DIR}"
say "Start:        \"${open_launcher}\""
say "Stop:         \"${stop_launcher}\""
say "Settings:     ${INSTALL_DIR}/server.config"
say "Guide:        ${DOCS_URL}"
say ""
