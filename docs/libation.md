---
title: Libation / Audible Import
nav_order: 8
---

# Libation / Audible Import

The server can drive a local [Libation](https://github.com/rmcrackan/Libation) install as an optional acquisition pipeline. This lets you list your Audible library, trigger liberation of a chosen ASIN, and rescan the audiobook folder when the file lands — all from the web UI.

This integration is entirely optional. If you don't configure it, the relevant UI is hidden and the server runs as a pure local library.

## Prerequisites

- Libation must be **installed** on the same machine as the server (or somewhere the server process can execute).
- Libation must be **authenticated** with your Audible account(s). The server does not handle Audible login itself — it just shells out to Libation.
- Libation's download directory must point at (or feed into) your `library_root`.

## Set it up

1. Install Libation and sign in to Audible in the Libation desktop app. OperaLibre never receives your Audible password.
2. In Libation’s settings, set the download location to your OperaLibre `library_root` folder, or to a folder inside it. This is what lets OperaLibre find a completed book.
3. Find the Libation CLI executable and its **LibationFiles** folder. The latter contains `AccountsSettings.json` and `Settings.json`.
4. Add both full paths to `server.config` and restart OperaLibre.

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
- **Library** — the Audible library Libation knows about; it loads automatically when the Audible tab opens.
- **Refresh Audible** — ask Libation to check Audible for new purchases.
- **Download** — add a selected Audible title to the OperaLibre library. Progress shows as a background job.
- **Rescan** — automatic after a successful download; can also be triggered manually.

In the installed iOS, Android, and macOS apps, readers and administrators can browse the Audible catalog. Each reader defaults to **Approval required**. Under **Administration → Users & access**, administrators can change reader download access, while owners can also configure administrators. Owners separately choose which administrators may approve requests. Approval-required accounts submit a per-title request; an authorized administrator or owner other than the requester decides it under **Administration → Requests**. An approved or direct reader download is automatically added to a restricted shelf.

Under the hood these map to API endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/libation/status` | Account/auth state |
| `GET /api/libation/books` | Libation's known library |
| `POST /api/libation/sync` | Tell Libation to refresh its library |
| `POST /api/libation/books/{asin}/liberate` | Download one title when the reader has direct permission |
| `GET /api/libation/access` | Current reader's Libation policy and availability |
| `GET /api/libation/requests` | Own requests, or all requests for an authorized approver |
| `POST /api/libation/requests/{asin}` | Request approval for one title |
| `PUT /api/libation/requests/{request_id}/decision` | Approve or decline another account's request (approval permission required) |
| `GET /api/jobs/{job_id}` | Poll a background liberation job |
| `POST /api/library/rescan` | Re-scan `library_root` |

## Troubleshooting

- **"Libation not configured"** — `libation_cli_path` is blank and no Libation CLI is on `PATH`. Set the path explicitly.
- **Account shows as not authenticated** — open the Libation desktop app, complete the Audible login flow, then refresh the status from the web UI.
- **Downloads land somewhere the server can't see** — point Libation's output directory at `library_root` (or a subdirectory of it), or move the files there after the download. The server only knows about files inside `library_root`.

## Security note

The integration runs a local executable. Don't expose your server to the public internet while Libation is wired in unless you trust everyone with an account — anyone with admin can trigger a liberation.
