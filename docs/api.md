---
title: API Reference
nav_order: 8
---

# API Reference

All endpoints are served by the Rust backend on `host:port` (default `0.0.0.0:4000`). With the exception of a small public surface, every endpoint requires an authenticated session.

The included React/Vite app is one client for this API. Custom web, mobile, desktop, or native frontends can use the same endpoints as long as they follow the authentication and media URL conventions below.

## Authentication

The web app obtains a session token via `POST /api/auth/login`. The token is sent on subsequent requests; streaming endpoints also accept the token as a `?token=` query parameter so plain `<audio>` and `<img>` elements work.

### Public endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness probe. Returns `200 OK` when the server is up. |
| `GET` | `/api/auth/status` | Reports whether first-run setup is needed. |
| `POST` | `/api/auth/setup` | One-time admin creation. Only accepted when no users exist. |
| `POST` | `/api/auth/login` | Exchange username + password for a session token. |

### Authenticated endpoints

#### Sessions and self

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/auth/logout` | Invalidate the current session. |
| `GET` | `/api/auth/me` | Return the current user. |
| `GET` | `/api/profile/stats` | Listening stats for the current user. |

#### User management (admin)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/users` | List readers. |
| `POST` | `/api/users` | Create a reader. |
| `DELETE` | `/api/users/{user_id}` | Delete a reader. |
| `POST` | `/api/users/{user_id}/password` | Reset a reader's password. |
| `PUT` | `/api/users/{user_id}/book-access` | Set a reader's allowed book IDs. Send `{ "allowedBookIds": null }` for the full library or an array for a restricted shelf. |

#### Library

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/books` | List books the current user is allowed to access. Administrators always receive the full library. |
| `GET` | `/api/books/{book_id}` | Detailed metadata, tracks, and chapters for one book. |
| `GET` | `/api/books/{book_id}/cover` | Cover art image (extracted from tags or sidecar). |
| `GET` | `/api/books/{book_id}/readalong` | The companion readalong file, if one is matched. |
| `GET` | `/api/books/{book_id}/sync` | The readalong sync map (`.sync.json`), if one is matched or generated. |
| `POST` | `/api/books/{book_id}/sync/generate` | Start a background job that force-aligns the audio against the EPUB companion and writes a sync map. Admin only; requires the alignment CLI. Returns `{ "jobId": "..." }`. |
| `GET` | `/api/alignment/status` | Whether an alignment CLI was found: `{ "enabled": bool, "cliPath": string \| null }`. |
| `GET` | `/api/books/{book_id}/download` | Zip download of all the book's files. |
| `DELETE` | `/api/books/{book_id}/download` | Delete the server's local copy. Admin only; Libation catalog state, progress, metadata overrides, and access grants are retained for later redownload. |
| `GET` | `/api/books/{book_id}/progress` | Playback progress for the current user and book. |
| `PUT` | `/api/books/{book_id}/progress` | Save playback progress for the current user and book. |
| `POST` | `/api/library/rescan` | Re-scan `library_root` for changes. Admin only. |
| `POST` | `/api/library/upload` | Upload one or more audio files as a new library folder. Admin only; multipart fields are `bookName` and one or more `files`. |

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
  "durationSeconds": 36000.0
}
```

#### Libation (optional, admin only)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/libation/status` | Configured accounts and their auth state. |
| `GET` | `/api/libation/books` | Audible library known to Libation. |
| `POST` | `/api/libation/sync` | Refresh Libation's library scan. |
| `GET` | `/api/jobs` | List background jobs, newest first (the server keeps the most recent 50). |
| `GET` | `/api/jobs/{job_id}` | Poll a background job (e.g., liberation download). |

These endpoints require an administrator session. If Libation is not configured they respond with an explanatory error.

## Conventions

- Request and response bodies are JSON unless otherwise noted.
- Errors return JSON of the shape `{ "message": "..." }` with an appropriate 4xx/5xx status.
- Stream bodies (cover art, audio, readalong, zip download) return their native MIME types.

## CORS

The server is intended for same-origin usage (web UI built into the deployment, or proxied through Vite in dev). It does not emit permissive CORS headers by default. If you serve the web bundle from a different origin than the API, you'll need to put both behind a single reverse proxy.
