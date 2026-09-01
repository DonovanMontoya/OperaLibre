---
title: Users & Accounts
nav_order: 6
---

# Users & Accounts

The server requires sign-in before any audiobook data is served. Accounts, sessions, and per-user progress are all handled by the Rust backend.

## First-run setup

The first browser to load the app sees a one-time setup form that creates the initial owner account. `local` setup needs no extra credential and rejects remote setup. `lan` setup is open to any device on the trusted network — like the sign-in form itself, it relies on the network being private, so complete setup promptly after starting an unclaimed server — the open window never expires on its own, and the server logs a warning at startup for as long as no owner account exists. In `proxy` mode every setup request must include the random bootstrap token printed in the server console or `data/server.log`, which remains safe even if forwarded client headers are misconfigured; the token expires after 30 minutes, is consumed after setup, and is never saved to the account store. After that, the home screen is a standard sign-in form. There is no way to skip auth — even the library list is gated.

If the server starts with no accounts at all — a brand-new `data` directory — it returns to first-run mode.

## Storage

Accounts, sessions, progress, per-book settings, and the reading log all live in one SQLite database, `data/operalibre.db`. Passwords are hashed with [Argon2id](https://en.wikipedia.org/wiki/Argon2); session tokens are random opaque strings. Installations upgraded from an older release had their `users.json`, `progress.json`, and sibling JSON files imported into the database once, with the originals left in place (and copied to `data/backup-pre-sqlite/`) as a rollback path — they are never read again after the import.

Sessions are persisted, so restarting the server does not sign anyone out. Each session expires 30 days after sign-in.

## Roles

- **Owner** — has full administrator access and can promote or demote owners and administrators. Owners always have direct Libation downloads and request-approval permission.
- **Administrator** — can add and remove readers, reset reader passwords, upload books, and run library operations. An owner separately chooses whether each administrator downloads directly or requests each title, and whether they can approve requests.
- **Reader** — can browse, stream, and update their own progress and password.

The first account created is always an owner. When upgrading an existing server, the oldest existing administrator becomes the initial owner; existing administrators retain direct-download and approval permissions.

## Managing accounts

From the web app, open **Administration → Users & access**. Owners can:

- Promote or demote accounts between owner, administrator, and reader
- Choose direct downloads or approval-required requests for each administrator or reader
- Grant or revoke request-approval permission for administrators
- Create, reset, and remove administrator accounts

Administrators can:

- Add a new reader (username + initial password of at least 12 characters)
- Remove a reader (their progress is also removed)
- Reset a reader's password
- Choose whether a reader can download Libation titles directly or must request approval for each title

Each reader has independent progress, so a household can share one server without stepping on each other's bookmarks.

## How authentication is wired

The web app exchanges a username + password for a session token. The token is sent:

- As a cookie/`Authorization` header for normal API calls
- As a `?token=` query parameter on `<audio>` and `<img>` URLs, so plain HTML elements stay authenticated when streaming audio, fetching cover art, or downloading a zip of a book

Tokens are random opaque strings. Sessions end on logout, account deletion, or 30 days after sign-in.

Failed sign-ins are rate limited: after 5 consecutive failures for a username (or 25 from one address), further attempts are rejected for 60 seconds.

## Resetting a forgotten admin password

The server owner — the person with shell access to the machine — can recover a lost owner password through the JSON export path:

1. Stop the server.
2. From the installation folder, run `./operalibre-server --export-json`. This writes the database contents out as JSON files in the `data` folder and exits.
3. Move `data/operalibre.db` (and any `operalibre.db-wal`/`operalibre.db-shm` files) out of the way.
4. Open `data/users.json` and delete the offending user object — or delete the exported JSON files entirely to return to first-run setup.
5. Restart the server. It re-imports the edited JSON files into a fresh database.

If you delete just one user, an authorized administrator can create them again with a new password. The server will not allow the final owner to be deleted or demoted. If you removed everything, complete first-run setup again; it follows the same per-mode rules as the first run, including the `proxy`-mode one-time token.

> Avoid hand-editing the password hash. Argon2 hashes include parameters and salts; let the server generate them.
