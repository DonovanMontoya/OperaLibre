---
title: API Reference
nav_order: 9
---

# API Reference

All endpoints are served by the Rust backend on `host:port` (default `127.0.0.1:4000`). With the exception of a small public surface, every endpoint requires an authenticated session. Public deployments must expose a TLS reverse proxy rather than this raw HTTP listener.

Browser clients that authenticate with the session cookie must send an `Origin` (or `Referer`) matching the API host for `POST`, `PUT`, and `DELETE` requests. Origins explicitly trusted through `allowed_origins` are also accepted. Native and other API clients should send the session with `Authorization: Bearer ...`; bearer-authenticated changes do not require browser CSRF headers.

The included React/Vite app is one client for this API. Custom web, mobile, desktop, or native frontends can use the same endpoints as long as they follow the authentication and media URL conventions below.

## Authentication

The web app obtains a session token and a separate scoped media token via `POST /api/auth/login`. Send the session token in `Authorization: Bearer ...` for API requests. Read-only cover, readalong, companion, sync-map, stream, download, and OPDS endpoints accept the media token as a `?token=` query parameter so plain `<audio>` and `<img>` elements work without exposing a full API bearer token in URLs. `GET /api/auth/status` returns the current session's media token when authenticated.

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
| `GET` | `/api/profile/sessions` | The caller's own reading sessions, newest first. Accepts `limit` (default 200, max 1000) and `since=YYYY-MM-DD`. |
| `GET` | `/api/profile/completions` | The caller's own completion history, newest first, with a frozen snapshot of each book as it was when finished. Same query parameters. |
| `GET` | `/api/metrics` | Operational counts — books, tracks, users, sessions, database size. Owner only. |

#### Works

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/works` | The work index and its pending suggestions. Admin only. |
| `POST` | `/api/works/link` | Attach an edition to a work by hand with `{ "bookId": ..., "workId": ... }`. Admin only. |
| `POST` | `/api/works/reject` | Permanently reject a suggested pairing, same body. Admin only. |

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
| `POST` | `/api/users/{user_id}/password` | Reset a password. Any user may change their own; admin/owner targets require an owner. |
| `PUT` | `/api/users/{user_id}/book-access` | Set a reader's allowed book IDs. Send `{ "allowedBookIds": null }` for the full library or an array for a restricted shelf. |
| `PUT` | `/api/users/{user_id}/role` | Set owner/admin/reader status. Owner only. |
| `PUT` | `/api/users/{user_id}/libation-access` | Set direct or approval-required Libation access. Admin targets require an owner. |
| `PUT` | `/api/users/{user_id}/libation-approval` | Grant or revoke an administrator's request-approval permission. Owner only. |

#### Account settings

| Method | Path | Description |
| --- | --- | --- |
| `PUT` | `/api/me/progress-sharing` | Turn shared reading activity on or off for the current user with `{ "shareProgress": bool }`. Optionally carries `announceFinishes` and `notifyFinishes` (both bool); each is left unchanged when omitted, so older clients cannot reset them. Returns the updated account. |
| `GET` | `/api/activity/finishes` | The shared "who finished what" feed, newest first, capped at 50: `{ entries, unseenCount, latestId }`. Empty unless the caller both shares progress and has `notifyFinishes` on. Excludes the caller's own finishes, anyone not currently announcing, and books the caller cannot access. |
| `POST` | `/api/activity/finishes/seen` | Mark the feed read up to `{ "eventId": string }` — normally the `latestId` from a prior read. Only ever moves forward. Returns the refreshed feed. |

#### Library

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/books` | List books the current user is allowed to access, cursor-paged (the next cursor is returned in the `x-next-cursor` response header, with an `ETag` for caching). Administrators always receive the full library. |
| `GET` | `/api/books/{book_id}` | Detailed metadata, tracks, and chapters for one book. |
| `PUT` | `/api/books/{book_id}/metadata` | Save metadata overrides for a book. Admin only. Overrides win over embedded tags and Libation sidecar metadata. |
| `GET` | `/api/books/{book_id}/cover` | Cover art image, extracted from the audio files' embedded tags. |
| `GET` | `/api/books/{book_id}/readalong` | The book's text companion (the `book`-kind entry of `companions`), if there is one. |
| `GET` | `/api/books/{book_id}/companions/{companion_id}` | Any companion file beside the book — the text, a picture supplement, or a loose image — by the id from the book's `companions` list. |
| `GET` | `/api/books/{book_id}/sync` | The readalong sync map (`.sync.json`). Serves a sidecar or generated map when one exists; otherwise, for a book with an EPUB companion, estimates one from the chapter list on first request and caches it. |
| `POST` | `/api/books/{book_id}/sync/anchors` | Add a listener-placed sync anchor to an estimated map: `{ "href": ..., "text": ..., "seconds": ... }` says the sentence `text` in spine document `href` is being narrated at book position `seconds`. Kept with the book under `data_dir/sync`; the estimate is rebuilt through every anchor on the next request. Returns `{ "anchorCount": n }`. Rejected for books that already have an aligned map. |
| `DELETE` | `/api/books/{book_id}/sync/anchors` | Drop every listener-placed anchor on the book. Admin only. |
| `POST` | `/api/books/{book_id}/sync/generate` | Start a background job that force-aligns the audio against the EPUB companion and writes a sentence- and word-level sync map. Admin only; requires the alignment CLI. Returns `{ "jobId": "..." }`. |
| `GET` | `/api/alignment/status` | Whether an alignment CLI was found: `{ "enabled": bool, "cliPath": string \| null }`. Admin only. |
| `GET` | `/api/books/{book_id}/download` | Zip download of all the book's files. Subject to `max_book_download_gib` and `max_concurrent_book_downloads`. |
| `DELETE` | `/api/books/{book_id}/download` | Delete the server's local copy. Admin only; Libation catalog state, progress, metadata overrides, and access grants are retained for later redownload. |
| `GET` | `/api/books/{book_id}/progress` | Playback progress for the current user and book. |
| `PUT` | `/api/books/{book_id}/progress` | Save playback progress for the current user and book. |
| `PUT` | `/api/books/{book_id}/completion` | Mark the book finished or unfinished for the current user. Manual changes use `{ "finished": true }`, preserve position, and do not invent a dated reading-history event. Natural completion also sends `trackId`, `positionSeconds`, `bookPositionSeconds`, and `durationSeconds` so the final position, status, and actual completion are stored atomically. |
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

