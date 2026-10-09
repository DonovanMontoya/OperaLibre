# OperaLibre

Guidance for coding agents and automated tools working in this repository.
Human contributors should start with [CONTRIBUTING.md](CONTRIBUTING.md); the same
expectations apply to agent-authored changes.

OperaLibre is a private, self-hosted audiobook server: a Rust `axum` API, a
React/Vite web frontend, and native clients that package that frontend. Read the
code and docs relevant to the requested change; a full repository tour is
unnecessary.

## What we never compromise on

1. **Listening progress is sacred.** A lost or reset position is the worst bug
   this project can ship. See [Playback progress](#playback-progress).
2. **Private and self-hosted.** Readers' libraries, accounts, and listening
   history stay on their own server. No telemetry or analytics, no new
   outbound connections without a reason the owner can see, and optional
   integrations (Audible, Libro.fm, Jellyfin) stay optional.
3. **Runs on modest hardware.** Home servers are often a NAS, a Raspberry Pi, or
   an old laptop. Watch payload sizes, scan cost, memory, and needless
   re-renders; UI animations must not repaint continuously.
4. **Works from anywhere the owner allows.** Loopback, plain HTTP on a home LAN,
   Tailscale, and HTTPS behind a reverse proxy are all real deployments, and the
   phone apps keep working offline with downloaded books.
5. **Every surface.** Web, iPhone (including CarPlay), Android, macOS, and
   third-party clients using the Audiobookshelf-compatible API or OPDS all
   depend on this server.

## Approach

Prefer simple systems and the smallest change that makes the correct behavior
unsurprising. Do not keep complexity just because it exists, and do not add
machinery because it looks architecturally impressive. Measure twice, cut once,
and fight scope creep: honor the requester's intent minimally and realistically.

Treat this file as good defaults, not scripture; the developer directing you can
override it. If a rule here fights the task in front of you, say so plainly and
get a human decision before breaking it.

## Glossary

- **Owner / administrator / reader** — account roles; see `docs/users.md`.
- **Library** — the audiobook folder at `library_root`.
- **Book** — one title on disk; **work** — the same book across editions, rips,
  and ISBNs, which carries reading history between copies.
- **Companion** — an EPUB, PDF, or text file read alongside the audio.
- **Sync map** — sentence timings for follow-along reading.
- **Data dir** — server state: SQLite database, users, progress, and Audible
  account data (`data/` by default).

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `killall`, or kill a PID found by
   matching a name or path. Other checkouts, worktrees, and the developer's own
   OperaLibre may be running on this machine. Kill only a PID you captured when
   you started the process, or the owner of your port after confirming it runs
   from your checkout.
2. **Touching real data.** The developer's `data/`, `server.config`, and library
   are live user data, and the data dir can hold Audible credentials. Read or
   copy from them; never delete, rewrite, restore, or migrate them in place, and
   never point an experimental server at a real library with write features
   (uploads, deletions, imports, MP4 conversion). Use a scratch data dir and
   library instead — see [Test data](#test-data).
3. **Baking in origins.** Leave `VITE_API_BASE` unset for development and
   packaged builds. Development is single-origin through the Vite proxy, and the
   native apps choose their server at runtime; a baked-in `localhost` address
   silently breaks every other device.

## Repository map

| Area | Start here |
| --- | --- |
| API, streaming, scanning, progress sync | `apps/server` (Rust) |
| Web UI and shared Capacitor frontend | `apps/web` (React/Vite) |
| iOS and Android shells | `apps/web/ios`, `apps/web/android` |
| macOS host app | `apps/macos`, `Package.swift` |
| Background launcher and updater | `apps/launcher` (Rust) |
| Follow-along sync add-on | `addons/readalong-sync`, `script/follow-along` |
| Build, packaging, and test scripts | `script/`, `release/` |
| Documentation site | `docs/` (Jekyll) |
| CI and release automation | `.github/workflows/` |

## Setup

Requires Node.js 22.12+ and a Rust toolchain. Install with `npm ci` from the
checked-in lockfile.

`server.config` is local and gitignored. If it is missing, copy
`server.config.example` and set `library_root`; never overwrite an existing one.
To run a server against scratch state, write a separate config outside the
checkout that sets `library_root`, `data_dir`, and a free `port`, and point
`OPERALIBRE_SERVER_CONFIG` at it. Values in a config file take precedence over
`OPERALIBRE_LIBRARY` and `OPERALIBRE_DATA_DIR`, so those variables alone do not
isolate a server started beside an existing `server.config`.

- `npm run dev` — server and web dev server together.
- `npm run typecheck` — Rust and TypeScript type checks.
- `npm run build` — release server, launcher, and web build.
- `npm run build:android`, `npm run build:ios`, `./script/build_and_run.sh` —
  native builds. Run `npm run sync:android` / `npm run sync:ios` after frontend
  changes that must reach a native build.

Stop what you started, by the PID you tracked.

## Hit every surface

The most common defect is a change that works on the path you tested and is
missing everywhere else. Before calling work done, walk this list and say which
entries applied:

- **Entry points.** Behavior reachable from the player is often also reachable
  from the library, book details, administration, the mini player, the
  companion reader, and lock-screen or CarPlay controls.
- **Clients.** Web, iPhone, Android, and macOS share the React frontend but have
  native code for downloads, background audio, media sessions, and CarPlay.
- **Server types.** The apps also connect to Jellyfin servers and run an offline
  demo mode. Decide per server type, even if the answer is "not supported".
- **External APIs.** Server changes can affect the Audiobookshelf-compatible
  API, OPDS, and `docs/api.md` consumers.
- **Roles.** Check owner, administrator, and reader permissions, including what
  a reader must not see.
- **Reverse states.** If you added a way in, add the way out and a way to see
  it: download and remove, request and cancel, hide and unhide.
- **Connection modes.** Loopback, LAN HTTP, Tailscale, HTTPS proxy, offline, and
  a server that disappears mid-session behave differently.
- **Docs.** Check whether the change makes existing guidance inaccurate.

## Test data

An empty library is a weak test. Build a scratch copy instead of using live state:

- Use a small folder of real or generated audio as the library; the lifecycle
  suite in `apps/web/test/lifecycle` shows how disposable fixtures are built.
- To start from real state, snapshot the database with SQLite's `VACUUM INTO`,
  which is safe while a server has it open:

  ```bash
  mkdir -p /tmp/ol-scratch/data
  sqlite3 "file:data/operalibre.db?mode=ro" "VACUUM INTO '/tmp/ol-scratch/data/operalibre.db'"
  ```

  A plain `cp` of a live WAL database is a corrupt copy.
- Copy the JSON state files you need alongside it. Leave out Audible account
  data unless the flow under test needs it.
- Copy in, never symlink. Data flows one way: into your scratch space, never back.

## Validation

`.github/workflows/ci.yml` is the source of truth for required checks. Start with
the smallest proof that the change works, then run the checks for the areas you
changed, fix failures your change caused, and rerun them.

- Rust (`apps/server`, `apps/launcher`): `cargo fmt --check`,
  `cargo clippy --locked --all-targets -- -D warnings`, and
  `cargo test --locked`, each with `--manifest-path` for the affected crate.
- Web: `npm run lint -w @operalibre/web`, `npm test -w @operalibre/web`, and
  `npm run build -w @operalibre/web`.
- Packaging, launcher handoff, native, lifecycle, follow-along, and performance:
  use the matching scripts and CI jobs when those behaviors change. See
  `docs/lifecycle-testing.md` and `script/performance/README.md`.
- Documentation-only changes do not require rebuilding clients.

Test meaningful logic and observable behavior. Do not add tests that only mirror
the implementation or assert that a callback was wired. Wait on real conditions,
not sleeps; a test that needs a longer timeout to pass is wrong.

When reporting results, say which checks ran and where: local command, browser,
simulator, physical device, or remote CI. Do not describe a change as ready to
merge based on a passing subset of checks.

## Project invariants

### Playback progress

When changing playback, progress, or sync, preserve:

- restoration of position from book-list summaries;
- retries after a failed progress fetch;
- pending-seek targets in persisted state;
- the guard against writing progress before playback is touched.

Opening and closing a book must never reset another device's position or write an
uninitialized 0:00. Exercise the affected failure path, not only the happy path.

### Read-along mapping revisions and recovery

When changing alignment or preparing a release, decide whether existing maps
would benefit enough from regeneration to recommend remapping. The decision is
explicit; a release or dependency version bump alone is not a reason to remap.

- `MAPPING_REVISION` in `apps/server/src/alignment.rs` is the remapping threshold.
  Increment it only for an intentional remapping recommendation, and explain
  the improvement in the release notes. Do not reset it or derive it from an
  application or add-on version. Ordinary releases leave it unchanged.
- New maps carry that value as `mappingRevision`. Older generated maps (missing
  revision means 0) show **Outdated map** and become eligible for an enabled
  nightly sweep. Existing maps remain usable; current maps and external maps
  without OperaLibre's generator provenance are not expired.
- `SYNC_MAP_VERSION` describes the JSON format, not mapping quality. The version
  in `addons/readalong-sync/package.json` controls publishing the separate
  runtime package. Neither replaces `MAPPING_REVISION`; a server-side alignment
  improvement can warrant remapping without changing the add-on package.
- Preserve the durable `sync-jobs.json`, `sync-schedules.json`, and
  `sync-sweep.json` stores across upgrades. Queue recovery retains job IDs and
  resumes interrupted books from the last completed chapter or track after the
  library and runtime are ready. An unfinished section repeats; paused jobs
  stay paused. Preserve `sync-checkpoints/` alongside the queue. Changed inputs
  or alignment settings invalidate checkpoints; recognition windows are not saved.
  Server updates stop workers before launching the updater, save the queue for
  automatic recovery, and preserve manual pauses. Failed/cancelled preparations
  release update exclusion and resume interrupted work on the current server.
- For a revision change, verify that older generated maps become outdated,
  current maps stay current, remapping clears the badge, and nightly batches
  include outdated maps while respecting the saved limit. Keep
  `docs/using-operalibre.md` and `docs/api.md` accurate when these contracts change.

### Configuration compatibility

New `server.config` keys need safe defaults so existing installs keep working.
Document them in `docs/configuration.md` and update the packaged defaults in
`release/combined.config` and `release/server-only.config` when relevant.

### API compatibility

Third-party clients build against the server API and its
Audiobookshelf-compatible and OPDS endpoints. Avoid breaking response shapes;
update `docs/api.md` and `docs/client-compatibility.md` when behavior changes.

## Code conventions

- Match the style, naming, and comment density of the surrounding code.
  Comments explain how something is used or why it is unusual, not what each
  line does.
- Keep changes scoped to the task; do not reformat or refactor unrelated code.
- Behavior changes ship with focused tests for that behavior.
- Do not commit secrets, local config, libraries, or generated output
  (`server.config`, `data/`, `output/`, `dist/`).

## Documentation

`docs/` is the published user site. Write it for people running and using
OperaLibre, in the product's voice, without contributor tooling or
implementation detail.

- Update the relevant section when how to use, configure, or install something
  changes. A small UI tweak does not need a docs entry, and a new control does
  not need its own page.
- Explain what a feature does, how to start, and anything unintuitive; do not
  describe every button or UI state.
- When behavior changes, rewrite the affected text; do not append a second
  account of the new behavior.
- Implementation reasoning belongs in a code comment near the code. Readers of
  the source do not need a narrated tour of it.

## Plans and work artifacts

Do not commit implementation plans, research notes, scratch scripts, or PR-only
screenshots. Keep temporary material outside the checkout. The merged PR is the
record of the work.

## Version control and pull requests

Use Git. Do not initialize a Jujutsu store in a checkout or worktree.

- Do not push branches or open PRs unless the developer asks you to.
- Branch names use a `feat/`, `fix/`, `chore/`, or `docs/` prefix and a short
  description.
- Commit messages and PR titles use the same conventional prefix, in plain
  language: `fix: sleep timer survives track changes`.
- One concern per PR. If the description needs "also", split it.
- PR body: the problem in a sentence or two, how you fixed it, and how you
  tested it, following the pull request template.
- Visible changes need before/after screenshots; motion, gestures, and playback
  timing need a short recording. Upload them to the PR, not the repository. If
  you cannot capture them, say so in the PR.
- Disclose AI assistance. Every commit written with AI help ends with a
  `Co-Authored-By:` trailer naming the model used, for example
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` or
  `Co-Authored-By: GPT-5 <noreply@openai.com>`, and the PR's "AI assistance"
  section lists the models and tools used. Do not add session links.
- Never disable commit signing or change the configured author to get past a
  prompt; report the blocker instead.
- When addressing review: verify each finding against the source, fix real ones,
  and reply with a reason when dismissing one.

## Maintainers

These apply only to maintainers with write access.

- Merge PRs with merge commits (`gh pr merge N --merge`).
- After a force-push, inspect `git status` and `git diff` against the remote
  branch before resetting or rebasing; drop only commits confirmed obsolete.
- Before version bumps or releases, apply [Read-along mapping revisions and
  recovery](#read-along-mapping-revisions-and-recovery); state any remapping
  recommendation in the release notes.
- Releases: dispatch `.github/workflows/release.yml` from `main` with a blank
  `tag` (the workflow picks the next patch) and notes written from the actual
  diff since the previous release, passed as a file or structured input. Use an
  explicit tag only for a rebuild or deliberate version jump. The source commit
  must be in `origin/main`. Native clients can be versioned separately; check
  their version files. Follow the run to completion and verify the published
  release and assets. A `docs/**` push to `main` redeploys the docs site.
