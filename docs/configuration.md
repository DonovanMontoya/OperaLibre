---
title: Configuration
nav_order: 4
---

# Configuration

The server is configured by a plain text file named `server.config` at the repository root. All settings live here — there is no admin UI for these values. Every key also has an environment-variable fallback (listed [below](#environment-variables)); the config file always wins when both are set.

## File location

By default the server reads `./server.config` (relative to the working directory the server is launched from). To point at a different file, set the `OPERALIBRE_SERVER_CONFIG` environment variable:

```bash
OPERALIBRE_SERVER_CONFIG=/etc/operalibre/server.config \
  ./apps/server/target/release/operalibre-server
```

Relative paths inside the config (like `data_dir = data`) are resolved against the **directory containing the config file**, not the current working directory. This means you can drop a config file anywhere and its data paths follow it.

## File format

A simple `key = value` format. One key per line. Blank lines and `#` comments are ignored.

```config
# This is a comment.
deployment_mode = local
host =
port = 4000
max_upload_gib = 20
max_book_download_gib = 25
max_concurrent_book_downloads = 1
download_temp_dir = data/download-temp
min_download_free_gib = 2
library_root = /path/to/audiobooks
```

Whitespace around keys and values is trimmed, and a value wrapped in matching single or double quotes has the quotes stripped. Keys are case-insensitive and accept `-` in place of `_` (`max-upload-gib` works). An empty value is treated as unset, so `host =` falls back to the profile default.

An unknown key is a **startup error**, not a warning — a typo or a setting from a different version stops the server with a message naming the line.

## Full example

```config
# Deployment profile and optional advanced bind override.
deployment_mode = local
host =
port = 4000

# Transfer resource limits.
max_upload_gib = 20
max_book_download_gib = 25
max_concurrent_book_downloads = 1
download_temp_dir = data/download-temp
min_download_free_gib = 2

# Extra trusted cross-origin frontends (comma-separated).
allowed_origins =

# Folder containing your audiobook files.
library_root = /Users/you/Audiobooks

# Server data directory and legacy JSON import paths.
data_dir = data
progress_file = data/progress.json
users_file = data/users.json

# Serve the web app and API from the same address after `npm run build`.
web_dist_dir = apps/web/dist

# Optional Libation / Audible import.
libation_cli_path =
libation_files_dir =
libation_auto_refresh_hours = 24
libation_reader_refreshes_per_hour = 3

# Optional EPUB narration alignment.
alignment_cli_path =

# Optional MP4 faststart conversion.
ffmpeg_path =
ffprobe_path =
```

## Reference

### Network

| Key | Default | Description |
| --- | --- | --- |
| `deployment_mode` | `local` | `local` binds to loopback with HTTPS-grade cookies; `lan` listens on all interfaces and permits plain-HTTP cookies for a trusted LAN/VPN; `proxy` binds to loopback and expects a same-machine HTTPS reverse proxy. |
| `host` | chosen by profile | Optional advanced bind override. Must be a numeric IP address, not a hostname. `local` and `proxy` require a loopback address; `lan` defaults to `0.0.0.0`. When upgrading an older config without `deployment_mode`, a non-loopback `host` is inferred as `lan` for compatibility. |
| `port` | `4000` | TCP port the API listens on. |
| `allowed_origins` | *(empty)* | Comma-separated list of trusted custom frontend origins, e.g. `https://reader.example.com`. These origins receive credentialed CORS access and may make cookie-authenticated changes, so do not list sites you do not control. Same-origin requests and the official app origins need no configuration. |

### Transfer limits

| Key | Default | Description |
| --- | --- | --- |
| `max_upload_gib` | `20` | Maximum total size of one web-uploaded audiobook. Set to `0` only to delegate storage-exhaustion control to another trusted layer. |
| `max_book_download_gib` | `25` | Maximum source size that may be assembled into a temporary ZIP download. Set to `0` only when disk usage is constrained externally. |
| `max_concurrent_book_downloads` | `1` | Simultaneous ZIP preparations/downloads. Accepted range: `1`–`32`. Each active archive can consume temporary disk space up to its book size. |
| `download_temp_dir` | `data/download-temp` | Private staging directory for ZIP downloads. Put this on a data volume rather than a small operating-system temporary filesystem. Incomplete and completed archives are removed when their response ends. |
| `min_download_free_gib` | `2` | Free space that must remain on the staging volume after a new archive is prepared. Set to `0` only when the volume is constrained and monitored elsewhere. |

When nginx is used, its `client_max_body_size` is an additional upload ceiling. Increase both that directive and `max_upload_gib` when deliberately supporting larger uploads.

### Library

| Key | Default | Description |
| --- | --- | --- |
| `library_root` | `library` | Path to the folder containing your audiobook files; a relative path resolves against the folder holding `server.config`, and the default is a `library` folder in the server's working directory. Set it explicitly in any real installation. The scanner reads from this folder; the web uploader writes new books into it. See [Library Layout](library-layout.md). The key `audiobook_library` is accepted as a legacy alias. |

### Data directory

The server keeps its state — accounts, sessions, listening progress, the reading log, completions, the work index, metadata overrides, and Libation requests — in one SQLite database, `operalibre.db`, inside `data_dir`. The directory also holds generated sync maps (`sync/`), cached cover art (`covers/`), the server log and PID file written by the launcher, and `update-backups/` from in-app updates. The release launchers and the installer read `data_dir` from `server.config` too, so moving it relocates all of those files together. On Unix, everything in it is kept readable only by the account running the server.

| Key | Default | Description |
| --- | --- | --- |
| `data_dir` | `data` | Directory holding the database and the server's working files. Created if missing. |
| `progress_file` | `data/progress.json` | Legacy JSON path for playback positions, used once to import an older installation. |
| `users_file` | `data/users.json` | Legacy JSON path for accounts, used once to import an older installation. |
| `activity_file` | `data/activity.json` | Legacy JSON path for daily listening totals, used once to import an older installation. |
| `metadata_overrides_file` | `data/metadata-overrides.json` | Legacy JSON path for saved metadata edits, used once to import an older installation. |

The three `*_file` keys and their siblings matter only when upgrading an installation that predates the database: on first start the server copies the JSON files into `data/backup-pre-sqlite/`, imports them into `operalibre.db` in a single transaction, and never reads them again. The originals are left in place as the rollback path. Running the binary with `--export-json` writes the database contents back out in the original JSON layout and exits, which is also the supported way to inspect or hand-edit server state: export, remove `operalibre.db`, edit the JSON, and restart to re-import.

Back up `data_dir` to preserve progress, reading history, and accounts. The completion records in the database are the only history of a book that has since been deleted from the library.

### Web app

| Key | Default | Description |
| --- | --- | --- |
| `web_dist_dir` | *(empty)* | Path to a built web bundle (the `apps/web/dist` folder produced by `npm run build`). When set, the server serves the frontend itself: any path that is not an `/api/...` route returns the bundle's files, with unknown paths falling back to `index.html` for client-side routing. This gives a single-origin deployment with no reverse proxy and no CORS concerns. |

### Optional Libation integration

Leave both blank to disable. See [Libation / Audible Import](libation.md) for the full integration guide.

| Key | Default | Description |
| --- | --- | --- |
| `libation_cli_path` | *(empty)* | Absolute path to the Libation CLI binary (`libationcli`, `LibationCli`, or `libationcli.exe`). If blank, the server searches `PATH`. |
| `libation_files_dir` | *(empty)* | Optional legacy Libation files directory containing `AccountsSettings.json` and `Settings.json`. Accounts added by an administrator in OperaLibre are stored as isolated profiles under `data_dir/libation-accounts`. |
| `libation_auto_refresh_hours` | `24` | How often the server asks Libation to scan Audible automatically. The first scan runs at startup when no previous successful scan is recorded. Set to `0` to disable scheduled scans. |
| `libation_reader_refreshes_per_hour` | `3` | Maximum reader-triggered Audible scans per account in a rolling hour. Administrators are not limited. Set to `0` to remove the reader rate limit. |

### Optional readalong alignment

Leave this blank to search `PATH` for echogarden. When echogarden is unavailable, automatic generation is disabled but user-provided `.sync.json` sidecars still work. See [Library Layout](library-layout.md#sync-maps-sentence-highlighting) for the sync-map workflow.

| Key | Default | Description |
| --- | --- | --- |
| `alignment_cli_path` | *(empty)* | Path to the echogarden CLI. Administrators can use it to generate sentence-level EPUB narration sync maps from the readalong pane. |

### Optional MP4 faststart conversion

MP4-family files written without a leading `moov` index start playing slowly over a network. Administrators can remux them in place from **Administration → Downloaded books**; the control needs ffmpeg, and uses ffprobe to verify each converted file before it replaces the original. Leave both blank to search `PATH`; without ffmpeg the control simply reports itself unavailable.

| Key | Default | Description |
| --- | --- | --- |
| `ffmpeg_path` | *(empty)* | Path to the ffmpeg binary used for faststart conversion. |
| `ffprobe_path` | *(empty)* | Path to the ffprobe binary used to verify converted files. |

## Environment variables

Every config key has an environment-variable fallback. A value in `server.config` always takes precedence; the variable is read only when the key is absent or empty.

| Variable | Description |
| --- | --- |
| `OPERALIBRE_SERVER_CONFIG` | Path to the config file itself. When set, a missing file is a startup error (the default `./server.config` is allowed to be absent). |
| `OPERALIBRE_DEPLOYMENT_MODE` | Fallback for `deployment_mode`. |
| `HOST`, `PORT` | Fallbacks for `host` and `port`. |
| `OPERALIBRE_LIBRARY` | Fallback for `library_root`. |
| `OPERALIBRE_DATA_DIR` | Fallback for `data_dir`. |
| `OPERALIBRE_PROGRESS_FILE`, `OPERALIBRE_USERS_FILE`, `OPERALIBRE_ACTIVITY_FILE`, `OPERALIBRE_METADATA_OVERRIDES_FILE` | Fallbacks for the legacy import paths. |
| `OPERALIBRE_DOWNLOAD_TEMP_DIR` | Fallback for `download_temp_dir`. |
| `OPERALIBRE_ALLOWED_ORIGINS` | Fallback for `allowed_origins`. |
| `OPERALIBRE_WEB_DIST_DIR` | Fallback for `web_dist_dir`. |
| `OPERALIBRE_ALIGNMENT_CLI_PATH` | Fallback for `alignment_cli_path`. |
| `OPERALIBRE_FFMPEG_PATH`, `OPERALIBRE_FFPROBE_PATH` | Fallbacks for `ffmpeg_path` and `ffprobe_path`. |
| `LIBATION_CLI_PATH`, `LIBATION_FILES_DIR` | Fallbacks for `libation_cli_path` and `libation_files_dir` (note: no `OPERALIBRE_` prefix). |
| `RUST_LOG` | Log filter; defaults to `operalibre_server=info,tower_http=info`. |

The web app has one build-time variable:

| Variable | Description |
| --- | --- |
| `VITE_API_BASE` | Base URL the web app uses for API calls when not running behind the Vite dev proxy (e.g., a Capacitor iOS build pointing at a remote server). |

`VITE_API_BASE` is read at **build time** by Vite. Set it before running `npm run build`:

```bash
VITE_API_BASE=https://books.example.com npm run build
```

## Reloading config

The config is read at server startup. Edit the file, then restart the server. There is no SIGHUP reload yet.
