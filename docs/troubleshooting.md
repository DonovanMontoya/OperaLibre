---
title: Troubleshooting
nav_order: 9
---

# Troubleshooting

Common problems and how to fix them. If you hit something not listed here, open an issue with the relevant lines from the server's stdout/stderr.

## The library is empty

- Confirm `library_root` in `server.config` points at the folder you expect, with an absolute path.
- Check the server process can read the path — permissions are a common culprit on Linux when the binary runs as a service user.
- Files at the root of `library_root` only count if they are themselves audio files. Loose `.pdf` or `.txt` files are ignored unless they sit beside a same-stem audio file.
- After moving files, hit **Rescan library** in the UI, or `POST /api/library/rescan`.

## A book is missing chapters

- For `.m4b` / `.m4a` files, the server reads MP4 chapter tracks. If your file doesn't have them, you can add them with [mp4chaps](https://github.com/nikola/m4b-tool) or `MP4Box`.
- For MP3s, the server reads ID3 `CHAP` frames. Most ID3 editors don't expose these; [Mp3Tag](https://www.mp3tag.de/en/) can.
- For multi-file folder books, each audio file becomes one chapter automatically — sorted by filename, so use zero-padded prefixes (`01`, `02`, …).

## Cover art doesn't show up

- Verify the audio file actually has embedded art (Mp3Tag or `ffprobe` will tell you).
- As a fallback, drop a `cover.jpg` or `cover.png` next to the tracks.
- Hard-refresh the browser; covers are cached by the browser.

## Readalong companion isn't matched

- Check the [matching rules](library-layout.md#matching-rules). Folder books prefer a same-name file; single-file books require a same-stem companion in `library_root`.
- Confirm the extension is one of `.epub`, `.pdf`, `.txt`, `.html`, `.htm` (lowercase).

## Seeking is broken or the audio rebuffers constantly

- Make sure the client is talking to the server over HTTP/1.1 or HTTP/2, not a proxy that strips `Range` headers.
- If you're fronting with nginx or Caddy, see the [reverse proxy notes](deployment.md#reverse-proxy-with-tls-nginx) — `proxy_buffering off` and forwarding `Range` are required.
- On slow LANs, large `.m4b` files can briefly stall — but seeking should still snap to the new position immediately.

## "Address already in use"

Another process is on `port`. Either change `port` in `server.config` or stop the other process.

```bash
lsof -i :4000        # find the offender
```

## I forgot the admin password

See [Resetting a forgotten admin password](users.md#resetting-a-forgotten-admin-password).

## "Libation not configured" or downloads fail

See [Libation troubleshooting](libation.md#troubleshooting).

## Sessions get cleared every restart

That's by design — sessions live in memory. Accounts and progress survive. Users will need to sign in again.

## CORS errors in the browser console

The server doesn't emit permissive CORS headers. If your web bundle is on a different origin than the API, put both behind a single reverse proxy. See [Deployment](deployment.md).

## Where are the logs?

The server logs to stdout/stderr. With `systemd`:

```bash
journalctl -u audiobook -f
```

With `launchd`, route logs in the plist:

```xml
<key>StandardOutPath</key><string>/Users/you/audiobook/server.log</string>
<key>StandardErrorPath</key><string>/Users/you/audiobook/server.err</string>
```

## Filing a bug

Useful info to include:

- Operating system and architecture
- Output of `audiobook-server --version` (or the commit hash you built from)
- Relevant `server.config` (redact paths if needed)
- The first few hundred lines of server output around the failure
- A minimal example of the library layout that triggers the bug
