---
layout: home
title: OperaLibre
nav_order: 1
---

# OperaLibre

A private, self-hosted audiobook streaming server with an installable web reader. Point it at a folder of audiobooks and stream them to any browser on your network with per-reader progress, chapter navigation, readalong, and optional Libation/Audible import.

OperaLibre can also run as a headless audiobook server. The included React/Vite app is the reference frontend, while the Rust server exposes an HTTP API for custom web, mobile, desktop, or native clients.

## Web and iPhone apps

<p align="center">
  <img src="assets/screenshots/operalibre-web-library.png" alt="OperaLibre web library and audiobook player" width="72%">
  <img src="assets/screenshots/operalibre-ios-now-playing.png" alt="OperaLibre iPhone now-playing screen" width="22%">
</p>

## Features at a glance

- **Streams almost anything** — `.mp3`, `.m4b`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.opus`, `.wav`, `.aiff`
- **Real seeking** — HTTP range requests, so scrubbing works on huge `.m4b` files
- **Rich metadata** — title/subtitle, author, narrator, publisher, dates, genres, language, description, embedded cover art
- **Chapters** — M4A/M4B/MP4 chapter tracks, MP3 ID3 `CHAP` frames, and multi-file track boundaries
- **Readalong** — inline reader for `.epub`, `.pdf`, `.txt`, `.html`, `.htm` companion files
- **Readalong sync** — sentence highlighting that follows the narration through an EPUB, with server-side sync-map generation via an optional [echogarden](https://github.com/echogarden-project/echogarden) install
- **Multi-reader** — accounts, per-reader progress, Argon2-hashed passwords
- **Player controls** — playback speed, 15s rewind, 30s skip, sleep timer, OS Media Session
- **Web and iPhone apps** — installable PWA plus a native Capacitor app with background spoken-audio playback
- **Optional Audible import** — drive a local [Libation](https://github.com/rmcrackan/Libation) install from the web UI

## Documentation

1. [Getting Started](getting-started.md) — install, run, and open the app
2. [Configuration](configuration.md) — every key in `server.config` explained
3. [Library Layout](library-layout.md) — how to structure your audiobook folder
4. [Users & Accounts](users.md) — first-run admin setup, adding readers, sessions
5. [Using OperaLibre](using-operalibre.md) — phones, reader accounts, uploads, readalong, Jellyfin, and optional imports
6. [Libation / Audible Import](libation.md) — optional acquisition pipeline
7. [API Reference](api.md) — HTTP endpoints exposed by the server
8. [Deployment](deployment.md) — running on a home server or LAN
9. [Troubleshooting](troubleshooting.md) — common problems and fixes

## Architecture

```text
┌─────────────────────┐        ┌──────────────────────────┐
│  apps/web (Vite)    │  HTTP  │  apps/server (Rust/axum) │
│  React + TypeScript │ ─────▶ │  Library scan, streaming │
│  PWA, Media Session │        │  Auth, progress, covers  │
└─────────────────────┘        └────────────┬─────────────┘
                                            │
                                            ▼
                              ┌──────────────────────────┐
                              │  library_root/           │
                              │  data/ (users, progress) │
                              │  Libation CLI (optional) │
                              └──────────────────────────┘
```

The backend is a single Rust binary (`apps/server`). The frontend is a static React build (`apps/web`) that can be served by anything — Vite in dev, the Rust server in production, or any static host pointed at the API.

The server owns library scanning, authentication, metadata extraction, cover art, readalong files, progress sync, downloads, and byte-range audio streaming. A custom frontend can build its own browsing and playback experience on top of the API described in [API Reference](api.md).

## License

See [LICENSE](../LICENSE.md) in the repository root.
