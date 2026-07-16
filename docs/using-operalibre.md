---
title: Using OperaLibre
nav_order: 6
---

# Using OperaLibre

This is the everyday guide for listeners and the person who looks after the library. You need an OperaLibre server or a Jellyfin server that you can reach first; [Getting Started](getting-started.md) explains the OperaLibre setup.

## Sign in and listen

1. Open the OperaLibre address in a browser. The person who set it up creates the first administrator account on this screen.
2. Sign in with your own reader name and password.
3. Select a book, then use **Play**, the speed control, 15-second rewind, 30-second skip, and the sleep timer as needed.

OperaLibre remembers a reader’s position automatically. Each reader has separate progress, so two people can listen to the same book independently.

## Add books to the library

You can add books in either of these ways:

1. **Copy files into the library folder.** Put them in the folder chosen as `library_root`, then choose **Rescan library** from the administrator controls. Follow [Library Layout](library-layout.md) for the expected folder and filename patterns.
2. **Upload through the app.** An administrator can choose **Upload audiobook** in the library header, enter the book name, select one audio file (such as an M4B) or every track for a multi-file book, then upload. The app puts it in a new library folder and rescans automatically.

Uploads accept the audio types listed in [Library Layout](library-layout.md#supported-audio-formats). Add a cover image and readalong file by copying them into the book’s folder afterward, then rescan.

## Add people and recover access

An administrator opens the avatar menu and chooses **Manage readers** to add a reader, remove one, or reset a password. Give every household member their own account rather than sharing the administrator password.

If every administrator password is lost, the server owner can recover access by following [Resetting a forgotten admin password](users.md#resetting-a-forgotten-admin-password). Keep a backup of `data_dir`: it contains accounts and listening progress.

## Use it on a phone or tablet

### Install the web app

Open the OperaLibre address in Safari, Chrome, or another modern mobile browser and sign in.

- **iPhone or iPad (Safari):** tap **Share**, then **Add to Home Screen**.
- **Android (Chrome):** open the browser menu and choose **Install app** or **Add to Home screen**.

Open it from the new home-screen icon afterward. The web app offers the same library, player, readalong, and progress sync as the browser. Your phone must be able to reach the server; see [Getting Started: Running on the LAN](getting-started.md#running-on-the-lan).

### Native iPhone app

The repository also includes a native iPhone app with background spoken-audio playback. Building it requires a Mac with Xcode and an Apple development team:

1. From the repository root, run `npm run ios:open -w @operalibre/web`.
2. In Xcode, select the **App** target, then select your development team under **Signing & Capabilities**.
3. Connect your iPhone, select it as the run destination, and press Run.
4. In the app, choose **OperaLibre**, enter the server’s LAN address (for example `http://192.168.1.20:4000`), and sign in.

The app supports HTTP for private home-network and Tailscale-style addresses. Use HTTPS for a public server.

## Readalong and sentence highlighting

To read while listening, place an EPUB, PDF, text, or HTML companion beside the audio as described in [Library Layout](library-layout.md#readalong-companions). Select a book and open the **Readalong** control in the player.

For sentence highlighting, the companion must be an EPUB and the book needs a sync map. An administrator can either put a matching `.sync.json` file beside the book or set up automatic generation:

1. Install [echogarden](https://github.com/echogarden-project/echogarden) on the server machine: `npm install -g echogarden`.
2. Restart OperaLibre. If `echogarden` is not on the server’s PATH, set `alignment_cli_path` in `server.config` to its full path instead.
3. Open the book’s readalong pane and select **Sync**. Wait for the job to complete, then play the book.

Generated maps are saved in `data_dir/sync`; a matching `.sync.json` file beside the book takes priority. Sync quality is best when the audio track names correspond to the EPUB chapter titles.

## Import Audible books with Libation (optional)

This is only for the server owner. Install and sign in to [Libation](https://github.com/rmcrackan/Libation) on the same computer as OperaLibre, then set its download folder to your OperaLibre library folder (or a folder inside it).

Add the Libation CLI and files-folder paths to `server.config`, restart OperaLibre, and use the **Libation** area in the library to refresh your Audible list and choose **Liberate** for a book. Detailed path examples and troubleshooting are in [Libation / Audible Import](libation.md).

## Connect to Jellyfin instead

OperaLibre can be used as a client for an existing Jellyfin audiobook library; no OperaLibre server configuration is needed for this mode.

1. On the connection screen, choose **Jellyfin**.
2. Enter the Jellyfin address. The common local address is `http://localhost:8096`; on a phone, use the server’s LAN address instead.
3. Sign in with a normal Jellyfin user account.

In Jellyfin mode, OperaLibre lists and streams audiobooks, groups multi-file albums, shows cover art and chapters, and syncs resume position with Jellyfin. OperaLibre-only administration, uploading, Libation, metadata editing, readalong, and the reader ledger are not available in this mode.

## macOS app

The macOS app is a small native window around the web app. From the repository root, run `./script/build_and_run.sh`, then enter the address of a running OperaLibre or Jellyfin server on its first screen. It remembers the address and sign-in token between launches. Start the OperaLibre server separately with `npm run dev:server` while developing, or use the production server command in [Getting Started](getting-started.md#keep-it-running-recommended-after-you-have-tried-it).
