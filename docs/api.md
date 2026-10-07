---
title: API Reference
nav_order: 9
---

# API Reference

All endpoints are served by the Rust backend on `host:port` (default `127.0.0.1:4920`). With the exception of a small public surface, every endpoint requires an authenticated session. Public deployments must expose a TLS reverse proxy rather than this raw HTTP listener.

Browser clients that authenticate with the session cookie must send an `Origin` (or `Referer`) matching the API host for `POST`, `PUT`, `PATCH`, and `DELETE` requests. Origins explicitly trusted through `allowed_origins` are also accepted. Native and other API clients should send the session with `Authorization: Bearer ...`; bearer-authenticated changes do not require browser CSRF headers.

The included React/Vite app is one client for this API. Custom web, mobile, desktop, or native frontends can use the same endpoints as long as they follow the authentication and media URL conventions below.

## Authentication

The web app obtains a session token and a separate scoped media token via `POST /api/auth/login`. Send the session token in `Authorization: Bearer ...` for API requests. Read-only cover, readalong, companion, sync-map, stream, download, and OPDS endpoints accept the media token as a `?token=` query parameter so plain `<audio>` and `<img>` elements work without exposing a full API bearer token in URLs. `GET /api/auth/status` returns the current session's media token when authenticated.

### Public endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness probe. Returns `200 OK` when the server is up. `serverId` is a random value that stays the same for the life of the installation, so a client can tell when two addresses reach different servers. It is public and is not proof of identity; never use it to decide where to send credentials. |
| `GET` | `/api/auth/status` | Reports whether first-run setup is needed, whether the server requires a bootstrap token (`proxy` mode only, same for every client), and whether this client must set up locally. |
| `POST` | `/api/auth/setup` | One-time owner creation. Every `proxy` client must send the current `setupToken`; `lan` setup is open to the trusted network, and `local` mode rejects remote setup. |
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
| `GET` | `/api/update` | Compare the running version with the selected stable or nightly release. Admin only. Add `?refresh=true` to bypass the 15-minute metadata cache. |
| `GET` | `/api/update/channel` | Read the saved `channel` (`"stable"` or `"nightly"`) and running `currentVersion`. Admin only; does not contact GitHub. |
| `PUT` | `/api/update/channel` | Save `{ "channel": "stable" }` or `{ "channel": "nightly" }` and clear update caches. Owner only. Refused during installation; does not install or restart. |
| `POST` | `/api/update/install` | Download, verify, and stage the platform update, then restart a release-package installation (combined or server-only). Owner only. |

The status response reports `channel`, `currentChannel`, `currentVersion`, `latestVersion`, `updateAvailable`, `canAutoUpdate`, `platform`, release details, and a message when manual installation is required. `lastUpdateResult` is a nullable human-readable result of the last completed managed update, refreshed from disk even when release metadata is cached; failures include rollback details. Automatic installation preserves user data, the audiobook library, and `server.config`; the external updater performs replacement and rollback after the server exits. Combined installations also receive the bundled web app and refreshed launchers; server-only installations (including those pointing `web_dist_dir` at a custom frontend) leave the frontend untouched and refresh their server and platform launch helpers.

Install requests may include `{ "channel": "nightly", "version": "0.5.1-nightly.20260927.123" }` to pin the selection the owner reviewed. A changed channel or target version refuses the request before staging. Requests without a body remain compatible with older clients. Switching channels can offer an older version; the server checks the signed data-compatibility declaration before installation. Incompatible targets have `canAutoUpdate: false` and an explanatory `message`.

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

#### Server backup (owner)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/admin/backup` | Export a portable JSON backup of database state and stable library identities. |
| `POST` | `/api/admin/backup` | Restore the exported JSON body, up to 256 MiB. Replaces server-owned state after validating the format and creating a safety backup. |