#### Companions

Every document and picture found beside a book's audio is listed in the book's `companions` array, each classified by what it holds rather than by its extension:

```json
{
  "id": "3f9c…",
  "fileName": "The Hobbit - Maps.pdf",
  "extension": "pdf",
  "contentType": "application/pdf",
  "url": "/api/books/{book_id}/companions/3f9c…",
  "kind": "supplement",
  "sizeBytes": 8123456,
  "pageCount": 12,
  "imageCount": 14,
  "textCharacters": 380
}
```

`kind` is `book` for the text the narrator reads, `supplement` for a document that is mostly pictures (an Audible PDF of maps or illustrations), or `image` for a loose picture file. The judgement compares the document's text against the amount a narration of the book's length implies, so a picture book's short EPUB is still the book and a captioned atlas beside a ten-hour audiobook is not. `unreadable: true` marks a document that could not be opened; it is offered as the book rather than hidden. The counts are present for documents only; PDF counts are sampled and scaled. `readingFile` remains the primary `book`-kind companion (EPUB preferred) for older clients.

#### Sync maps

Books that can be followed expose a `syncFile` object (`fileName`, `source`, and `url`). `source` is `sidecar` for a `.sync.json` beside the book, `generated` for one produced by the alignment job, or `estimated` for a book with an EPUB companion and neither of those — the sync route interpolates a map from the chapter list on first request. The sync map itself is JSON:

```json
{
  "version": 2,
  "generator": "echogarden",
  "precision": "sentence",
  "fragments": [
    {
      "startSeconds": 1.15,
      "endSeconds": 2.74,
      "href": "text/ch1.xhtml",
      "text": "The meadow was quiet in the early morning light.",
      "words": [[1.15, 1.31, 0, 3], [1.31, 1.72, 4, 6]]
    }
  ]
}
```

`startSeconds`/`endSeconds` are book-absolute positions (across all tracks), `href` is the EPUB spine document as written in the OPF manifest, and `text` is the sentence to locate and highlight inside that document. `words` (optional) times each word as `[startSeconds, endSeconds, offsetUtf16, lengthUtf16]` inside `text`. `precision` is `sentence` for a forced alignment and `estimated` for an interpolation; an estimate also carries `anchorCount`, the number of audio chapters that were pinned to a table-of-contents entry (zero means one whole-book guess, which drifts more), and `manualAnchorCount`, the number of listener-placed anchors it was timed through. Version 1 maps, which carried sentences only, are still accepted.

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

Audiobooks are mastered at very different levels, so `volumeGain` is a per-listener, per-book correction rather than a device setting: it is stored beside progress (keyed by user and book) and follows the listener to every client they sign in from. Every book in `/api/books` carries the caller's own `volumeGain`; `1.0` means the file's own level and is what an untuned book reports.

Applying it is the client's job, and above unity it needs an engine that can exceed the media element's ceiling — a Web Audio gain node, or the platform's own mixer. A client that cannot do that should still honour gains below `1.0`.

#### The reading log

Playback progress answers "where am I in this book" and is overwritten on every checkpoint. The reading log answers "what did this reader actually do" and keeps one current row per listening session.

