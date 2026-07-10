# OperaLibre

A private audiobook streaming app with a Rust media server and an iOS-ready web frontend. The current build scans a folder of audiobook files, streams tracks with HTTP range requests, and saves playback progress.

OperaLibre is also designed to work as a headless audiobook server. The included React/Vite web app is the reference frontend, but the Rust server exposes an HTTP API that other web, mobile, desktop, or native clients can build against.

## License

This project is source-available for personal and noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE.md).

Commercial use, resale, paid hosting, or inclusion in a paid product requires a separate commercial license from the copyright holder.

## What is included

- Library scanning for `.mp3`, `.m4b`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.opus`, `.wav`, and `.aiff`.
- Long-file streaming with byte-range support for seeking.
- Book and track browsing.
- Embedded cover art extraction and `/api/books/:bookId/cover` serving.
- Rich tag extraction for album/title, subtitle, author, narrator, publisher, dates, genres, language, description, and raw tag fields.
- Chapter extraction from M4A/M4B/MP4 chapter tracks or chapter lists, MP3 ID3 `CHAP` frames, and multi-file track boundaries.
- Readalong file detection and inline reading for `.epub`, `.pdf`, `.txt`, `.html`, and `.htm` companion files stored beside an audiobook.
- Sentence-level readalong sync for EPUB companions: the reader highlights the sentence being narrated, follows page and chapter changes, and seeks the audio when a sentence is clicked. Sync maps come from `.sync.json` sidecars or are generated server-side with an optional [echogarden](https://github.com/echogarden-project/echogarden) install.
- Playback position sync.
- Playback speed controls.
- 15-second rewind and 30-second forward controls.
- Sleep timer.
- Media Session integration for OS-level playback controls where supported.
- PWA manifest so the web app can be installed and later wrapped with Capacitor for iOS.

## Run locally

```bash
npm install
cp server.config.example server.config
npm run dev
```

Edit `server.config` before starting the server. At minimum, set `library_root` to the folder containing your audiobook files.

Open [http://localhost:5173](http://localhost:5173).

The server runs on [http://localhost:4000](http://localhost:4000). On another device on your network, use your computer's LAN IP and make sure the server is allowed through the firewall.

The backend is a Rust `axum` service in `apps/server`. The frontend is a React/Vite app in `apps/web`.

## Custom frontends

The server owns library scanning, authentication, metadata extraction, cover art, readalong files, progress sync, downloads, and byte-range audio streaming. Frontends can treat it as a standalone API/media server and implement their own browsing, playback, and device UX.

- Use `POST /api/auth/login` to obtain a session token.
- Send the token as `Authorization: Bearer ...` for JSON API requests.
- Add the token as `?token=...` for media URLs used directly by `<audio>`, `<img>`, or download links.
- Stream audio from the `streamUrl` returned by book detail responses; the server supports HTTP range requests for seeking.
- See [docs/api.md](docs/api.md) for the current endpoint list and response conventions.

For production deployments, the simplest setup is single-origin: build the web app with `npm run build` and set `web_dist_dir = apps/web/dist` in `server.config` so the Rust server serves both the frontend and the API (a reverse proxy works too). If they are served from different origins, set `allowed_origins` in `server.config` to the frontend origins before exposing the server outside a trusted network; when it is unset, the server reflects any requesting origin.

### Development tools

This project uses [Jujutsu](https://jujutsu-vcs.github.io/) (`jj`) for version control, with [JJ-VSC](https://github.com/jujutsu-vcs/jj-vsc) as the recommended VS Code integration. Clone with `jj` so the workspace is ready for that workflow:

```bash
jj git clone https://github.com/DonovanMontoya/OperaLibre.git
```

## Server config

The server reads `server.config` from the repo root by default. It is a plain `key = value` file:

```config
host = 0.0.0.0
port = 4000
library_root = /path/to/your/audiobooks
data_dir = data
progress_file = data/progress.json

libation_cli_path =
libation_files_dir =
alignment_cli_path =
```

Relative paths are resolved from the directory containing `server.config`. To use a different config file, set `OPERALIBRE_SERVER_CONFIG=/path/to/server.config` when starting the server.

## Library layout

Each folder is treated as one book:

```text
/Audiobooks
  /Book One
    01 Opening.mp3
    02 Chapter 1.mp3
    Book One.pdf
  /Book Two.m4b
  /Book Two.epub
```

A single audio file directly in the root is treated as its own book.

For readalong mode, place a supported companion file next to the audiobook. Folder-based books use a same-name file when present and otherwise use the first supported document in that book folder. Single-file books in the library root require a same-stem companion file, such as `Book Two.m4b` and `Book Two.epub`.

For sentence-level readalong sync, a book with an EPUB companion can also have a `.sync.json` sync map (same stem rules, e.g. `Book Two.sync.json`) mapping audiobook timestamps to EPUB sentences. Administrators can generate one from the readalong pane when [echogarden](https://github.com/echogarden-project/echogarden) is installed (`npm install -g echogarden`, or set `alignment_cli_path`); generated maps are written to `data_dir/sync/`. See [docs/library-layout.md](docs/library-layout.md) for details.

## Optional Libation / Audible import

The server can use a local Libation CLI installation as an optional acquisition tool. Libation must already be installed and authenticated on the server. The web app can then show Libation's Audible library, run a Libation scan, trigger liberation for a selected ASIN, and rescan the local audiobook folder after the download completes.

Set these in `server.config` only if you want the integration:

```config
libation_cli_path = /path/to/libationcli
libation_files_dir = /path/to/LibationFiles
```

If `libation_cli_path` is omitted, the server looks for `libationcli`, `LibationCli`, or `libationcli.exe` on `PATH`. `libation_files_dir` should point at the Libation files directory containing `AccountsSettings.json` and `Settings.json`; the web app reports when configured accounts are no longer authenticated.

## iOS path

The frontend is intentionally plain React/Vite so it can move to iOS through Capacitor later:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios -w @operalibre/web
```

For a native wrapper, set `VITE_API_BASE` to the server URL reachable from the phone, then add Capacitor once the web playback experience is stable.

## Users

The server requires sign-in before any audiobook data is exposed. The first browser to load the app sees a one-time setup form that creates the initial administrator account; from then on the home screen is a sign-in form.

- Accounts are stored in `data/users.json` (configurable via `users_file`). Passwords are hashed with Argon2.
- Playback progress is tracked per user, so each reader has their own bookmarks.
- Administrators can add or remove readers, and reset any password, from the **Manage readers** menu under the avatar in the library pane.
- Sessions are stored in `data/sessions.json` and survive server restarts. They expire after 30 days, matching the session cookie lifetime.
- Streaming, cover art, and zip download requests carry the session token as a query parameter so plain `<audio>`/`<img>` elements stay authenticated.

## Next build slices

- Device pairing and offline downloads with encrypted local storage for the iOS build.
- Chapter extraction for `.m4b` chapter metadata.
- Cover art extraction and caching.
- Bookmarks, clips, notes, and listening history.
- Word-level readalong sync (sentence-level sync shipped; the sync map format has room for word granularity).
- Queue, collections, and search.
