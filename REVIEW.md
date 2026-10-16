# Review instructions

OperaLibre is a self-hosted audiobook server: a Rust `axum` API in
`apps/server`, a React frontend in `apps/web` shared by the web app and the
Capacitor iOS and Android apps, and native code for background audio,
downloads, lock-screen controls, and CarPlay. `AGENTS.md` holds the project
rules; its "Project invariants" section is the detail behind this file.

Failure here means a listener loses their place, their data leaks, or an
existing install or client breaks. Every posted thread must be resolved before
merge, so each finding costs a commit and another review round. Post only what
is worth that.

## Important

Reserve Important for findings that cause one of these, including on rare
paths: a failed fetch, a reconnect, a reinstall, a second device, a server
that disappears mid-session.

- **Progress loss.** Saving 0:00 or an uninitialized position, saving from a
  session the listener never played or seeked, letting a stale or near-zero
  write outrank newer progress, dropping a pending seek, or resuming without
  reconciling with the server.
- **Server state.** A data-dir store written without `write_json_atomic` or
  `write_bytes_atomic`, a migration an existing install can't read, or an
  upgrade that loses the sync queue, schedules, or `sync-checkpoints/`.
- **Access.** A route guarded only by the UI instead of `require_admin`,
  `require_owner`, or a per-user check; one user reaching another's progress
  or history; credentials or tokens in logs, errors, or responses; a new
  outbound connection the owner didn't turn on.
- **Compatibility.** A changed response shape in the Audiobookshelf-compatible
  API, OPDS, or `docs/api.md`; a `server.config` key without a safe default;
  an API origin baked into client code.
- **Updates and release.** A launcher, updater, or manifest change that can
  leave an install unable to verify, apply, or roll back an update; a workflow
  change that exposes secrets or signing keys to pull-request code, or an
  action not pinned to a full commit SHA.
- **Follow-along.** Follow-along offered without a real alignment, or an
  unknown precision treated as followable.
- **Hot-path cost.** New work on every playback tick, a continuously
  repainting animation, or work that newly scales with library size. Servers
  run on a NAS or a Raspberry Pi.

Everything else is Nit at most.

## Always check

- **Intent.** The change does what its description says and leaves alone what
  it says is unchanged. Shared frontend code reaches the native apps, the Duo
  layout, the mini player, CarPlay, Jellyfin servers, and demo mode. On a
  `fix:` pull request, check that it fixes the cause, not one symptom, and
  fold a missed cause into the finding it explains when there is one.
- **Every instance.** Report a bug class once and list every place it occurs.
  Progress logic exists in pairs that must agree: the web player and
  `AudiobookPlayer.swift` / `CarPlayCoordinator.swift`;
  `summarize_book_progress` and `summarizeBookProgress`;
  `progress_write_is_suspect_reset` and `isSuspectProgressReset`; the progress
  routes in `progress.rs` and `abs.rs`.
- **Partial failure.** A multi-step action that fails partway rolls back or
  leaves a state the user can see.
- **`MAPPING_REVISION`** changes only with a stated reason to remap, never
  from a version number.
- **Tests and docs.** A progress or sync change with no test of its failure
  path, a test that sleeps instead of waiting on a condition, or a change that
  makes `docs/` or a line of `AGENTS.md` wrong is a Nit.

## Evidence

- Cite `file:line` for every claim; don't infer behavior from a name.
- Path traversal and injection findings trace the request value to the
  filesystem or process call. IDs pass through `is_plain_file_token`,
  `sanitize_filename`, or hashing first; show how the value gets past them.
- Native claims (iOS, Android, macOS, CarPlay) cite the Swift or Java source.
- Race claims spell out the interleaving.

## Do not report

- What CI enforces: formatting, Clippy, ESLint, TypeScript, RustSec and npm
  audits, dependency review, CodeQL.
- Lockfiles, bundled assets under `apps/web/public/`, and build output.
- Fake values in tests and fixtures.
- Commit authorship, trailers, signatures, branch names, and pull request
  template sections.
- Missing tests for behavior the PR doesn't change.
- Pre-existing issues that wouldn't be Important.

## Nits and re-reviews

- At most three Nits, and only on the first review of a pull request.
- On a re-review, report only what the new commits introduce or fail to fix,
  and don't repeat a finding the author answered with a reason.
- If the same area needs a third round, say so and suggest reconsidering the
  approach instead of posting another line-level fix.

## Summary

Start with the number of Important findings. When there are none, say plainly
that there is nothing to fix.
