---
title: Libation / Audible Import
nav_order: 6
---

# Libation / Audible Import

The server can drive a local [Libation](https://github.com/rmcrackan/Libation) install as an optional acquisition pipeline. This lets you list your Audible library, trigger liberation of a chosen ASIN, and rescan the audiobook folder when the file lands — all from the web UI.

This integration is entirely optional. If you don't configure it, the relevant UI is hidden and the server runs as a pure local library.

## Prerequisites

- Libation must be **installed** on the same machine as the server (or somewhere the server process can execute).
- Libation must be **authenticated** with your Audible account(s). The server does not handle Audible login itself — it just shells out to Libation.
- Libation's download directory must point at (or feed into) your `library_root`.

## Configuration

In `server.config`:

```config
libation_cli_path = /path/to/libationcli
libation_files_dir = /path/to/LibationFiles
```

- `libation_cli_path` — absolute path to the Libation CLI executable. If left blank, the server searches `PATH` for `libationcli`, `LibationCli`, or `libationcli.exe`.
- `libation_files_dir` — the Libation files directory containing `AccountsSettings.json` and `Settings.json`. The server reads these to surface account state in the web UI (e.g., showing which accounts are no longer authenticated).

If both are blank, the integration stays disabled.

## What the web UI exposes

When configured, an admin sees Libation-aware controls:

- **Status** — which accounts Libation has, and whether they look authenticated.
- **Library** — the Audible library Libation knows about.
- **Sync** — re-run a Libation scan to refresh the remote library.
- **Liberate** — kick off a Libation download for a selected ASIN. Progress shows as a background job.
- **Rescan** — automatic after a successful download; can also be triggered manually.

Under the hood these map to API endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/libation/status` | Account/auth state |
| `GET /api/libation/books` | Libation's known library |
| `POST /api/libation/sync` | Tell Libation to refresh its library |
| `GET /api/jobs/{job_id}` | Poll a background liberation job |
| `POST /api/library/rescan` | Re-scan `library_root` |

## Troubleshooting

- **"Libation not configured"** — `libation_cli_path` is blank and no Libation CLI is on `PATH`. Set the path explicitly.
- **Account shows as not authenticated** — open the Libation desktop app, complete the Audible login flow, then refresh the status from the web UI.
- **Downloads land somewhere the server can't see** — point Libation's output directory at `library_root` (or a subdirectory of it), or move the files there after the download. The server only knows about files inside `library_root`.

## Security note

The integration runs a local executable. Don't expose your server to the public internet while Libation is wired in unless you trust everyone with an account — anyone with admin can trigger a liberation.
