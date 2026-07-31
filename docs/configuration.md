---
title: Configuration
nav_order: 4
---

# Configuration

The server is configured by a plain text file named `server.config` at the repository root. All settings live here — there is no separate database, environment-variable-driven config, or admin UI for these values.

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

Strings are not quoted. Trailing whitespace is trimmed.

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

# Folder containing your audiobook files.
library_root = /Users/you/Audiobooks

# Server data files.
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
```

## Reference

### Network

| Key | Default | Description |
| --- | --- | --- |
| `deployment_mode` | `local` | `local` binds to loopback with HTTPS-grade cookies; `lan` listens on all interfaces and permits plain-HTTP cookies for a trusted LAN/VPN; `proxy` binds to loopback and expects a same-machine HTTPS reverse proxy. |
| `host` | chosen by profile | Optional advanced bind override. `local` and `proxy` require a loopback address; `lan` defaults to `0.0.0.0`. When upgrading an older config without `deployment_mode`, a non-loopback `host` is inferred as `lan` for compatibility. |
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
| `library_root` | *(required)* | Absolute path to the folder containing your audiobook files. The scanner reads from this folder; nothing is written into it. See [Library Layout](library-layout.md). |

### Data files

The server keeps a small amount of state on disk: user accounts, listening progress, generated readalong sync maps, and any cached job output.

| Key | Default | Description |
| --- | --- | --- |
| `data_dir` | `data` | Directory used as the working area for cached data and background jobs. Created if missing. |
| `progress_file` | `data/progress.json` | JSON file storing per-user playback positions. |
| `users_file` | `data/users.json` | JSON file storing accounts and Argon2 password hashes. |

Back up `data_dir` to preserve progress and accounts.

### Web app

| Key | Default | Description |
| --- | --- | --- |
| `web_dist_dir` | *(empty)* | Path to a built web bundle (the `apps/web/dist` folder produced by `npm run build`). When set, the server serves the frontend itself: any path that is not an `/api/...` route returns the bundle's files, with unknown paths falling back to `index.html` for client-side routing. This gives a single-origin deployment with no reverse proxy and no CORS concerns. |

### Optional Libation integration

Leave both blank to disable. See [Libation / Audible Import](libation.md) for the full integration guide.

| Key | Default | Description |
| --- | --- | --- |
| `libation_cli_path` | *(empty)* | Absolute path to the Libation CLI binary (`libationcli`, `LibationCli`, or `libationcli.exe`). If blank, the server searches `PATH`. |
| `libation_files_dir` | *(empty)* | Path to the Libation files directory containing `AccountsSettings.json` and `Settings.json`. Required for the web app to surface account status. |
| `libation_auto_refresh_hours` | `24` | How often the server asks Libation to scan Audible automatically. The first scan runs at startup when no previous successful scan is recorded. Set to `0` to disable scheduled scans. |
| `libation_reader_refreshes_per_hour` | `3` | Maximum reader-triggered Audible scans per account in a rolling hour. Administrators are not limited. Set to `0` to remove the reader rate limit. |

### Optional readalong alignment

Leave this blank to search `PATH` for echogarden. When echogarden is unavailable, automatic generation is disabled but user-provided `.sync.json` sidecars still work. See [Library Layout](library-layout.md#sync-maps-sentence-highlighting) for the sync-map workflow.

| Key | Default | Description |
| --- | --- | --- |
| `alignment_cli_path` | *(empty)* | Path to the echogarden CLI. Administrators can use it to generate sentence-level EPUB narration sync maps from the readalong pane. |

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `OPERALIBRE_SERVER_CONFIG` | server | Override the path to `server.config`. |
| `OPERALIBRE_DEPLOYMENT_MODE` | server | Override the deployment profile with `local`, `lan`, or `proxy`. |
| `OPERALIBRE_DOWNLOAD_TEMP_DIR` | server | Override the ZIP-download staging directory. |
| `OPERALIBRE_ALIGNMENT_CLI_PATH` | server | Override the path to the echogarden CLI. |
| `VITE_API_BASE` | web | Base URL the web app uses for API calls when not running behind the Vite dev proxy (e.g., a Capacitor iOS build pointing at a remote server). |

`VITE_API_BASE` is read at **build time** by Vite. Set it before running `npm run build`:

```bash
VITE_API_BASE=https://books.example.com npm run build
```

## Reloading config

The config is read at server startup. Edit the file, then restart the server. There is no SIGHUP reload yet.
