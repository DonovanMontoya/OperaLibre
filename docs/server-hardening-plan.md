# Server hardening and modernization plan

A phased plan for `apps/server`, derived from the August 2026 review. Each phase
is one pull request, gated by the existing CI (`fmt`, `clippy -D warnings`,
`cargo test`). Phases are ordered so that every risky change lands on top of a
safety net that already exists.

## Constraints that shape the ordering

- **Existing installs upgrade in place.** The Administration screen installs
  digest-verified update bundles onto live data directories. Any change to the
  on-disk format needs a forward migration, a pre-migration backup, and a
  documented way back.
- **There is no integration test harness today.** All 90 tests are unit tests
  inside `#[cfg(test)] mod tests`. Nothing exercises a route end to end, so a
  storage rewrite currently has no net under it.
- **Playback progress is the one thing that must never regress.** The stale
  write, clock skew, unintentional regression, and suspect reset defenses in
  `update_progress` are load bearing and must survive every refactor unchanged.

---

## Phase 0 — Durability and a safety net *(done)*

Small, independent, and a prerequisite for everything after it.

### 0a. Make `write_json_atomic` actually durable

`write_json_atomic` calls `flush()`, which only drains tokio's userspace
buffer. Neither the file's data nor the parent directory entry is ever synced,
so a power loss between the write and the next natural sync can leave a
zero-length or missing `progress.json`.

- Add `temp_file.sync_all().await` before the drop.
- Add a parent-directory `sync_all()` after the rename, so the rename itself is
  durable (Unix only; a no-op branch on Windows, where `ReplaceFile` semantics
  differ).
- Unit test: write, then assert the file is non-empty and parses.

### 0b. Integration test harness

Add `apps/server/tests/` with a helper that boots the router against a
`tempfile::TempDir` data directory and a fixture library, then drives it with
`tower::ServiceExt::oneshot`.

Minimum coverage before Phase 3 begins:

- setup, login, session cookie, logout
- `GET /api/books` for an admin and for a restricted reader
- range request against a track, including a mid-file range and an unsatisfiable one
- the full progress defense matrix: stale write, future-skewed clock, unintentional
  regression, suspect reset, and a legitimate forward write
- an admin-only route rejected for a non-admin

This harness is what makes Phase 4 a mechanical swap instead of a leap.

### 0c. Fixture library generator

A small helper that writes synthetic audio files with known tags so the scan
path is testable without committing binaries.

---

## Phase 1 — Split `main.rs` *(done)*

12,682 lines and 455 functions in one file. Purely mechanical, no behavior
change, reviewable by diffing the function list before and after.

Target layout:

```
src/
  main.rs           entry point, config load, router assembly
  config.rs         ServerConfig, DeploymentMode, parsing
  error.rs          ApiError
  auth/
    mod.rs          middleware, credential extraction, CSRF
    session.rs      Session, tokens, media tokens
    users.rs        User, UsersStore, roles, password handling
  library/
    mod.rs          LibraryState, rescan
    scan.rs         walk, group, fingerprint
    metadata.rs     tag extraction, chapters
    identity.rs     BookIdentity, TrackIdentity, fingerprint cache
  media.rs          serve_file_response, open_contained_file, ranges
  progress.rs       Progress, the write defense matrix, activity
  libation/         requests, accounts, login, refresh scheduler
  routes/           one module per route group
  storage/          (introduced in Phase 3)
  alignment.rs      unchanged
  faststart.rs      unchanged
  updates.rs        unchanged
```

Rule for this PR: move code, do not edit it. Any genuine fix found along the way
gets its own follow-up commit so the mechanical diff stays reviewable.

### Follow-ups left by the split

Both are consequences of keeping Phase 1 a pure move, and neither blocks later
phases.

- **The crate root is a de facto prelude.** Every module pulls the shared
  dependency imports in with `use crate::*`. That is what let the split happen
  without hand-editing hundreds of import lists, but it hides which module
  actually needs which dependency, and clippy cannot report an unused import
  through a glob. Tighten to explicit per-module imports.
