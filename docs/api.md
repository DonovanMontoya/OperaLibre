---
title: API Reference
nav_order: 9
---

# API Reference

All endpoints are served by the Rust backend on `host:port` (default `127.0.0.1:4000`). With the exception of a small public surface, every endpoint requires an authenticated session. Public deployments must expose a TLS reverse proxy rather than this raw HTTP listener.

Browser clients that authenticate with the session cookie must send an `Origin` (or `Referer`) matching the API host for `POST`, `PUT`, and `DELETE` requests. Origins explicitly trusted through `allowed_origins` are also accepted. Native and other API clients should send the session with `Authorization: Bearer ...`; bearer-authenticated changes do not require browser CSRF headers.

The included React/Vite app is one client for this API. Custom web, mobile, desktop, or native frontends can use the same endpoints as long as they follow the authentication and media URL conventions below.

## Authentication

The web app obtains a session token and a separate scoped media token via `POST /api/auth/login`. Send the session token in `Authorization: Bearer ...` for API requests. Read-only cover, readalong, stream, and download endpoints accept the media token as a `?token=` query parameter so plain `<audio>` and `<img>` elements work without exposing a full API bearer token in URLs. `GET /api/auth/status` returns the current session's media token when authenticated.

### Public endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness probe. Returns `200 OK` when the server is up. |
| `GET` | `/api/auth/status` | Reports whether first-run setup is needed and whether this client needs a bootstrap token or local access. |
| `POST` | `/api/auth/setup` | One-time owner creation. Remote `lan` clients and every `proxy` client must send the current `setupToken`; `local` mode rejects remote setup. |
| `POST` | `/api/auth/login` | Exchange username + password for session and scoped media tokens. |

### Authenticated endpoints

#### Sessions and self

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/logout` | Invalidate the current session. |
| `GET` | `/api/auth/me` | Return the current user. |
| `GET` | `/api/profile/stats` | Listening stats for the current user. |

#### Server updates

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/update` | Compare the running version with the latest GitHub release. Admin only. Add `?refresh=true` to bypass the 15-minute metadata cache. |
| `POST` | `/api/update/install` | Download, verify, and stage the platform update, then restart a release-package installation (combined or server-only). Owner only. |

The status response reports `currentVersion`, `latestVersion`, `updateAvailable`, `canAutoUpdate`, `platform`, release details, and a message when manual installation is required. Automatic installation preserves user data, the audiobook library, and `server.config`; the external updater performs replacement and rollback after the server exits. Combined installations also receive the bundled web app and refreshed launchers; server-only installations (including those pointing `web_dist_dir` at a custom frontend) update just the server binary and leave the frontend untouched.

#### Web frontend updates

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/frontend-update` | Compare the browser frontend with the latest standalone frontend release. Admin only. Add `?refresh=true` to bypass the 15-minute metadata cache and `currentVersion=<semver>` when the frontend is hosted separately. |
| `POST` | `/api/frontend-update/install` | Download, verify, and install the standalone frontend package without restarting the server. Owner only. |

Frontend installation is available when the server directly serves a versioned web bundle from `web_dist_dir`. The existing bundle is copied to `data/update-backups` before replacement. Separately hosted frontends still report release availability but must be deployed through their hosting provider. Combined installations are also excluded: their web bundle ships inside the server release package, so the server update replaces it and a frontend-only install would let the two versions diverge.

#### User management (admin)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/users` | List accounts and their role/Libation permissions. |
| `POST` | `/api/users` | Create an account. Creating an admin or owner requires an owner. |
| `DELETE` | `/api/users/{user_id}` | Delete an account. Admin/owner targets require an owner; the final owner is protected. |
| `POST` | `/api/users/{user_id}/password` | Reset a password. Admin/owner targets require an owner. |
| `PUT` | `/api/users/{user_id}/book-access` | Set a reader's allowed book IDs. Send `{ "allowedBookIds": null }` for the full library or an array for a restricted shelf. |
| `PUT` | `/api/users/{user_id}/role` | Set owner/admin/reader status. Owner only. |
| `PUT` | `/api/users/{user_id}/libation-access` | Set direct or approval-required Libation access. Admin targets require an owner. |
| `PUT` | `/api/users/{user_id}/libation-approval` | Grant or revoke an administrator's request-approval permission. Owner only. |

