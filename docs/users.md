---
title: Users & Accounts
nav_order: 6
---

# Users & Accounts

The server requires sign-in before any audiobook data is served. Accounts, sessions, and per-user progress are all handled by the Rust backend.

## First-run setup

The first browser to load the app sees a one-time setup form that creates the initial administrator account. After that, the home screen is a standard sign-in form. There is no way to skip auth — even the library list is gated.

If you ever delete `users.json`, the server returns to first-run mode on the next request.

## Storage

| Item | Where | Format |
| --- | --- | --- |
| Accounts | `data/users.json` (configurable via `users_file`) | JSON, passwords hashed with [Argon2id](https://en.wikipedia.org/wiki/Argon2) |
| Progress | `data/progress.json` (configurable via `progress_file`) | JSON, keyed per user and per book |
| Sessions | `data/sessions.json` | JSON, random opaque tokens |

Sessions are persisted to disk, so restarting the server does not sign anyone out. Each session expires 30 days after sign-in.

## Roles

- **Administrator** — can add and remove readers, reset any password, upload books, run library rescans and readalong sync generation, and (if enabled) drive the Libation integration.
- **Reader** — can browse, stream, and update their own progress and password.

The first account created is always an administrator.

## Managing readers

From the web app, open the avatar menu in the library pane and choose **Manage readers**. From there an admin can:

- Add a new reader (username + initial password)
- Remove a reader (their progress is also removed)
- Reset any reader's password

Each reader has independent progress, so a household can share one server without stepping on each other's bookmarks.

## How authentication is wired

The web app exchanges a username + password for a session token. The token is sent:

- As a cookie/`Authorization` header for normal API calls
- As a `?token=` query parameter on `<audio>` and `<img>` URLs, so plain HTML elements stay authenticated when streaming audio, fetching cover art, or downloading a zip of a book

Tokens are random opaque strings. Sessions end on logout, account deletion, or 30 days after sign-in.

Failed sign-ins are rate limited per username: after 5 consecutive failures, further attempts for that username are rejected for 60 seconds.

## Resetting a forgotten admin password

Accounts are plain JSON on disk, so a lost admin password is recoverable:

1. Stop the server.
2. Open `data/users.json` and delete the offending user object — or delete the whole file to return to first-run setup.
3. Restart the server.

If you delete just one user, another admin can create them again with a new password. If you delete the file, the next browser to load the app gets the setup form.

> Avoid hand-editing the password hash. Argon2 hashes include parameters and salts; let the server generate them.
