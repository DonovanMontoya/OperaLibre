---
layout: home
title: OperaLibre
nav_order: 1
---

# OperaLibre

A private, self-hosted audiobook streaming server with an installable web reader. Point it at a folder of audiobooks and stream them to any browser on your network with per-reader progress, chapter navigation, readalong, and optional Libation/Audible import.

## Features at a glance

- **Streams almost anything** — `.mp3`, `.m4b`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.opus`, `.wav`, `.aiff`
- **Real seeking** — HTTP range requests, so scrubbing works on huge `.m4b` files
- **Rich metadata** — title/subtitle, author, narrator, publisher, dates, genres, language, description, embedded cover art
- **Chapters** — M4A/M4B/MP4 chapter tracks, MP3 ID3 `CHAP` frames, and multi-file track boundaries
- **Readalong** — inline reader for `.epub`, `.pdf`, `.txt`, `.html`, `.htm` companion files
- **Multi-reader** — accounts, per-reader progress, Argon2-hashed passwords
- **Player controls** — playback speed, 15s rewind, 30s skip, sleep timer, OS Media Session
- **PWA** — install to the home screen; Capacitor-ready for a future iOS wrapper
- **Optional Audible import** — drive a local [Libation](https://github.com/rmcrackan/Libation) install from the web UI

## Documentation

1. [Getting Started](getting-started.md) — install, run, and open the app
2. [Configuration](configuration.md) — every key in `server.config` explained
3. [Library Layout](library-layout.md) — how to structure your audiobook folder
4. [Users & Accounts](users.md) — first-run admin setup, adding readers, sessions
5. [Libation / Audible Import](libation.md) — optional acquisition pipeline
6. [API Reference](api.md) — HTTP endpoints exposed by the server
7. [Deployment](deployment.md) — running on a home server or LAN
8. [Troubleshooting](troubleshooting.md) — common problems and fixes

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

## License

See [LICENSE](https://github.com/) in the repository root.