- **`pub(crate)` is wider than necessary.** Every moved item and struct field
  was marked crate-visible so the move would compile. Now that module
  boundaries exist, much of it can be private again; the compiler identifies
  each case.

---

## Phase 2 — Make authorization un-forgettable *(done)*

There are 51 `is_admin` checks across 52 handlers that take
`Extension<AuthUser>`. A new route that forgets the check is a silent privilege
hole and nothing in CI catches it.

- Add an `AdminUser` extractor implementing `FromRequestParts`, which rejects
  with 403 unless the resolved user is an admin or owner.
- Convert every admin route's signature from `Extension<AuthUser>` to
  `AdminUser`, deleting the inline `if !auth.is_admin` check.
- Add `OwnerUser` for the owner-only routes, and `LibationApprover` for the
  approval routes, which currently combine two flags inline.
- **Reject unknown fields on permission payloads.** `UpdateBookAccessRequest`
  models `allowed_book_ids` as an `Option`, where `None` means "clear all
  restrictions". Because serde ignores unknown fields, a client that sends the
  wrong key name — `bookIds` instead of `allowedBookIds` — gets a `200` and
  silently grants that user the entire library. Found while writing the Phase 0
  tests. Add `#[serde(deny_unknown_fields)]` to the permission-bearing request
  types so a typo is a `422` instead of a privilege grant.
- Add an integration test that walks the router's route list and asserts every
  path under a known admin prefix rejects a reader session. This is the part
  that makes the guarantee stick for future routes.

After this, forgetting the guard is a compile error rather than a review miss.

---

## Phase 3 — Introduce a storage seam (still JSON) *(progress and settings done)*

This is the phase that turns Phase 4 from a rewrite into a swap. No behavior
change and no format change; only the call sites move.

Today the data access is spread across 16 `read_progress`/`write_progress`
sites, 5 `read_book_settings` sites, and 20 `library.read().await` sites, each
doing its own read-modify-write against a whole file.

- Define traits in `storage/`: `ProgressStore`, `BookSettingsStore`,
  `UserStore`, `SessionStore`, `ActivityStore`, `MetadataOverrideStore`,
  `LibationStore`.
- Give each the *narrow* operations the handlers actually need
  (`get(user, book)`, `put(user, book, progress)`, `list_for_user(user)`), not
  `read_everything()`. Narrow methods are what let the SQL implementation be
  efficient later.
- Implement them with the existing JSON files, keeping the current global
  write locks inside the implementation.
- Move every handler onto the traits. `AppState` holds
  `Arc<dyn ProgressStore>` and friends.
- The progress defense matrix moves into a pure function that the store calls,
  so it is testable without any I/O and identical across backends.

At the end of this phase the server behaves exactly as it does today, but the
storage backend is one type parameter away from being replaceable.

### Landed so far

`ProgressStore` and `BookSettingsStore` cover the hot path and the two stores
SQLite most needs to own. The progress decision rules are now a pure function,
`decide_progress_write`, tested without any I/O.

### Still to do in this phase

`UserStore`, `SessionStore`, `ActivityStore`, `MetadataOverrideStore`, and the
Libation stores still read and rewrite whole files from their handlers. They
are colder paths and none of them sit behind a per-request write, so they can
follow in a second commit without blocking Phase 4's design.

---

## Phase 4 — SQLite behind the seam

The highest-leverage change in the plan. It resolves the full-file
read-modify-write, the global write mutex, the linear `Vec` scans, and the
remaining durability questions in one move.

- Add `rusqlite` with the `bundled` feature, driven from `spawn_blocking`
  (matches the existing pattern; avoids pulling in a second async runtime
  layer). `sqlx` is the alternative if async-native queries are preferred, at
  the cost of a heavier dependency tree and compile-time DB setup.
- Enable WAL mode, `synchronous = NORMAL`, and `foreign_keys = ON`. WAL is what
  removes the write-serialization pain: readers stop blocking on the writer.
