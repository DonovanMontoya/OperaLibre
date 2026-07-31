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

1. Install Libation on the OperaLibre server and configure `libation_cli_path` (or place the CLI on `PATH`).
2. Sign in to OperaLibre as an administrator, open **Audible**, and choose **Add account**.
3. Enter a friendly label, Audible email, and marketplace. Complete Amazon's sign-in in the external browser, then paste the final browser URL back into OperaLibre. The installed iOS and Android apps use the device's secure browser view; the Audible password is entered only on Amazon's page.
4. Repeat for every Audible account the server should browse. OperaLibre creates an isolated Libation profile for each account under `data_dir/libation-accounts`, preserving duplicate ownership across accounts.

An existing desktop-managed Libation profile can still be connected with `libation_files_dir`. It is treated as a legacy shared profile; because Libation's shared database stores only one ownership row per book, duplicate ownership is guaranteed only for accounts added as isolated OperaLibre-managed profiles.

## Configuration

In `server.config`:

```config
libation_cli_path = /path/to/libationcli
libation_files_dir = /path/to/LibationFiles
```

- `libation_cli_path` — absolute path to the Libation CLI executable. If left blank, the server searches `PATH` for `libationcli`, `LibationCli`, or `libationcli.exe`.
- `libation_files_dir` — optional legacy Libation files directory containing `AccountsSettings.json` and `Settings.json`. Accounts added in OperaLibre use isolated directories under `data_dir/libation-accounts` instead.

If both are blank, the integration stays disabled.

## What the web UI exposes

When configured, an admin sees Libation-aware controls:

- **Status** — which accounts Libation has, and whether they look authenticated.
- **Accounts** — administrators can add or reconnect server-wide Audible accounts; owners can remove managed accounts.
- **Account browsing** — filter or sort by account. **All accounts** keeps duplicate titles visible as separate, account-badged entries.
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
- **Account shows as not authenticated** — administrators can choose **Sign in** or **Reconnect** beside the account. A warning badge appears on Audible and, in installed apps, on the Shelf tab.
- **Downloads land somewhere the server can't see** — point Libation's output directory at `library_root` (or a subdirectory of it), or move the files there after the download. The server only knows about files inside `library_root`.

## Security note

The integration runs a local executable. Administrators can add accounts and trigger acquisition, so grant that role only to trusted people. Audible passwords are never sent to OperaLibre, but the final authentication response URL passes through the server once and Libation stores long-lived identity tokens inside the account's private profile directory. Use HTTPS outside a trusted LAN/VPN, never log request bodies, and protect the server's `data_dir` as credential-bearing storage.