The archive includes accounts, permissions, progress, per-book settings, reading history, metadata, work links, and Libation records. It excludes audio, companion and cover files, generated sync maps, sync queue/schedule files, import credentials, and `server.config`; back up those separately. Restoring does not revive sessions from the archive. The requesting owner's live session is retained only when its user ID exists in the restored accounts; other clients must sign in again. The response reports `safetyBackup`, counts, `sessionRetained`, and any warning. See [Backups](deployment.md#backups) for the complete workflow.

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
| `PUT` | `/api/books/{book_id}/metadata` | Save metadata overrides for a book, including repeatable custom tags with optional positions. Admin only. Overrides win over embedded audio tags and Libation sidecar metadata. |
| `POST` | `/api/books/{book_id}/cover` | Replace cover art with one multipart `file` (JPEG, PNG, or WebP). Admin only. Maximum 8 MiB, 16 million pixels, and 8192 pixels per side; decoded and re-encoded as PNG up to 1600 pixels per side. Returns the updated book. |
| `DELETE` | `/api/books/{book_id}/cover` | Remove the uploaded override and restore embedded art, or no cover when none exists. Admin only. Returns the updated book. |
| `GET` | `/api/books/{book_id}/cover` | Uploaded cover override when present, otherwise artwork extracted from the audio files' embedded tags. |
| `GET` | `/api/books/{book_id}/readalong` | The book's text companion (the `book`-kind entry of `companions`), if there is one. |
| `GET` | `/api/books/{book_id}/companions/{companion_id}` | Any companion file beside the book — the text, a picture supplement, or a loose image — by the id from the book's `companions` list. |
| `GET` | `/api/books/{book_id}/companions/{companion_id}/entries/{path}` | One EPUB archive member, such as `META-INF/container.xml` or `OEBPS/chapter1.xhtml`. Supports media tokens, private ETag revalidation, and compression. Members are limited to 32 MiB uncompressed. The server sends eight members at a time, at most four of them to one account: further requests wait their turn, and a transfer the client leaves unread for 30 seconds is closed. |
| `GET` | `/api/books/{book_id}/sync` | The readalong sync map (`.sync.json`). Serves an aligned sidecar or generated map when one exists; otherwise returns 404. Outdated maps remain available until replaced. |
| `GET` | `/api/books/{book_id}/tracks/{track_id}/stream` | Stream one track in its original format, with HTTP byte-range support for seeking. Accepts the scoped media token. |
| `POST` | `/api/books/{book_id}/sync/generate` | Start a background job that force-aligns the audio against the EPUB companion and writes a sentence- and word-level sync map. Admin only; requires an enabled add-on or manually configured alignment CLI. Jobs are durably queued and deduplicated by book; queued and interrupted jobs resume after restart with the same job IDs. Interrupted books resume from the last completed chapter or track; unfinished sections are repeated. Changed inputs, alignment runtime, or server alignment code invalidate saved sections. Paused jobs remain paused across restarts. Returns `{ "jobId": "..." }`. |
| `GET` | `/api/alignment/status` | Whether sync generation is enabled: `{ "enabled": bool, "cliPath": string \| null }`. Admin only. |
| `GET` | `/api/experimental-features/readalong-sync` | Installed, enabled, version, package availability, size, and management status for the optional generator. Admin only. Add `?refresh=true` to refresh release metadata. |
| `POST` | `/api/experimental-features/readalong-sync/install` | Download, verify, and install or update the official platform package. Owner only; managed release installations only. |
| `PUT` | `/api/experimental-features/readalong-sync/enabled` | Enable or disable an installed managed add-on with `{ "enabled": bool }`. Owner only. |
| `DELETE` | `/api/experimental-features/readalong-sync` | Disable the managed add-on and move its installed files into recoverable update storage. Existing sync maps are retained. Owner only. |
| `GET` | `/api/books/{book_id}/download` | Zip download of all the book's files. Subject to `max_book_download_gib` and `max_concurrent_book_downloads`. |
| `DELETE` | `/api/books/{book_id}/download` | Delete the server's local copy. Admin only; Libation catalog state, progress, metadata overrides, and access grants are retained for later redownload. |
| `GET` | `/api/books/{book_id}/progress` | Playback progress for the current user and book. |
| `PUT` | `/api/books/{book_id}/progress` | Save playback progress for the current user and book. |
| `PUT` | `/api/books/{book_id}/completion` | Mark the book finished or unfinished for the current user. Manual changes use `{ "finished": true }`, preserve position, and do not invent a dated reading-history event. Natural completion also sends `trackId`, `positionSeconds`, `bookPositionSeconds`, and `durationSeconds` so the final position, status, and actual completion are stored atomically. |
| `PUT` | `/api/books/{book_id}/volume` | Set the current user's playback gain for the book. Body `{ "volumeGain": number }`, a linear multiplier clamped to `0.5`–`16.0`. Returns the updated book. |
| `POST` | `/api/library/rescan` | Re-scan `library_root` for changes. Admin only. |
| `POST` | `/api/library/upload` | Upload one or more audio files as a new library folder. Admin only; multipart fields are `bookName` and one or more `files`. Subject to `max_upload_gib`. |
| `POST` | `/api/books/{book_id}/ebook` | Pair one validated, unencrypted EPUB with an existing book. Admin only; multipart field `file`. Limited to 64 MiB or `max_upload_gib`, whichever is lower. Does not overwrite files; refuses books with an existing paired EPUB or sync map. Returns the refreshed book list. |
| `GET` | `/api/library/faststart` | Report which MP4/M4B files still keep their `moov` index behind the audio. Admin only. |
| `POST` | `/api/library/faststart` | Start a faststart conversion job. Admin only; body `{ "bookId": string \| null, "includeActive": bool }`. Returns `{ "jobId": ... }` to poll on `/api/jobs/{job_id}`. |

