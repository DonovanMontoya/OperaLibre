# Audiobook Serving

A private audiobook streaming app with a Rust media server and an iOS-ready web frontend. The current build scans a folder of audiobook files, streams tracks with HTTP range requests, and saves playback progress.

## What is included

- Library scanning for `.mp3`, `.m4b`, `.m4a`, `.aac`, `.flac`, `.ogg`, `.opus`, `.wav`, and `.aiff`.
- Long-file streaming with byte-range support for seeking.
- Book and track browsing.
- Embedded cover art extraction and `/api/books/:bookId/cover` serving.
- Rich tag extraction for album/title, subtitle, author, narrator, publisher, dates, genres, language, description, and raw tag fields.
- Chapter extraction from M4A/M4B/MP4 chapter tracks or chapter lists, MP3 ID3 `CHAP` frames, and multi-file track boundaries.
- Playback position sync.
- Playback speed controls.
- 15-second rewind and 30-second forward controls.
- Sleep timer.
- Media Session integration for OS-level playback controls where supported.
- PWA manifest so the web app can be installed and later wrapped with Capacitor for iOS.

## Run locally

```bash
npm install
AUDIOBOOK_LIBRARY="/path/to/your/audiobooks" npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

The server runs on [http://localhost:4000](http://localhost:4000). On another device on your network, use your computer's LAN IP and make sure the server is allowed through the firewall.

The backend is a Rust `axum` service in `apps/server`. The frontend is a React/Vite app in `apps/web`.

## Library layout

Each folder is treated as one book:

```text
/Audiobooks
  /Book One
    01 Opening.mp3
    02 Chapter 1.mp3
  /Book Two.m4b
```

A single audio file directly in the root is treated as its own book.

## iOS path

The frontend is intentionally plain React/Vite so it can move to iOS through Capacitor later:

```bash
npm install @capacitor/core @capacitor/cli @capacitor/ios -w @audiobook/web
```

For a native wrapper, set `VITE_API_BASE` to the server URL reachable from the phone, then add Capacitor once the web playback experience is stable.

## Next build slices

- Authentication and device pairing.
- Real user accounts and multi-device progress sync.
- Offline downloads with encrypted local storage for the iOS build.
- Chapter extraction for `.m4b` chapter metadata.
- Cover art extraction and caching.
- Bookmarks, clips, notes, and listening history.
- Queue, collections, and search.