#### Library

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/books` | List books the current user is allowed to access. Administrators always receive the full library. |
| `GET` | `/api/books/{book_id}` | Detailed metadata, tracks, and chapters for one book. |
| `GET` | `/api/books/{book_id}/cover` | Cover art image (extracted from tags or sidecar). |
| `GET` | `/api/books/{book_id}/readalong` | The companion readalong file, if one is matched. |
| `GET` | `/api/books/{book_id}/sync` | The readalong sync map (`.sync.json`), if one is matched or generated. |
| `POST` | `/api/books/{book_id}/sync/generate` | Start a background job that force-aligns the audio against the EPUB companion and writes a sync map. Admin only; requires the alignment CLI. Returns `{ "jobId": "..." }`. |
| `GET` | `/api/alignment/status` | Whether an alignment CLI was found: `{ "enabled": bool, "cliPath": string \| null }`. Admin only. |
| `GET` | `/api/books/{book_id}/download` | Zip download of all the book's files. Subject to `max_book_download_gib` and `max_concurrent_book_downloads`. |
| `DELETE` | `/api/books/{book_id}/download` | Delete the server's local copy. Admin only; Libation catalog state, progress, metadata overrides, and access grants are retained for later redownload. |
| `GET` | `/api/books/{book_id}/progress` | Playback progress for the current user and book. |
| `PUT` | `/api/books/{book_id}/progress` | Save playback progress for the current user and book. |
| `PUT` | `/api/books/{book_id}/completion` | Explicitly mark the book finished or unfinished for the current user without changing playback position. Body: `{ "finished": true }`. |
| `POST` | `/api/library/rescan` | Re-scan `library_root` for changes. Admin only. |
| `POST` | `/api/library/upload` | Upload one or more audio files as a new library folder. Admin only; multipart fields are `bookName` and one or more `files`. Subject to `max_upload_gib`. |

Audio tracks are streamed with HTTP range requests for seeking. The exact track URL is included in the book detail response.

Books that have a sync map expose a `syncFile` object (`fileName`, `source` of `sidecar` or `generated`, and `url`). The sync map itself is JSON:

```json
{
  "version": 1,
  "generator": "echogarden",
  "fragments": [
    {
      "startSeconds": 1.15,
      "endSeconds": 2.74,
      "href": "text/ch1.xhtml",
      "text": "The meadow was quiet in the early morning light."
    }
  ]
}
```

`startSeconds`/`endSeconds` are book-absolute positions (across all tracks), `href` is the EPUB spine document as written in the OPF manifest, and `text` is the sentence to locate and highlight inside that document.

Progress updates use JSON with the current track and timing fields:

```json
{
  "trackId": "track-id",
  "positionSeconds": 123.4,
  "bookPositionSeconds": 456.7,
  "durationSeconds": 36000.0,
  "updatedAtMs": 1753200000000,
  "intentionalRegression": false,
  "intentionalSeek": false
}
```

`updatedAtMs` is the optional client-side epoch-millisecond timestamp of when the position was recorded. When provided, the server rejects writes meaningfully older than the stored copy (returning the stored progress unchanged) so a replayed offline checkpoint or a freshly reinstalled client cannot roll back progress saved more recently from another device.

`intentionalRegression` (optional, default `false`) marks a deliberate backwards jump — the listener restarting a book, scrubbing, or picking an earlier chapter. Without it, a write within the first 60 seconds of a book that would erase more than 5 minutes of stored progress is refused (the stored copy is returned unchanged): a near-zero write with a fresh timestamp is the signature of a client that failed to restore its position, which the timestamp check cannot catch. Other backwards jumps are accepted, but when large, the replaced copy is preserved in `progress.backups.json` next to the progress store.

`intentionalSeek` (optional, default `false`) marks any user-initiated jump, forward or backward. The checkpoint is still saved, but the position difference is excluded from listening-time and streak statistics.

Progress responses may include `finishedOverride`. `true` or `false` records the reader's explicit completion choice; when absent, completion continues to be inferred from playback position. The choice is carried onto later checkpoints, with one exception: an `intentionalSeek` write that lands within the first 60 seconds of a book marked finished clears the override, because that is a listener starting the book over. Automatic position reports never clear it.

#### Libation (optional)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/libation/status` | Configured accounts and their auth state. |
| `POST` | `/api/libation/accounts/login/start` | Start an external-browser Audible sign-in for a new or existing managed account. Admin only. |
| `POST` | `/api/libation/accounts/login/{session_id}/complete` | Submit the final Amazon/Audible response URL and finish sign-in. Admin only. |
| `DELETE` | `/api/libation/accounts/login/{session_id}` | Cancel a pending account sign-in. Admin only. |
| `PUT` | `/api/libation/accounts/{profile_id}` | Rename a managed Audible account. Admin only. |
| `DELETE` | `/api/libation/accounts/{profile_id}` | Remove a managed account and its isolated Libation profile. Owner only. |
| `GET` | `/api/libation/books` | Audible library known to Libation. |
| `POST` | `/api/libation/sync` | Refresh Libation's library scan. Authenticated readers may call it; non-administrators are subject to the configured per-account hourly limit. |
| `POST` | `/api/libation/books/{asin}/liberate` | Download one title. Admin or directly permitted reader. |
| `POST` | `/api/libation/accounts/{profile_id}/books/{asin}/liberate` | Download one title through the selected Audible account. Admin or directly permitted reader. |
| `POST` | `/api/libation/liberate-all` | Download all eligible titles. Admin only. |
| `GET` | `/api/libation/access` | Libation availability and the signed-in reader's direct/approval policy. |
| `GET` | `/api/libation/requests` | The account's own requests; authorized approvers receive all requests. |
| `POST` | `/api/libation/requests/{asin}` | Submit a per-title approval request. |
| `PUT` | `/api/libation/requests/{request_id}/decision` | Approve or decline another account's request. Approval permission required. |
| `GET` | `/api/jobs` | List background jobs, newest first (the server keeps the most recent 50). |
| `GET` | `/api/jobs/{job_id}` | Poll a background job (e.g., liberation download). |

Libation status, managed-account changes, refresh, download-all, and jobs require an administrator. Account removal requires an owner. Download-all also requires direct-download access, while request decisions require the separate approval permission. Authenticated accounts can browse the catalog in installed apps; one-title downloads require direct access or an approved request. Account-aware requests include `profileId` so duplicate ASINs owned by multiple Audible accounts remain distinct. A requester cannot approve their own request. If Libation is not configured, acquisition endpoints respond with an explanatory error.

## Conventions

- Request and response bodies are JSON unless otherwise noted.
- Errors return JSON of the shape `{ "message": "..." }` with an appropriate 4xx/5xx status.
- Stream bodies (cover art, audio, readalong, zip download) return their native MIME types.

## CORS

Same-origin requests need no CORS configuration. The server allows the official OperaLibre iOS, Android, and macOS app origins by default. For a custom frontend served from a different origin than the API, add its full origin to `allowed_origins` in `server.config` (or put both behind one reverse proxy).