Book responses include `hasCoverOverride`, `coverArtContentType`, and a versioned `coverArtUrl`; use the returned URL after changes. Cover reads retain book-access restrictions and ETag validation. Uploads never rewrite audio: a managed hidden image sidecar lives in the writable book folder and the metadata store records its selection. Both are needed to preserve an override in a backup or move. Invalid uploads leave the current cover unchanged.

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

If a reader finished another edition linked to the same work, a book listing or detail response shows this edition as `finished` even when it has no saved playback position of its own. The inherited summary starts at position zero; `GET /api/books/{book_id}/progress` remains `null` until this edition has its own checkpoint. A completion choice or listening progress on this edition takes priority. Shared progress follows the same rule for readers who have opted into sharing.

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

`kind` is `book` for the text the narrator reads, `supplement` for a document that is mostly pictures (an Audible PDF of maps or illustrations), or `image` for a loose picture file. The judgement compares the document's text against the amount a narration of the book's length implies, so a picture book's short EPUB is still the book and a captioned atlas beside a ten-hour audiobook is not. `unreadable: true` marks a document that could not be opened or exceeded the analysis limits; it is offered as the book rather than hidden. EPUB analysis stops after processing 100,000 markup tags in a spine document; exceeding this limit also rejects EPUB uploads and automatic alignment. The counts are present for documents only; PDF counts are sampled and scaled. `readingFile` remains the primary `book`-kind companion (EPUB preferred) for older clients.

The EPUB reader requests package metadata, stylesheets, and the current chapter through the entry route. Images and fonts load when their chapter uses them, so opening a large illustrated book does not require downloading the entire archive. Complete downloaded copies still open locally; older servers fall back to the whole-file route. Audio continues to use byte ranges. On iOS, AVPlayer alone fetches the audio; native metadata and position drive a source-free web control clock. Volume boost loads track metadata only for the active queue item. M4B files with their index at the end can also benefit from the existing faststart maintenance operation.

#### Sync maps

