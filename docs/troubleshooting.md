---
title: Troubleshooting
nav_order: 11
---

# Troubleshooting

Common problems and how to fix them. If you hit something not listed here, open an issue with the relevant lines from the server's stdout/stderr.

## `Error: spawn npm ENOENT` on Windows

This came from the cross-platform development launcher trying to execute the Unix-style `npm` command instead of Windows' npm shim. Current versions invoke npm through Node and do not have this problem.

If you are on an older checkout, update OperaLibre or start the two development processes in separate Command Prompt or PowerShell windows:

```powershell
npm run dev:server
```

```powershell
npm run dev:web
```

Both windows need to remain open only for this source-development setup. The downloadable combined release uses the background launcher instead.

## A downloaded release will not start

First confirm that you extracted the entire archive. The launcher and server must remain together with `server.config`; they will not work correctly from inside a ZIP preview.

### Windows warns about an unrecognized app

OperaLibre releases are not code-signed yet, so Windows may show a Microsoft Defender SmartScreen warning. Confirm that the file came from the official [OperaLibre releases page](https://github.com/DonovanMontoya/OperaLibre/releases), choose **More info**, then **Run anyway**.

If Windows Defender Firewall asks, allow access on **Private networks**. Public-network access is not needed for normal home use.

### macOS says the developer cannot be verified

OperaLibre releases are not Apple-notarized yet. Follow the one-time quarantine removal steps in [Install a Release](installing-a-release.md#macos), then open `Open OperaLibre.app` again.

### The browser did not open

Browse to <http://localhost:4000> yourself. If that address does not load, check `data/server.log` and `LAUNCH-ERROR.txt` in the OperaLibre folder. A common cause is another program already using port 4000.

### Is OperaLibre still running?

The combined package runs in the background. Closing the browser does not stop it. Use the included Stop action when you want to shut it down, or use the Open action again to return to it.

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

## Everyone was signed out

Sessions are stored in `data/sessions.json` and survive restarts, but they expire 30 days after sign-in. If everyone was signed out at once, check whether `sessions.json` was deleted or the `data` directory changed.

## CORS errors in the browser console

The easiest fix is to serve the built web app from OperaLibre itself by setting `web_dist_dir` in `server.config`; then the site and API use one address. If you intentionally host them on different addresses, put the web app’s full origin (for example `https://books.example.com`) in the comma-separated `allowed_origins` setting and restart the server. See [Configuration](configuration.md#network).

## Where are the logs?

The server logs to stdout/stderr. With `systemd`:

```bash
journalctl -u operalibre -f
```

With `launchd`, route logs in the plist:

```xml
<key>StandardOutPath</key><string>/Users/you/operalibre/server.log</string>
<key>StandardErrorPath</key><string>/Users/you/operalibre/server.err</string>
```

## Filing a bug

Useful info to include:

- Operating system and architecture
- Output of `operalibre-server --version` (or the commit hash you built from)
- Relevant `server.config` (redact paths if needed)
- The first few hundred lines of server output around the failure
- A minimal example of the library layout that triggers the bug
