---
title: API Reference
nav_order: 7
---

# API Reference

All endpoints are served by the Rust backend on `host:port` (default `0.0.0.0:4000`). With the exception of a small public surface, every endpoint requires an authenticated session.

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

#### Library

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/books` | List all books in the library. |
| `GET` | `/api/books/{book_id}` | Detailed metadata, tracks, and chapters for one book. |
| `GET` | `/api/books/{book_id}/cover` | Cover art image (extracted from tags or sidecar). |
| `GET` | `/api/books/{book_id}/readalong` | The companion readalong file, if one is matched. |
| `GET` | `/api/books/{book_id}/download` | Zip download of all the book's files. |
| `POST` | `/api/library/rescan` | Re-scan `library_root` for changes. |

Audio tracks are streamed with HTTP range requests for seeking. The exact track URL is included in the book detail response.

#### Libation (optional)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/libation/status` | Configured accounts and their auth state. |
| `GET` | `/api/libation/books` | Audible library known to Libation. |
| `POST` | `/api/libation/sync` | Refresh Libation's library scan. |
| `GET` | `/api/jobs/{job_id}` | Poll a background job (e.g., liberation download). |

If Libation is not configured these endpoints respond with an explanatory error.

## Conventions

- Request and response bodies are JSON unless otherwise noted.
- Errors return JSON of the shape `{ "error": "message" }` with an appropriate 4xx/5xx status.
- Stream bodies (cover art, audio, readalong, zip download) return their native MIME types.

## CORS

The server is intended for same-origin usage (web UI built into the deployment, or proxied through Vite in dev). It does not emit permissive CORS headers by default. If you serve the web bundle from a different origin than the API, you'll need to put both behind a single reverse proxy.