SQLite holds one row per **session** — a continuous stretch of listening, coalesced in memory from the client's checkpoints and closed after a ten-minute gap. Each row carries the book, the work, start and end timestamps, seconds actually listened, the whole-book positions at either end, and the reported playback speed, client, and UTC offset. Open sessions are written through once a minute, when they become idle, and during graceful shutdown. A hard crash can lose only the unflushed tail of an in-progress sitting.

Seconds listened come from the same validated forward position movement the daily activity totals use: deliberate seeks contribute nothing, and movement is capped against elapsed wall-clock time. Scrubbing to the end of a book is not listening to it.

SQLite also holds one immutable row per book that playback carries across the **crossing** into finished, so a client re-sending the same state cannot log a book twice while a genuine re-read logs a second time. Merely marking a book finished changes its library status without assigning today's date to an older or unknown reading. Each row carries an `EditionSnapshot` — title, author, narrator, runtime, ASIN, ISBN, publisher, series, genres — copied out of the library at the moment of completion. That snapshot is what makes a completion durable: it stays readable after the audio is deleted, re-downloaded in another encoding, or replaced by a different edition.

`speed` and `client` are optional on `PUT /api/books/{book_id}/progress` and, when valid, are retained with the session that reported them.

#### Works

Book identity is byte identity: a re-encode, a different rip, or another edition is a different book, which is the right answer for playback and the wrong one for a reading history. A **work** sits above those editions and collects them, so a history follows the reader across re-downloads and replacements. Progress stays keyed by book; a work is a view, never a replacement.

Editions are matched to works in tiers: an administrator's manual link, then an exact ASIN, then an exact ISBN, then a normalized title and author whose runtimes agree within 15%. A title and author that agree while the runtimes do not — an abridgement, a dramatization, a missing duration — becomes a **suggestion** for an administrator rather than a silent merge. Manual links and rejections are permanent and survive rescans.

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
| `GET` | `/api/libation/covers/{picture_id}` | Audible cover-art proxy. Accepts the media token. |
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

## OPDS

The server publishes an [OPDS](https://opds.io/) catalog so generic reading apps can browse and download the library:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/opds` | Navigation-feed root. |
| `GET` | `/api/opds/books` | Acquisition feed, one entry per book with per-track download links. |

Both feeds authenticate with the media token as a `?token=` query parameter (HTTP Basic is not supported), so the catalog URL to paste into an OPDS client is `http://server:4000/api/opds?token=...`.

## Audiobookshelf-compatible API (`/abs`)

The server also speaks a subset of the [Audiobookshelf](https://www.audiobookshelf.org/) API under the `/abs` prefix, so audiobook apps with Audiobookshelf support — BookPlayer, for example — can connect directly. Point the client at `http://server:4000/abs` and sign in with a normal OperaLibre account.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/abs/status` | Server status for client validation. Public. |
| `GET` | `/abs/ping` | Connectivity check. Public. |
| `POST` | `/abs/login` | Sign in; returns an Audiobookshelf-shaped user object and the default library id. Public. |
| `GET` | `/abs/api/me` | The current user with media progress and token. |
| `GET` | `/abs/api/libraries` | The single synthetic library. |
| `GET` | `/abs/api/libraries/{library_id}/items` | Paged, filterable library items (author, series, narrator, and genre filters are supported). |
| `GET` | `/abs/api/libraries/{library_id}/filterdata` | Author, series, narrator, and genre facets. |
| `GET` | `/abs/api/libraries/{library_id}/search` | Search books. |
| `GET` | `/abs/api/libraries/{library_id}/collections` | Always empty; collections are not supported. |
| `GET` | `/abs/api/authors/{author_id}` | An author with their items. |
| `GET` | `/abs/api/items/{item_id}` | One library item. |
| `GET` | `/abs/api/items/{item_id}/cover` | Cover art. |
| `GET`/`POST` | `/abs/api/items/{item_id}/play` | Open a playback session with the resume position. |
| `GET`/`PATCH` | `/abs/api/me/progress/{item_id}` | Read or write media progress; synced with native OperaLibre progress. |
| `GET` | `/abs/api/items/{item_id}/download` | Download the item archive. |

Cover and stream URLs are also mirrored at `/abs/api/books/{book_id}/cover` and `/abs/api/books/{book_id}/tracks/{track_id}/stream` (media token accepted), because some clients resolve content URLs against the `/abs` base while others resolve against the origin. Book-access restrictions apply exactly as on the native API.

## Conventions

- Request and response bodies are JSON unless otherwise noted.
- Errors return JSON of the shape `{ "message": "..." }` with an appropriate 4xx/5xx status.
- Stream bodies (cover art, audio, readalong, zip download) return their native MIME types.

## CORS

Same-origin requests need no CORS configuration. The server allows the official OperaLibre iOS, Android, and macOS app origins by default. For a custom frontend served from a different origin than the API, add its full origin to `allowed_origins` in `server.config` (or put both behind one reverse proxy).
