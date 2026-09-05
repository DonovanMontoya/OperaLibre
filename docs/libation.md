---
title: Libation / Audible Import
nav_order: 8
---

# Libation / Audible Import

The server can drive a local [Libation](https://github.com/rmcrackan/Libation) install as an optional acquisition pipeline. This lets you list your Audible library, trigger liberation of a chosen ASIN, and rescan the audiobook folder when the file lands — all from the web UI.

This integration is entirely optional. If you don't configure it, the relevant UI is hidden and the server runs as a pure local library.

## Prerequisites

- Libation must be **installed** on the same machine as the server (or somewhere the server process can execute).
- A recent Libation CLI with `login-external` and `list-accounts` support is required for adding accounts through OperaLibre. Existing authenticated Libation profiles remain supported.
- Libation's download directory must point at (or feed into) your `library_root`.

## Set it up

The [one-line installer](installing-a-release.md#one-line-install-on-macos-and-linux) can do steps 1 and 2 of the prerequisites for you: it finds an existing Libation or downloads the official release into a `libation` folder inside your OperaLibre installation, then fills in `libation_cli_path`. Continue from step 2 below afterwards.

1. Install Libation on the OperaLibre server and configure `libation_cli_path` (or place the CLI on `PATH`).
2. Add every Audible account the server should browse in Libation itself, using Libation's own account settings. Accounts are not added from inside OperaLibre.
3. Point OperaLibre at that Libation installation with `libation_files_dir`, the directory holding `AccountsSettings.json` and `Settings.json`.
4. Sign in to OperaLibre as an administrator and open **Audible**. The accounts Libation knows about appear in the account list with their connection status, and the **Browsing** filter narrows the catalog to one of them.

Because Libation's shared database stores only one ownership row per book, a title owned by more than one account in the same Libation installation is recorded once. Accounts created as isolated OperaLibre-managed profiles under `data_dir/libation-accounts` preserve duplicate ownership, but those are no longer created from the OperaLibre interface.

## Configuration

In `server.config`:

```config
libation_cli_path = /path/to/libationcli
libation_files_dir = /path/to/LibationFiles
```

- `libation_cli_path` — absolute path to the Libation CLI executable. If left blank, the server searches `PATH` for `libationcli`, `LibationCli`, or `libationcli.exe`.
- `libation_files_dir` — the Libation files directory containing `AccountsSettings.json` and `Settings.json`, where the accounts you add in Libation live. Accounts created by older OperaLibre builds keep using their isolated directories under `data_dir/libation-accounts`.

If both are blank, the integration stays disabled.

## What the web UI exposes

When configured, an admin sees Libation-aware controls:

- **Status** — which accounts Libation has, and whether they look authenticated.
- **Accounts** — administrators can add or reconnect server-wide Audible accounts; owners can remove managed accounts.
- **Account browsing** — filter or sort by account label. **All accounts** keeps duplicate titles visible as separate entries carrying their friendly account label.
- **Library** — the Audible library Libation knows about; it loads automatically when the Audible tab opens.
- **Refresh Audible** — ask Libation to check Audible for new purchases. The server also refreshes every 24 hours by default. Administrators can refresh at any time; reader accounts get three refreshes per rolling hour by default.
- **Download** — add a selected Audible title to the OperaLibre library. Progress shows as a background job.
- **Rescan** — automatic after a successful download; can also be triggered manually.

In the installed iOS, Android, and macOS apps, readers and administrators can browse the Audible catalog. Each reader defaults to **Approval required**. Under **Administration → Users & access**, administrators can change reader download access, while owners can also configure administrators. Owners separately choose which administrators may approve requests. Approval-required accounts submit a per-title request; an authorized administrator or owner other than the requester decides it under **Administration → Requests**. An approved or direct reader download is automatically added to a restricted shelf.

Under the hood these map to API endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/libation/status` | Account/auth state |
| `POST /api/libation/accounts/login/start` | Start an administrator-managed Audible browser login |
| `POST /api/libation/accounts/login/{session_id}/complete` | Finish login with the final Amazon/Audible URL |
| `GET /api/libation/books` | Account-aware Libation catalog; duplicate ownership stays visible |
| `POST /api/libation/sync` | Tell Libation to refresh its library; available to authenticated readers, with the configured hourly limit applied to non-administrators |
| `POST /api/libation/books/{asin}/liberate` | Download one title when the reader has direct permission |
| `GET /api/libation/access` | Current reader's Libation policy and availability |
| `GET /api/libation/requests` | Own requests, or all requests for an authorized approver |
| `POST /api/libation/requests/{asin}` | Request approval for one title |
| `PUT /api/libation/requests/{request_id}/decision` | Approve or decline another account's request (approval permission required) |
| `GET /api/jobs/{job_id}` | Poll a background liberation job |
| `POST /api/library/rescan` | Re-scan `library_root` |

## Troubleshooting

- **"Libation not configured"** — `libation_cli_path` is blank and no Libation CLI is on `PATH`. Set the path explicitly.
- **Account shows as not authenticated** — sign the account in again in Libation. OperaLibre reports the status but no longer signs accounts in itself. A warning badge appears on Audible and, in installed apps, on the Shelf tab.
- **An account created by an older OperaLibre build reports missing Libation settings** — restart the updated OperaLibre server once. The server repairs the managed account profile before starting Libation.
- **Downloads land somewhere the server can't see** — point Libation's output directory at `library_root` (or a subdirectory of it), or move the files there after the download. The server only knows about files inside `library_root`.

## Rich local metadata

When Libation saves its raw Audible metadata beside an audiobook as a
`.metadata.json` sidecar, OperaLibre reads it during each library rescan. This
fills in richer catalog information — including series and series number,
genres, contributors, description, publisher, language, dates, and ASIN — even
when the audio container has incomplete tags. Manual metadata edits made in
OperaLibre always take precedence over the sidecar.

Series and genre are searchable in the local library and can be selected as
library sort orders.

## Security note

The integration runs a local executable. Administrators can add accounts and trigger acquisition, so grant that role only to trusted people. Audible passwords are never sent to OperaLibre, but the final authentication response URL passes through the server once and Libation stores long-lived identity tokens inside the account's private profile directory. Use HTTPS outside a trusted LAN/VPN, never log request bodies, and protect the server's `data_dir` as credential-bearing storage.
