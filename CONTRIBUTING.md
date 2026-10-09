# Contributing to OperaLibre

Thanks for your interest in improving OperaLibre. Bug reports, fixes, docs
improvements, and features are all welcome.

## Before you start

- **Bugs:** search existing issues first. A good report includes your OperaLibre
  version, server OS, the client (web browser, iPhone, Android, macOS, or a
  third-party app), steps to reproduce, and relevant server logs.
- **Features and larger changes:** open an issue to discuss the approach before
  writing a lot of code, so your work fits the project's direction.
- **Security issues:** do not open a public issue. Report privately through
  [GitHub security advisories](https://github.com/DonovanMontoya/OperaLibre/security/advisories/new).

## Development setup

You need Node.js 22.12+, Rust, and a folder with a few audiobook files.

```bash
git clone https://github.com/DonovanMontoya/OperaLibre.git
cd OperaLibre
npm ci
cp server.config.example server.config
# edit server.config: set library_root to your audiobook folder
npm run dev
```

Open <http://localhost:5173> and create the first administrator account. See the
[README](README.md#build-and-run-from-source) for native app builds and
[Configuration](docs/configuration.md) for every option.

| Area | Location |
| --- | --- |
| Server (Rust/axum) | `apps/server` |
| Web app and shared mobile frontend (React/Vite/Capacitor) | `apps/web` |
| macOS host app | `apps/macos` |
| Launcher and updater | `apps/launcher` |
| Documentation site | `docs/` |

## Making a change

1. Create a branch named with a `feat/`, `fix/`, `chore/`, or `docs/` prefix,
   for example `fix/sleep-timer-reset`.
2. Keep the change focused: one concern per PR. If the description needs
   "also", split it. Unrelated refactors and formatting belong in a separate PR.
3. Add or update tests for behavior changes.
4. Update the docs in `docs/` when you change behavior, configuration, or setup.
   New `server.config` options must have safe defaults so existing installs keep
   working.
5. Use conventional commit messages: `fix: keep sleep timer across track changes`.

### Playback progress

Listening position is the data users care about most. If you touch playback,
progress, or sync, make sure that opening and closing a book never resets
another device's position or saves 0:00, and test what happens when the network
or server fails mid-session. [Lifecycle testing](docs/lifecycle-testing.md)
covers the automated browser checks for this.

## Checks

CI runs the jobs in [`.github/workflows/ci.yml`](.github/workflows/ci.yml). Run
the ones for the parts you changed before opening a PR:

```bash
# Server (repeat with apps/launcher/Cargo.toml for launcher changes)
cargo fmt --check --manifest-path apps/server/Cargo.toml
cargo clippy --locked --all-targets --manifest-path apps/server/Cargo.toml -- -D warnings
cargo test --locked --manifest-path apps/server/Cargo.toml

# Web
npm run lint -w @operalibre/web
npm test -w @operalibre/web
npm run build -w @operalibre/web
```

Native, packaging, lifecycle, and performance changes have their own scripts; see
[lifecycle testing](docs/lifecycle-testing.md) and the
[performance suite](script/performance/README.md). Docs-only changes don't need
client builds.

## Pull requests

Fill in the pull request template. In particular:

- **Describe what changed and why**, and link the issue it addresses.
- **Say how you tested it** — which commands you ran and on which clients
  (browser, iOS simulator, Android emulator, physical device).
- **Include before and after screenshots for any visible change.** Put them side
  by side in the template's table. Capture the same screen and state in both,
  and include mobile widths or native clients if the change affects them. A
  short screen recording is better for animations, gestures, and playback
  behavior. Drag them into the PR description rather than committing them.
  Crop out or blur personal library contents, server addresses, and account
  names.
- **Check every surface the change touches.** A feature fixed in the web
  player may also appear in the mini player, on phones, in CarPlay, or for a
  Jellyfin server. Note which ones you checked.
- **Performance changes:** include before/after numbers from the
  [performance suite](script/performance/README.md).
- Keep the PR in draft until CI passes and you're ready for review.

PRs are merged with merge commits once CI passes and review is complete.

## AI-assisted contributions

You're welcome to use AI coding tools. [AGENTS.md](AGENTS.md) holds project
guidance for them. You are responsible for every line you submit: review it,
run the checks, and make sure the screenshots and testing notes reflect what
you actually ran.

AI assistance must be disclosed:

- **Commits:** end each commit written with AI help with a `Co-Authored-By:`
  trailer naming the specific model, for example:

  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Co-Authored-By: GPT-5 <noreply@openai.com>
  ```

- **Pull requests:** fill in the template's "AI assistance" section with the
  models and tools you used and what they helped with (for example, "Claude
  Opus 5.5 in Claude Code: drafted the migration and tests"). Write "None" if
  you didn't use any.

## License

OperaLibre is source-available under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md). By submitting a
contribution, you agree that it is provided under the same license.
