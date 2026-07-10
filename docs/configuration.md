---
title: Configuration
nav_order: 3
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
host = 0.0.0.0
port = 4000
library_root = /path/to/audiobooks
```

Strings are not quoted. Trailing whitespace is trimmed.

## Full example

```config
# Network binding.
host = 0.0.0.0
port = 4000

# Folder containing your audiobook files.
library_root = /Users/you/Audiobooks

# Server data files.
data_dir = data
progress_file = data/progress.json
users_file = data/users.json

# Optional Libation / Audible import.
libation_cli_path =
libation_files_dir =

# Optional EPUB narration alignment.
alignment_cli_path =
```

## Reference

### Network

| Key | Default | Description |
| --- | --- | --- |
| `host` | `0.0.0.0` | Interface to bind to. Use `127.0.0.1` to restrict access to the local machine, or `0.0.0.0` to accept LAN connections. |
| `port` | `4000` | TCP port the API listens on. |
| `allowed_origins` | *(empty)* | Comma-separated list of origins allowed to make cross-origin (CORS) requests, e.g. `https://books.example.com, http://192.168.1.20:5173`. When empty, the server reflects any requesting origin — convenient for development and custom frontends, but set this before exposing the API outside a trusted network. |

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

### Optional readalong alignment

Leave this blank to search `PATH` for echogarden. When echogarden is unavailable, automatic generation is disabled but user-provided `.sync.json` sidecars still work. See [Library Layout](library-layout.md#sync-maps-sentence-highlighting) for the sync-map workflow.

| Key | Default | Description |
| --- | --- | --- |
| `alignment_cli_path` | *(empty)* | Path to the echogarden CLI. Administrators can use it to generate sentence-level EPUB narration sync maps from the readalong pane. |

## Environment variables

| Variable | Used by | Description |
| --- | --- | --- |
| `OPERALIBRE_SERVER_CONFIG` | server | Override the path to `server.config`. |
| `OPERALIBRE_ALIGNMENT_CLI_PATH` | server | Override the path to the echogarden CLI. |
| `VITE_API_BASE` | web | Base URL the web app uses for API calls when not running behind the Vite dev proxy (e.g., a Capacitor iOS build pointing at a remote server). |

`VITE_API_BASE` is read at **build time** by Vite. Set it before running `npm run build`:

```bash
VITE_API_BASE=https://books.example.com npm run build
```

## Reloading config

The config is read at server startup. Edit the file, then restart the server. There is no SIGHUP reload yet.
