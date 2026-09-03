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

# --no-libation wins over a path that came from the environment or an earlier
# option: skipping the Audible import must never fail the run over a Libation
# that has since moved or been removed.
if [ "$LIBATION_CHOICE" = no ]; then
  LIBATION_PATH=""
elif [ -n "$LIBATION_PATH" ]; then
  LIBATION_CHOICE=yes
  case "$LIBATION_PATH" in
    "~"|"~/"*) LIBATION_PATH="${HOME}${LIBATION_PATH#\~}" ;;
  esac
  [ -x "$LIBATION_PATH" ] ||
    fail "${LIBATION_PATH} is not an executable Libation command-line program."
fi

# The script is normally piped into sh, so stdin is the script itself. Prompts
# and answers use the terminal directly when one is available. `-r`/`-w` on
# /dev/tty can pass in a session with no controlling terminal (CI, or a
# non-interactive ssh command), where the first prompt would then die opening
# it — so probe by actually opening the device.
INTERACTIVE=0
if [ "$ASSUME_YES" -eq 0 ] && ( : </dev/tty ) 2>/dev/null && ( : >/dev/tty ) 2>/dev/null; then
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

# OperaLibre needs no privileges, and a server running as root turns any
# media-parser bug into a system compromise. Warn, and in a terminal ask.
if [ "$(id -u 2>/dev/null || echo 1)" = 0 ]; then
  say "Warning: you are running the installer as root. OperaLibre does not need" >&2
  say "administrator rights. Install it as the user who will run it, or run it" >&2
  say "under a dedicated account with the operalibre.service systemd unit:" >&2
  say "  https://donovanmontoya.github.io/OperaLibre/deployment.html" >&2
  if [ "$INTERACTIVE" -eq 1 ]; then
    confirm "Continue as root anyway?" n || fail "Run the installer as a regular user."
  fi
fi

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

# Download URLs live under the tag exactly as GitHub reports it (which may
# carry a v prefix); the stripped form is only for display and package names.
RELEASE_TAG=$VERSION
VERSION=${VERSION#v}
BASE_URL="https://github.com/${REPOSITORY}/releases/download/${RELEASE_TAG}"

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
  # a plain re-run never swaps a headless server for the bundled web app. The
  # launcher and the start helper come from the package itself, so they are the
  # reliable signals; a `web` folder can also be one a server-only operator
  # points web_dist_dir at, so it only decides when nothing else does.
  if [ "$os" = macos ]; then
    installed_launcher="${INSTALL_DIR}/Open OperaLibre.app"
  else
    installed_launcher="${INSTALL_DIR}/open-operalibre"
  fi
  if [ -e "$installed_launcher" ]; then
    installed_kind=combined
  elif [ -f "${INSTALL_DIR}/start-operalibre.sh" ] || [ -f "${INSTALL_DIR}/start.sh" ]; then
    installed_kind=server
  elif [ -d "${INSTALL_DIR}/web" ]; then
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
STAGE_DIR=""
BACKUP_DIR=""
cleanup() {
  rm -rf "$WORK_DIR"
  [ -z "$STAGE_DIR" ] || rm -rf "$STAGE_DIR"
  # Only ever empty by now: a swap that parked files in it either finished
  # and removed it, or put them back before failing. Never delete contents.
  [ -z "$BACKUP_DIR" ] || rmdir "$BACKUP_DIR" 2>/dev/null || true
}
trap cleanup EXIT
# A signal ends the run through the EXIT trap. Running cleanup from the
# signal trap alone would resume the script with its work folders gone.
trap 'exit 130' INT TERM

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

config_value() {
  # config_value KEY — the value of KEY in the installed server.config, if any.
  #
  # The server lowercases keys, reads `-` as `_`, trims whitespace, and strips
  # one pair of matching quotes, so `Data-Dir = "state"` names the same folder
  # as `data_dir = state`. Match the same spellings here, or a custom port or
  # data folder would be missed and the running-server check would look in
  # the wrong place. Self-check: `data_dir = "state"`, `Data-Dir = state`,
  # `port = '4123'` and `Port=4123` must all resolve to their bare values.
  config="${INSTALL_DIR}/server.config"
  [ -f "$config" ] || return 0
  CONFIG_KEY=$1 awk '
    BEGIN {
      pattern = ENVIRON["CONFIG_KEY"]
      gsub(/[-_]/, "[-_]", pattern)
      pattern = "^[[:space:]]*" pattern "[[:space:]]*="
    }
    tolower($0) ~ pattern {
      value = $0
      sub(/^[^=]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]+$/, "", value)
      first = substr(value, 1, 1)
      last = substr(value, length(value), 1)
      if (length(value) >= 2 && first == last && (first == "\"" || first == "\047"))
        value = substr(value, 2, length(value) - 2)
      print value
      exit
    }
  ' "$config"
}