- Schema, keyed to match the current JSON shapes so migration is a straight
  translation:

  ```
  users(id PK, username UNIQUE, password_hash, is_owner, is_admin, ...)
  sessions(token PK, user_id FK, created_at, INDEX(user_id))
  books(id PK, path, fingerprint, ...)
  tracks(id PK, book_id FK, path, ordinal, duration_seconds, INDEX(book_id))
  progress(user_id, book_id, track_id, position_seconds, book_position_seconds,
           duration_seconds, updated_at, finished_override,
           PRIMARY KEY(user_id, book_id))
  book_settings(user_id, book_id, volume_gain, PRIMARY KEY(user_id, book_id))
  book_access(user_id, book_id, PRIMARY KEY(user_id, book_id))
  activity(user_id, day, seconds, PRIMARY KEY(user_id, day))
  metadata_overrides(book_id PK, ...)
  libation_*(...)
  schema_version(version)
  ```

- A progress checkpoint becomes a single indexed `INSERT ... ON CONFLICT DO
  UPDATE` inside a transaction. `progress_write_lock` is deleted. The read
  side of the defense matrix happens in the same transaction, which makes it
  strictly more correct than the current read-file/decide/write-file cycle.
- `GET /api/books` becomes one join instead of two full-file reads.

### Migration, which is the part that must not go wrong

1. On startup, if `operalibre.db` is absent and the JSON files are present, run
   the importer.
2. Before importing, copy every JSON file into `data/backup-pre-sqlite/`.
3. Import inside a single transaction; on any error, roll back, delete the
   partial DB, log loudly, and continue running on JSON.
4. Leave the JSON files untouched on disk for at least one release. Do not
   delete user data as part of an automatic upgrade.
5. Ship a `--export-json` flag that writes the SQLite contents back out in the
   original format, so a rollback to the previous release is a supported path
   rather than a restore-from-backup exercise.
6. Integration test: import a fixture JSON data directory, assert every record
   round-trips, assert the export reproduces the input.

---

## Phase 5 — Hot paths

With SQLite in place these become straightforward.

- **`GET /api/books` ETag and pagination.** Mobile clients currently pull the
  entire library on every foreground. Compute a per-user ETag from the library
  generation counter plus that user's progress `max(updated_at)`, honor
  `If-None-Match` with a 304, and add `?limit`/`?cursor`. Keep the unpaginated
  response as the default so existing clients do not break.
- **Session lookup for media tokens.** `resolve_media_session` currently scans
  every session and hashes each one, on the hottest route in the server. Store
  the derived media token as an indexed column and look it up directly. Compare
  with a constant-time equality.
- **Cover art out of RAM.** `cover_art: HashMap<String, EmbeddedImage>` holds
  every embedded image as `Vec<u8>`. Extract to `data/covers/<book_id>.<ext>`
  during the scan, keep only the path, mime type, and ETag in memory, and serve
  through the existing contained-file path. Turns a gigabyte-scale resident set
  into a few hundred bytes per book.
- **Parallel scan.** The metadata task reads every file's tags sequentially on
  one blocking thread. Move it to `rayon` over the file list. The fingerprint
  cache already avoids re-reading unchanged files, so this mostly pays off on
  first scan and large imports, which is exactly where the pain is.

---

## Phase 6 — Operational maturity

- **Graceful shutdown.** `axum::serve` currently has no signal handler. Add
  `with_graceful_shutdown` on SIGTERM/SIGINT, drain in-flight requests, flush
  and checkpoint the database. Matters for `operalibre.service` restarts and
  for the in-place update installer.
- **Request timeout and body limits.** Add `tower_http::timeout::TimeoutLayer`
  and an explicit `DefaultBodyLimit`, with the multipart upload routes opted
  out to their existing `max_upload_bytes` ceiling.
- **`/api/metrics`.** Owner-authenticated, plain JSON: library size, active
  sessions, scan duration, in-flight streams, DB size, last update check. No
  Prometheus dependency needed unless it is later wanted.
- **Nginx log scrubbing.** Media tokens ride in query strings by design, and
  the server's own tracing spans already drop them, but
  `operalibre-nginx.conf` will log them by default. Ship a `log_format` that
  strips `?token=`, and note the reason in `docs/deployment.md`.

---

## Phase 7 — Third-party client compatibility