Sync administration endpoints (administrator only):

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/sync-schedules` | List persisted individual schedules and their outcomes. |
| `PUT` | `/api/sync-schedules/{book_id}` | Schedule with `{ "runAt": <Unix milliseconds> }`. |
| `DELETE` | `/api/sync-jobs/{job_id}` | Remove a queued or paused sync and its saved sections. Returns 204; running or finished jobs return 409. Admin only. |
| `PATCH` | `/api/sync-jobs/{job_id}` | Send `{ "action": "up" }`, `down`, `pause`, or `resume`. Up/down moves a queued job one place. Pause interrupts the current section and retains completed chapters or tracks; queued jobs pause immediately. Resume appends a paused job to the queue and repeats the unfinished section. Returns the job; incompatible states return 409. Admin only. |
| `DELETE` | `/api/sync-schedules/{book_id}` | Cancel a schedule before it joins the queue. |
| `GET` | `/api/sync-sweep` | Nightly rule, `pendingCount` (missing or outdated maps), and `eligibleCount`. |
| `PUT` | `/api/sync-sweep` | Save `{ "enabled": true, "localTime": "01:00", "timeZone": "America/New_York", "booksPerNight": 2 }`. Limit: 1–100, default 2 when omitted. |
| `POST` | `/api/sync-sweep/run` | Queue all missing and outdated maps immediately; skips active jobs and individual schedules. Returns `queued`, `skipped`, and `error`. |

Nightly sweeps queue at most `booksPerNight` missing or outdated maps per run; the immediate run endpoint is not limited by that setting. Changing the rule to `enabled: false` stops future batches without cancelling queued work. Scheduled starts more than 15 minutes late are skipped; nightly rules advance to their next local occurrence. Job summaries include optional `queuePosition` (ascending queue order) and `pauseRequested`. The status `paused` retains saved sections; a running job with `pauseRequested: true` is stopping its current section. Completed sections remain saved; resuming repeats the unfinished section. Accepted jobs and recent outcomes survive restarts, and interrupted books resume from the last completed section after the library and generator become available. Paused books remain paused. Before a server update launches its updater, sync workers stop and the queue is saved for automatic recovery. Updates repeat unfinished sections rather than waiting for them to finish; manually paused jobs are left paused. Failed or cancelled update preparation releases the queue on the current server.

Books that can be followed expose a `syncFile` object (`fileName`, `source`, `url`, and `outdated`). `source` is `sidecar` for an aligned `.sync.json` beside the book or `generated` for one produced by the alignment job. Books without an aligned map have `syncFile: null`. `outdated` recommends remapping an older OperaLibre-generated map but does not prevent playback. Generated maps include `mappingRevision`, advanced only for improvements that warrant remapping, independently of the map schema or application release. A missing `mappingRevision` is treated as 0; a lower revision marks a generated map outdated, while equal or higher revisions remain current. Third-party maps without this provenance are not marked outdated. The sync map itself is JSON:

```json
{
  "version": 2,
  "mappingRevision": 1,
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

`startSeconds`/`endSeconds` are book-absolute positions (across all tracks), `href` is the EPUB spine document as written in the OPF manifest, and `text` is the sentence to locate and highlight inside that document. `words` (optional) times each word as `[startSeconds, endSeconds, offsetUtf16, lengthUtf16]` inside `text`. `precision` is `sentence` for a forced alignment. Legacy estimated maps are not served as sentence alignments. Version 1 maps, which carried sentences only, are still accepted.

#### Playback progress

Progress updates use JSON with the current track and timing fields:

```json
{
  "trackId": "track-id",
  "positionSeconds": 123.4,
  "bookPositionSeconds": 456.7,
  "durationSeconds": 36000.0,
  "updatedAtMs": 1753200000000,
  "sentAtMs": 1753200000500,
  "baseUpdatedAt": "1753199999000",
  "recording": { "id": "a9c120344f815dad286c9a983057fed2", "sequence": 1 },
  "intentionalRegression": false,
  "intentionalSeek": false
}
```

`updatedAtMs` is the optional client-side epoch-millisecond timestamp of when the position was recorded. `sentAtMs` is the optional client clock reading when the request was sent; together they let the server correct clock skew while retaining the age of an offline checkpoint. For writes without `baseUpdatedAt` or a confirmed continuation of the same recording, a recorded timestamp meaningfully older than the stored copy causes the write to be refused and the stored progress returned unchanged. Accepted writes receive a server-issued, monotonically increasing `updatedAt` revision.

`baseUpdatedAt` is the optional exact `updatedAt` string last observed from the server before recording this checkpoint. When a stored checkpoint exists and its revision differs, the write is refused unless its recording identity proves that it continues the same local recording. An intentional seek from a different recording still requires the current revision. When the base matches, recording age does not reject the write: a later checkpoint recorded offline can safely follow an acknowledged earlier save from the same device. Position and reset guards still apply. Revision rejection prevents a delayed automatic save from undoing a rewind received first from another device. Send an empty string when no server checkpoint has been observed. A missing server record can be initialized regardless of the base; omitting both revision and recording metadata retains legacy timestamp and position guards. Keep the original base with offline checkpoints: if another device changes the server revision meanwhile, the server copy wins. Adopt the returned server position and revision before recording subsequent checkpoints rather than retrying the same old position with a new base.

`recording` is optional and identifies an ordered sequence of local checkpoints. Create a random 32-character hexadecimal `id`, persist it before sending, and increment `sequence` for each new checkpoint (a positive integer no greater than 9007199254740991). Retain this ID across your local edits, offline retries, and your own acknowledgments; start a new ID after adopting another client's position. Never inherit a fetched ID without a matching locally recorded receipt. A higher sequence with the same ID as the stored checkpoint can continue after a lost response, even with the original older base revision. A different client's write, completion change, or backup restore ends that lineage. Reordered sequences are refused; position and reset guards still apply. Exact retries with the same ID, sequence, and normalized position return the existing revision without another save. These fields are stored durably and returned by GET and PUT progress. Clients that omit them retain the previous contract.

The native progress PUT response includes an `accepted` boolean alongside the resulting progress fields. `true` means this write was saved or recognized as an exact retry of an already-saved checkpoint; `false` means a guard rejected it and the existing server checkpoint is being returned. Matching positions alone do not imply acceptance. Clients should use this explicit outcome when advancing the base revision of their queued changes. GET progress responses do not include `accepted`. Lost-confirmation recovery requires both an updated app and server, and applies to checkpoints sent with recording metadata.

`intentionalRegression` (optional, default `false`) marks a deliberate backwards jump — the listener restarting a book, scrubbing, or picking an earlier chapter. Without it, a write within the first 60 seconds of a book that would erase more than 5 minutes of stored progress is refused: a near-zero write with a fresh timestamp is the signature of a client that failed to restore its position, which the timestamp check cannot catch. Automatic checkpoints cannot move backwards by more than 2 seconds. An intentional seek or regression can move backwards, subject to the revision, staleness, and near-zero guards; large accepted drops preserve the previous checkpoint for recovery.

`intentionalSeek` (optional, default `false`) marks any user-initiated jump, forward or backward. An accepted checkpoint's position difference is excluded from listening-time and streak statistics.

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

#### Libro.fm accounts and imports

These routes operate only on the authenticated user's Libro.fm accounts. A user can connect multiple accounts, with cached purchases carrying their `accountEmail`.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/me/libro` | Account summaries (email, nickname, last refresh), cached purchases, accessible local book IDs, and the user's jobs. Tokens are never returned. |
| `POST` | `/api/me/libro` | Connect with `{ "email": "…", "password": "…" }`; save the returned token and queue library refresh. Password is not retained. |
| `PATCH` | `/api/me/libro` | Rename one account with `{ "email": "…", "nickname": "…" }`. Nickname: at most 80 characters, with no control characters. Returns `204`. |
| `DELETE` | `/api/me/libro` | Remove the selected account and its cached purchases; keep imported audio. Use `?email=...` when multiple accounts are connected. |
| `POST` | `/api/me/libro/refresh` | Queue refresh of all connected accounts; returns `{ "jobId": "…" }`. |
| `POST` | `/api/me/libro/books/{isbn}/import` | Queue one owned purchase for import; `?email=...` selects its account. Grants the importing user access after indexing. |

Jobs use `libro-refresh` and `libro-download`. Imported ISBNs have stable folders
and `.libro-book.json` metadata sidecars. Library updates preserve manual metadata
overrides. No account token or signed download URL is returned to the frontend.

The optional watched-folder routes remain administrator tools:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/libro` | Watched server folder, latest import items, last check, error, and latest job. Admin only. |
| `PUT` | `/api/libro` | Save `{ "folder": "/absolute/server/path" }`, or `null` to stop watching. Owner only. Existing imports are kept. |
| `POST` | `/api/libro/scan` | Queue a deduplicated import check; returns `{ "jobId": "…" }`. Admin only. |

Imports use the normal upload limits and access rules. Settings and receipts
are host-local; see [Libro.fm Import](libro.md) for supported layouts and status
semantics. Job kind is `libro-import` and uses the standard jobs endpoints.

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

Libation download jobs enforce `max_upload_gib` per title, including temporary files, and monitor `min_download_free_gib` on the library volume. Budget failures set the job to `failed` and discard staged files. The same checks apply to approved requests and each title in download-all. Existing local titles are reused.

## OPDS

The server publishes an [OPDS](https://opds.io/) catalog so generic reading apps can browse and download the library:

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/opds` | Navigation-feed root. |
| `GET` | `/api/opds/books` | Acquisition feed, one entry per book with per-track download links. |

Both feeds authenticate with the media token as a `?token=` query parameter (HTTP Basic is not supported), so the catalog URL to paste into an OPDS client is `http://server:4920/api/opds?token=...`. Bearer authentication is also accepted. The feed supplies separate track acquisitions; a client must support audio downloads and multiple tracks to import a complete audiobook. OPDS does not synchronize playback progress. BookPlayer currently has no OPDS connector; use its Audiobookshelf connection below.

## Audiobookshelf-compatible API (`/abs`)

The server implements a subset of the [Audiobookshelf](https://www.audiobookshelf.org/) API under the `/abs` prefix. In BookPlayer, choose an Audiobookshelf connection, enter `http://server:4920/abs` (or your HTTPS address ending in `/abs`), and sign in with a normal OperaLibre account. The server root and the OPDS URL are not the Audiobookshelf base URL.

Compatibility is client-specific. BookPlayer response decoding and its browse/download HTTP contracts have been tested against a temporary server; the full iOS app and physical-device playback have not been verified. The official Audiobookshelf app requires additional endpoints, including authorization and playback-session synchronization, which are not implemented. See the [compatibility audit](client-compatibility.md) for exact coverage and remaining gaps.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/abs/status` | Server status for client validation. Public. |
| `GET` | `/abs/ping` | Connectivity check. Public. |
| `POST` | `/abs/login` | Sign in; returns an Audiobookshelf-shaped user object and the default library id. Public. |
| `POST` | `/abs/logout` | Revoke the caller's session token. |
| `GET` | `/abs/api/me` | The current user with media progress and token. |
| `GET` | `/abs/api/libraries` | The single synthetic library. |
| `GET` | `/abs/api/libraries/{library_id}/items` | Paged, filterable library items (author, series, narrator, genre, and tag filters are supported). |
| `GET` | `/abs/api/libraries/{library_id}/filterdata` | Author, series, narrator, genre, and tag facets. |
| `GET` | `/abs/api/libraries/{library_id}/search` | Search books. |
| `GET` | `/abs/api/libraries/{library_id}/collections` | Always empty; collections are not supported. |
| `GET` | `/abs/api/collections/{collection_id}` | Returns 404; collections are not supported. |
| `GET` | `/abs/api/authors/{author_id}` | An author with their items. |
| `GET` | `/abs/api/items/{item_id}` | One library item. |
| `GET` | `/abs/api/items/{item_id}/cover` | Cover art. |
| `GET` | `/abs/api/books/{book_id}/cover` | Media-token-compatible cover alias for clients resolving URLs against `/abs`. |
| `GET` | `/abs/api/books/{book_id}/tracks/{track_id}/stream` | Media-token-compatible byte-range audio alias for those clients. |
| `GET`/`POST` | `/abs/api/items/{item_id}/play` | Open a playback session with the resume position. |
| `GET`/`PATCH` | `/abs/api/me/progress/{item_id}` | Read or write media progress; synced with native OperaLibre progress. |
| `GET` | `/abs/api/items/{item_id}/download` | Download the item archive. |

Author IDs advertised by item metadata and filter data are safe to append as one URL path component, including for names such as `AC/DC`. Use the advertised ID for author details and author filters; the display name remains unchanged. Ordinary names retain their existing IDs. Properly URL-escaped legacy names remain accepted unless they begin with the reserved `~` prefix; refresh those cached IDs from filter data.

Audiobookshelf clients do not send OperaLibre's seek flags. Fresh backwards progress updates of less than 30 minutes are treated as rewinds, including small jumps into the first minute. Stale updates and near-zero writes that erase more than 5 minutes of progress are still refused.

Cover and stream URLs are also mirrored at `/abs/api/books/{book_id}/cover` and `/abs/api/books/{book_id}/tracks/{track_id}/stream` (media token accepted), because some clients resolve content URLs against the `/abs` base while others resolve against the origin. Book-access restrictions apply exactly as on the native API.

## Conventions

- Request and response bodies are JSON unless otherwise noted.
- Errors return JSON of the shape `{ "message": "..." }` with an appropriate 4xx/5xx status.
- Stream bodies (cover art, audio, readalong, zip download) return their native MIME types.

## CORS

Same-origin requests need no CORS configuration. The server allows the official OperaLibre iOS, Android, and macOS app origins by default. For a custom frontend served from a different origin than the API, add its full origin to `allowed_origins` in `server.config` (or put both behind one reverse proxy).
