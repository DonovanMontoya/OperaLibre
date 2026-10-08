---
title: Libation / Audible Import
nav_order: 8
---

# Libation / Audible Import

The server can drive a local [Libation](https://github.com/rmcrackan/Libation) install as an optional acquisition pipeline. This lets you list your Audible library, trigger liberation of a chosen ASIN, and rescan the audiobook folder when the file lands — all from the web UI.

This integration is entirely optional. If you don't configure it, the relevant UI is hidden and the server runs as a pure local library.

## Prerequisites

- Libation must be **installed** on the same machine as the server (or somewhere the server process can execute).
- On Linux, the system ICU runtime is required (a versioned `libicu` package on Ubuntu/Debian, `libicu` on Fedora/RHEL, or `icu-libs` on Alpine). If it is missing, the one-line installer offers to install the correct package with administrator access and verifies it before completing Libation setup.
- A recent Libation CLI with `login-external` and `list-accounts` support is required for the installer's guided sign-in and account discovery. Existing authenticated Libation profiles remain supported.
- OperaLibre stages server-requested downloads inside `library_root`; the server needs write access there.

## Set it up

The [one-line installer](installing-a-release.md#setting-up-the-audible-import-during-install) can install Libation, configure its settings folder, and guide you through signing in to Audible. Accept its optional sign-in prompt to launch Libation directly during setup. After a successful sign-in, continue from step 4 below. If you skip sign-in, the installer prints a command with the correct paths to connect later.

1. Install Libation on the OperaLibre server and configure `libation_cli_path` (or place the CLI on `PATH`).
2. Add every Audible account the server should browse in Libation itself, using its account settings or the installer's guided sign-in. You can also connect an account from OperaLibre using the browser sign-in below.
3. Point OperaLibre at that Libation installation with `libation_files_dir`, the directory holding `AccountsSettings.json` and `Settings.json`.
4. Sign in to OperaLibre as an administrator. In installed apps, open **Settings → Book stores → Audible**; on the web, open **Get books → Audible**. OperaLibre checks Libation, browser sign-in support, and library storage automatically. Existing Libation accounts appear automatically; choose **Manage** on the web to change their settings. Use **Check setup** in account management to check the server again.

### Connect or reconnect an account

Choose **Connect Audible**, enter a short account label, your Audible login, and
its marketplace, then continue to Amazon. Open the sign-in link in your browser.
After signing in, copy the complete final address from the address bar and paste
it into OperaLibre to finish connecting. Amazon may show a blank page or an
address that cannot open; that final address is still needed by Libation.
OperaLibre never asks for your Amazon password.

Choose **Reconnect** on an existing account when its sign-in expires. Accounts
configured directly in Libation keep their existing settings folder. Accounts
added in OperaLibre use a private profile on the server. If browser sign-in is
unavailable, update Libation or sign in through Libation on the server instead.

An unfinished sign-in can be continued after reloading OperaLibre. Cancel it if
you do not intend to finish; it expires automatically after ten minutes. Libation
runs one operation at a time, so finish downloads or refreshes before signing in.
Once connected, your purchases refresh in the background. Owners can disconnect
accounts added in OperaLibre; downloaded books and listening progress are kept.

### Automatically import future purchases

An administrator with direct-download permission can turn on **Automatically add
new purchases** for each account. OperaLibre remembers the catalog at that point,
then adds new purchases after a successful automatic or manual refresh. Existing
purchases and Audible Plus titles remain manual. Turn the option off to stop
future automatic imports; downloads already queued continue.

Automatic imports use the same free-space and per-title size limits as manual
imports. They do not change reader shelf permissions, and stop starting new work
if the administrator who enabled them loses direct-download or administrator
access. With automatic refresh disabled, a manual refresh still checks for new
purchases.

Queued and interrupted imports resume after a server restart, once the local
library is ready. An unfinished title starts again; completed local titles are
reused. Approved reader requests keep their approval and grant the requesting
reader access only after the import succeeds. Failed approved requests can be
retried without a second approval.

Libation's shared database stores only one ownership row per book. When OperaLibre refreshes a shared Libation installation, it first remembers the owners already in Libation's database, then scans each account separately and remembers which titles each account reported. A title owned by multiple accounts then appears under each account, including when another account later needs to sign in again. A newly connected account needs a successful refresh before its ownership can be remembered.

**Add all purchases to server** scans one account at a time and downloads its titles individually. If one account needs to sign in again, the job reports that failure while continuing with the other accounts. Libation has no account selector for downloads, so OperaLibre supplies only the ASINs confirmed for the account it just scanned.

OperaLibre asks Libation to create MP4/M4B downloads with faststart, so streaming
can begin without fetching the end of the file first. This applies to manual and
automatic imports without changing your saved Libation settings. Older files can
still be optimized under **Administration → Downloaded books → Faststart conversion**.

## Configuration

In `server.config`:

```config
libation_cli_path = /path/to/libationcli
libation_files_dir = /path/to/LibationFiles
```

- `libation_cli_path` — absolute path to the Libation CLI executable. If left blank, the server searches `PATH` for `libationcli`, `LibationCli`, or `libationcli.exe`.
- `libation_files_dir` — the Libation files directory containing `AccountsSettings.json` and `Settings.json`, where the accounts you add in Libation live. Existing managed accounts keep using their isolated directories under `data_dir/libation-accounts`.

The integration is available when the server finds the CLI at the configured path or on `PATH`. Leaving both values blank does not disable a CLI found on `PATH`.

Server-requested downloads use `max_upload_gib` as a per-title ceiling, including temporary download and decryption files. `min_download_free_gib` protects the library volume; OperaLibre checks before each title, while it runs, and before publishing the finished files. These limits apply to direct readers, approved requests, and administrators, including **Add all purchases to server**. A title already present is reused rather than downloaded again.

Downloads are staged out of view of library scans, then published together when successful. Failed or over-budget attempts are removed. Libation does not supply a reliable size in advance: the free-space watchdog leaves an additional 64 MiB of headroom and checks every 100 ms, but is not a filesystem quota. Use a filesystem quota when a strict disk-consumption boundary is required. Downloads that stop for storage limits appear as failed background jobs; free space or adjust the limits before retrying.

## What the web UI exposes

When configured, an admin sees Libation-aware controls:

- **Status** — which accounts Libation has, and whether they look authenticated.
- **Accounts** — connect or reconnect Audible, view account health and refresh times, rename accounts added in OperaLibre, and choose automatic imports. Owners can disconnect accounts added in OperaLibre.
- **Account browsing** — filter or sort by account label. **All accounts** keeps duplicate titles visible as separate entries carrying their friendly account label.
- **Library** — the Audible library Libation knows about; it loads automatically when the Audible tab opens.
- **Refresh Audible** — ask Libation to check Audible for new purchases. The server also refreshes every 24 hours by default. Administrators can refresh at any time; reader accounts get three refreshes per rolling hour by default.
- **Add to server** — add a selected Audible title to the OperaLibre library. Progress shows as a background job.
- **Rescan** — automatic after a successful download; can also be triggered manually.

In the installed iOS, Android, and macOS apps, readers and administrators can browse the Audible catalog. Each reader defaults to **Approval required**. Under **Administration → Users & access**, administrators can change reader download access, while owners can also configure administrators. Owners separately choose which administrators may approve requests. Approval-required accounts submit a per-title request; an authorized administrator or owner other than the requester decides it under **Administration → Requests**. An approved or direct reader download is automatically added to a restricted shelf.

Under the hood these map to API endpoints:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/libation/status` | Account/auth state, refresh time, automatic-import settings, and unfinished sign-in |
| `GET /api/libation/setup` | Installation, browser sign-in support, and storage checks (administrator only) |
| `PUT /api/libation/accounts/{profile_id}/auto-import` | Enable or disable future automatic imports (administrator with direct access) |
| `GET /api/libation/books` | Account-aware Libation catalog; duplicate ownership stays visible |
| `POST /api/libation/sync` | Tell Libation to refresh its library; available to authenticated readers, with the configured hourly limit applied to non-administrators |
| `POST /api/libation/accounts/{profile_id}/books/{asin}/liberate` | Download a title from the selected Audible account when the reader has direct permission |
| `POST /api/libation/books/{asin}/liberate` | Older ASIN-only route; requires an account choice when several accounts are configured |
| `GET /api/libation/access` | Current reader's Libation policy and availability |
| `GET /api/libation/requests` | Own requests, or all requests for an authorized approver |
| `POST /api/libation/requests/{asin}` | Request approval for one title |
| `PUT /api/libation/requests/{request_id}/decision` | Approve or decline another account's request (approval permission required) |
| `GET /api/jobs/{job_id}` | Poll a background liberation job |
| `POST /api/library/rescan` | Re-scan `library_root` |

The same account controls are available through the [API Reference](api.md#libation-optional).

## Troubleshooting

- **"Libation not configured"** — `libation_cli_path` is blank and no Libation CLI is on `PATH`. Set the path explicitly.
- **Account shows as not authenticated** — choose **Reconnect**, or sign the account in again in Libation on the server computer. A warning badge appears on Audible and, in installed apps, on the Shelf tab.
- **An account created by an older OperaLibre build reports missing Libation settings** — restart the updated OperaLibre server once. The server repairs the managed account profile before starting Libation.
- **Downloads made outside OperaLibre do not appear** — move those files into `library_root` and rescan. Server-requested downloads are staged and published there automatically.
- **Libation reports that no region is associated with the Invariant Culture** — install the ICU runtime listed under Prerequisites, restart OperaLibre, and retry the download. Do not set `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1`; Libation needs full culture and region data when preparing a download.

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

The integration runs a local executable. Administrators can trigger acquisition and API clients can manage Audible sign-ins, so grant that role only to trusted people. Audible passwords are entered on Amazon's website. The installer's sign-in passes the final response URL directly to Libation; managed-account API sign-in passes it through OperaLibre once. Libation stores long-lived identity tokens in its private profile directory. Use HTTPS outside a trusted LAN/VPN, never log request bodies, and protect the Libation settings folder and server's `data_dir` as credential-bearing storage.