The README already positions OperaLibre as a headless server other clients can
build against. Making that literally true is cheaper than writing more
first-party clients.

- **OPDS 1.2 / 2.0 feed** at `/opds`, with facets for author, series, and
  recently added.
- **Audiobookshelf-shaped endpoints** behind a compatibility module. The
  existing clients in that ecosystem — Prologue, ShelfPlayer, Voice — would
  then work against an OperaLibre server without any per-client work.
- Both are read-mostly surfaces layered over the Phase 4 queries; neither
  requires touching the native apps.

---

---

## Open concerns register

Anything noticed while doing the work that is not resolved by the commit that
found it. Fixed rows stay here with their commit: the record of what worried us
is part of the review history, and a reviewer arriving at one of these PRs
should not have to rediscover it.

Each row is mirrored into the body of the PR it belongs to.

| Id | Concern | Status | Raised in |
|---|---|---|---|
| C1 | The crate root is a de facto prelude. Every module pulls the shared dependency imports in with `use crate::*`, which hides which module needs which dependency and stops clippy reporting an unused import through the glob. | Open | Phase 1 |
| C2 | `pub(crate)` is wider than necessary. Every moved item and struct field was made crate-visible so the split would compile; much can be private again now that module boundaries exist. | Open | Phase 1 |
| C3 | Permission payloads accepted unknown fields, so a misspelled `allowedBookIds` cleared every restriction on a user and still returned 200. | Fixed — `30c59c1` | Phase 2 |
| C4 | `ProgressStore::list_for_user` keyed results by the stored `book_id` field while the code it replaced looked up by the composite storage key. The two resolve differently for any row whose copies disagree. | Fixed — `bb58f7f` | Phase 3 |
| C5 | `UserStore`, `SessionStore`, `ActivityStore`, `MetadataOverrideStore`, and the Libation stores still read and rewrite whole files from their handlers. Phase 3 is not complete until they move behind the seam. | Open | Phase 3 |
| C6 | The converted call sites in `activity.rs`, `faststart_jobs.rs`, and `auth.rs` were not differential-tested the way the progress rules were. They are simpler transpositions, but that is a judgement rather than a proof. | Open | Phase 3 |
| C7 | `ProgressStore::set` is `#[cfg(test)]` because only tests need it today. The SQLite migration wants the same primitive and should drop the gate rather than duplicating it. | Open | Phase 3 |
| C8 | `OwnerUser` carries no payload because no owner-only handler needs the acting user. A handler that does need it must add the `AuthUser` field back rather than reaching for `AuthUser` separately. | Open | Phase 2 |
| C9 | `http_tests.rs` lives in the crate rather than `tests/` because the server is a binary-only target. It should move unchanged once there is a library target. | Open | Phase 0 |
| C10 | `sync_parent_directory` is a no-op on Windows. The rename is still atomic there, but the durability guarantee is weaker than on Unix and nothing warns about it. | Open | Phase 0 |
| C11 | `resolve_media_session` scans every session and hashes each one on the hottest route in the server, and compares with a non-constant-time `==` even though `constant_time_eq` already exists in the crate. | Open | Review |
| C12 | Media tokens ride in query strings by design. The server drops them from its own tracing spans, but `operalibre-nginx.conf` will log them by default. | Open | Review |

## Sequencing summary

| Phase | Theme | Risk | Unblocks |
|---|---|---|---|
| 0 | fsync + integration tests | Low | Everything — **done** |
| 1 | Split `main.rs` | Low, mechanical | Reviewability — **done** |
| 2 | Typed auth extractors | Low | Permanent authz guarantee — **done** |
| 3 | Storage seam, still JSON | Medium | Phase 4 |
| 4 | SQLite | High, gated by 0 and 3 | Phase 5 |
| 5 | Hot paths | Medium | Scale |
| 6 | Operations | Low | Reliability |
| 7 | OPDS / ABS compatibility | Low | Ecosystem |

Phases 0 through 2 are safe to land in any order and could ship in a single
release. Phase 4 should ship alone, early in a release cycle, with the JSON
export path documented before it goes out.