configured_port() {
  port_value=$(config_value port | sed -n 's/^\([0-9][0-9]*\).*/\1/p')
  printf '%s' "${port_value:-4000}"
}

configured_data_dir() {
  # The server resolves a relative data_dir against the folder holding
  # server.config, which is the installation folder.
  data_value=$(config_value data_dir)
  case "$data_value" in
    "") printf '%s' "${INSTALL_DIR}/data" ;;
    /*) printf '%s' "$data_value" ;;
    *) printf '%s' "${INSTALL_DIR}/${data_value}" ;;
  esac
}

server_answers() {
  # Ask the API, not "/": a server-only install has no web app to serve
  # there, so a 404 would look like a server that never started.
  if [ "$DOWNLOADER" = curl ]; then
    curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null
  else
    wget -q -O /dev/null --timeout=2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null
  fi
}

server_process_is_running() {
  # A PID left behind by a crash can be recycled by the OS, so only a process
  # that is actually this installation's server counts.
  server_pid_file="$(configured_data_dir)/operalibre-server.pid"
  [ -f "$server_pid_file" ] || return 1
  server_pid=$(cat "$server_pid_file" 2>/dev/null || true)
  [ -n "$server_pid" ] || return 1
  case "$(ps -p "$server_pid" -o args= 2>/dev/null)" in
    *operalibre-server*) return 0 ;;
    *) return 1 ;;
  esac
}

wait_for_server_exit() {
  # The stop launcher asks the server to shut down and returns once it has
  # gone, but guard against an older launcher, or a server started by hand,
  # before replacing the files under a process that may still be running.
  waited=0
  while [ "$waited" -lt 30 ]; do
    if ! server_process_is_running && ! server_answers; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

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
  PORT=$(configured_port)
  stop_launcher=$(launcher_path "$INSTALL_DIR" stop)
  if [ -x "$stop_launcher" ]; then
    say "Stopping the running server..."
    "$stop_launcher" >/dev/null 2>&1 || true
  fi
  if server_process_is_running || server_answers; then
    say "Waiting for the server to finish shutting down..."
    wait_for_server_exit ||
      fail "The server is still running. Stop it, then run the installer again. Nothing was changed."
  fi

  # Copy the new files beside the installation first, so a copy that fails
  # part-way leaves the old version intact, then swap them in with renames.
  say "Installing OperaLibre ${VERSION}..."
  STAGE_DIR="${INSTALL_DIR}/.staged-$$"
  BACKUP_DIR="${INSTALL_DIR}/.previous-$$"
  rm -rf "$STAGE_DIR" "$BACKUP_DIR"
  mkdir -p "$STAGE_DIR" "$BACKUP_DIR"
  for entry in "$STAGED"/* "$STAGED"/.[!.]*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    case "$name" in
      data|audiobooks|server.config) continue ;;
    esac
    cp -R "$entry" "${STAGE_DIR}/${name}" ||
      fail "Could not copy ${name} into ${INSTALL_DIR}. The existing installation was left unchanged."
  done

  # Existing entries are parked in BACKUP_DIR rather than deleted before their
  # replacements move in, so a rename that fails part-way can put the previous
  # version back and leave the new files where they can be inspected.
  MOVED_IN_LIST="${WORK_DIR}/moved-in"
  : >"$MOVED_IN_LIST"
  restore_previous() {
    # restore_previous NAME — undo the swap after NAME could not be moved.
    while IFS= read -r moved; do
      [ -n "$moved" ] || continue
      mv "${INSTALL_DIR}/${moved}" "${STAGE_DIR}/${moved}" 2>/dev/null || true
    done <"$MOVED_IN_LIST"
    restored="The previous version was restored"
    for previous in "$BACKUP_DIR"/* "$BACKUP_DIR"/.[!.]*; do
      [ -e "$previous" ] || continue
      previous_name=$(basename "$previous")
      rm -rf "${INSTALL_DIR:?}/${previous_name}"
      mv "$previous" "${INSTALL_DIR}/${previous_name}" ||
        restored="Some previous files could not be put back and remain in ${BACKUP_DIR}"
    done
    rmdir "$BACKUP_DIR" 2>/dev/null || true
    # Blank STAGE_DIR so the EXIT trap leaves the staged files in place.
    staged_files=$STAGE_DIR
    STAGE_DIR=""
    fail "Could not move ${1} into place. ${restored}; the new files remain in ${staged_files}."
  }
  move_aside() {
    # move_aside NAME — park the installed NAME in BACKUP_DIR, if present.
    [ -e "${INSTALL_DIR}/${1}" ] || return 0
    mv "${INSTALL_DIR}/${1}" "${BACKUP_DIR}/${1}" || restore_previous "$1"
  }
  # The renames take moments. A signal in the middle would end the run with
  # the old files parked beside half of the new ones, so it waits for them.
  trap '' INT TERM
  # The new package may not ship these, so they cannot wait for a staged
  # entry of the same name to replace them.
  move_aside web
  move_aside "Open OperaLibre.app"
  move_aside "Stop OperaLibre.app"
  for entry in "$STAGE_DIR"/* "$STAGE_DIR"/.[!.]*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    move_aside "$name"
    mv "$entry" "${INSTALL_DIR}/${name}" || restore_previous "$name"
    printf '%s\n' "$name" >>"$MOVED_IN_LIST"
  done
  rm -rf "$BACKUP_DIR"
  BACKUP_DIR=""
  rmdir "$STAGE_DIR" 2>/dev/null || true
  STAGE_DIR=""
  trap 'exit 130' INT TERM
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
if [ -f "$pid_file" ]; then
  pid=$(cat "$pid_file")
  # A PID left behind by a crash can be recycled by the OS, so only treat it
  # as running when it is actually this installation's server.
  case "$(ps -p "$pid" -o args= 2>/dev/null)" in
    *operalibre-server*)
      echo "OperaLibre is already running (process ${pid})."
      exit 0
      ;;
  esac
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
# A PID left behind by a crash can be recycled by the OS. Never signal a
# process that is not this installation's server.
case "$(ps -p "$pid" -o args= 2>/dev/null)" in
  *operalibre-server*) ;;
  *)
    echo "OperaLibre is not running."
    rm -f "$pid_file"
    exit 0
    ;;
esac
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
rm -f "$pid_file"
STOP_HELPER

  chmod +x "${INSTALL_DIR}/start-operalibre.sh" "${INSTALL_DIR}/stop-operalibre.sh"
fi

set_config() {
  # set_config KEY VALUE
  #
  # The server lowercases config keys and reads `-` as `_`, so `library-root`
  # and `LIBRARY_ROOT` name the same setting as `library_root`. Match every
  # spelling and keep a single line for the key, otherwise a rewritten file
  # would carry two entries that disagree.
  config="${INSTALL_DIR}/server.config"
  [ -f "$config" ] || return 0
  CONFIG_KEY=$1 CONFIG_VALUE=$2 awk '
    BEGIN {
      key = ENVIRON["CONFIG_KEY"]
      value = ENVIRON["CONFIG_VALUE"]
      pattern = key
      gsub(/[-_]/, "[-_]", pattern)
      pattern = "^[[:space:]]*" pattern "[[:space:]]*="
      written = 0
    }
    tolower($0) ~ pattern {
      if (written == 0) { print key " = " value; written = 1 }
      next
    }
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

PORT=$(configured_port)

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
    server_answers && started=1 && break
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
  say "Check $(configured_data_dir)/server.log, then start it again with:"
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
