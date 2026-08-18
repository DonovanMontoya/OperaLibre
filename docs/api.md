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

#### Account settings

| Method | Path | Description |
| --- | --- | --- |
| `PUT` | `/api/me/progress-sharing` | Turn shared reading activity on or off for the current user with `{ "shareProgress": bool }`. Returns the updated account. |

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
| `PUT` | `/api/books/{book_id}/completion` | Mark the book finished or unfinished for the current user. Manual changes use `{ "finished": true }` and preserve position; natural completion also sends `trackId`, `positionSeconds`, `bookPositionSeconds`, and `durationSeconds` so the final position and status are stored atomically. |
| `PUT` | `/api/books/{book_id}/volume` | Set the current user's playback gain for the book. Body `{ "volumeGain": number }`, a linear multiplier clamped to `0.5`–`16.0`. Returns the updated book. |
| `POST` | `/api/library/rescan` | Re-scan `library_root` for changes. Admin only. |
| `POST` | `/api/library/upload` | Upload one or more audio files as a new library folder. Admin only; multipart fields are `bookName` and one or more `files`. Subject to `max_upload_gib`. |
| `GET` | `/api/library/faststart` | Report which MP4/M4B files still keep their `moov` index behind the audio. Admin only. |
| `POST` | `/api/library/faststart` | Start a faststart conversion job. Admin only; body `{ "bookId": string \| null, "includeActive": bool }`. Returns `{ "jobId": ... }` to poll on `/api/jobs/{job_id}`. |

#### Faststart conversion

MP4-family files (`.m4a`, `.m4b`, `.mp4`) written without `-movflags +faststart` store their `moov` index after the media data, so a player must fetch the end of the file before it can start. The status response reports `enabled` (whether ffmpeg was found), `ffmpegPath`, `ffprobePath`, `verificationLimited` (ffprobe missing), the `mp4Files`/`optimizedFiles`/`pendingFiles`/`unreadableFiles` counts, `pendingBytes`, an `activeJobId`, and a `books` array of `{ bookId, title, pendingFiles, pendingBytes, inUse }`.

Conversion is deliberately conservative and never edits a file in place:

- Only files whose top-level boxes parse cleanly and put `mdat` ahead of `moov` are candidates. Anything unreadable, truncated, or already faststart is left alone.
- Each file is remuxed with `-c copy` to a temporary file beside the original. Audio and cover art are copied verbatim and tags and chapters are carried across. The QuickTime `bin_data` chapter *text track* that Audible-derived M4Bs carry is deliberately not copied — the mp4/ipod muxer cannot write it back — and is regenerated from the chapter list instead.
- The result must parse as faststart, keep at least half the original's size, and — when ffprobe is available — match the original's duration and audio stream count and keep at least as many chapters and cover-art streams. A failed check discards the copy and leaves the original in place.
- The verified copy replaces the original with a single atomic rename, with a hard link held until the rename lands so an interrupted conversion cannot lose a book. Book and track identity is keyed on library paths, so listening progress survives.
- Books whose saved position moved within the last 15 minutes are skipped, since somebody is likely listening; `includeActive: true` converts them anyway.
- Only one conversion job runs at a time, and free space is checked before each file. The library is rescanned when the job finishes.

Requires ffmpeg on `PATH` or `ffmpeg_path` in `server.config`; the control reports itself as unavailable otherwise.

Audio tracks are streamed with HTTP range requests for seeking. The exact track URL is included in the book detail response.

Book responses carry a `sharedProgress` array describing what the *other* accounts on the server have done with the book — `userId`, `username`, `status` (`inProgress` or `finished`), `percentComplete`, and `updatedAt`. Sharing is reciprocal and controlled by each account's `shareProgress` flag, which defaults to on: an account that has turned sharing off is omitted from everyone else's `sharedProgress` and receives an empty array itself. Books nobody else has started omit the field entirely.

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

#### Per-book volume

Audiobooks are mastered at very different levels, so `volumeGain` is a per-listener, per-book correction rather than a device setting: it is stored beside progress (keyed by user and book, in `book-settings.json`) and follows the listener to every client they sign in from. Every book in `/api/books` carries the caller's own `volumeGain`; `1.0` means the file's own level and is what an untuned book reports.

Applying it is the client's job, and above unity it needs an engine that can exceed the media element's ceiling — a Web Audio gain node, or the platform's own mixer. A client that cannot do that should still honour gains below `1.0`.

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
