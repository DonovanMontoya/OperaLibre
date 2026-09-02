---
title: Using OperaLibre
nav_order: 7
---

# Using OperaLibre

This is the everyday guide for listeners and the person who looks after the library. You need an OperaLibre server or a Jellyfin server that you can reach first; [Getting Started](getting-started.md) explains the OperaLibre setup.

## Sign in and listen

1. Open the OperaLibre address in a browser. The person who set it up creates the first administrator account on this screen.
2. Sign in with your own reader name and password.
3. Select a book, then use **Play**, the speed control, 15-second rewind, 30-second skip, and the sleep timer as needed.

OperaLibre remembers a reader’s position automatically. Each reader has separate progress, so two people can listen to the same book independently.

### Fix a book that is too quiet

Audiobooks are mastered at very different levels, so a device volume that suits one book leaves the next one hard to hear. **Book Volume**, in the player’s playback sheet (the speed pill) and on the book’s own page, trims or lifts that single book by up to 24 dB without touching anything else. It is saved per reader on the server, so a book you turned up on your phone is already turned up on every other device you sign in from.

The setting is a boost, not a re-recording: past the point where a book’s loudest passages reach full scale a limiter holds them there, so very large boosts trade some dynamic range for audibility. A frontend hosted separately from the OperaLibre server can only turn a book down, not up — the browser will not let it read the audio closely enough to amplify it.

## Add books to the library

You can add books in either of these ways:

1. **Copy files into the library folder.** Put them in the folder chosen as `library_root`, then choose **Rescan library** from the administrator controls. Follow [Library Layout](library-layout.md) for the expected folder and filename patterns.
2. **Upload through the app.** An administrator can choose **Upload audiobook** in the library header, enter the book name, select one audio file (such as an M4B) or every track for a multi-file book, then upload. The app puts it in a new library folder and rescans automatically.

Uploads accept the audio types listed in [Library Layout](library-layout.md#supported-audio-formats). Cover art comes from the artwork embedded in the audio files' tags; add a readalong file by copying it into the book’s folder afterward, then rescan.

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

### Native Android app

The repository includes a native Android 7+ app. Building it requires Android Studio, an installed Android SDK, and JDK 21:

1. From the repository root, run `npm run android:open -w @operalibre/web`.
2. Let Android Studio finish its first Gradle sync, then select an emulator or connected Android device.
3. Press Run.
4. In the app, choose **OperaLibre**, enter the server’s LAN address (for example `http://192.168.1.20:4000`), and sign in.

For a directly installable development build, run `npm run build:android`; the APK is written to `apps/web/android/app/build/outputs/apk/debug/app-debug.apk`. Configure release signing in Android Studio before distributing the app. Private-network HTTP is supported; public servers should use HTTPS.

### Use another audiobook app

The server also speaks an Audiobookshelf-compatible API, so audiobook apps with Audiobookshelf support — BookPlayer, for example — can connect directly. In the app, add an Audiobookshelf server, enter the OperaLibre address with `/abs` appended (for example `http://192.168.1.20:4000/abs`), and sign in with a normal OperaLibre account. Browsing, streaming, cover art, search, genre filters, and resume position all sync with the reader's OperaLibre progress.

There is also an [OPDS](https://opds.io/) catalog for generic reading apps; see the [API Reference](api.md#opds) for the feed address.

## Read along with the ebook

Read along is a **beta feature and is off by default.** Turn it on per device under **Settings → Extras → Read along** in the phone and tablet apps, or from the account menu (**Read along: On/Off**) in the browser. With it off, none of the read-along controls appear.

To read while listening, place an EPUB, PDF, text, or HTML companion beside the audio as described in [Library Layout](library-layout.md#readalong-companions). Books that have one show a **Read along** tag in the library, and their details page opens with an invitation to **Open reader**. On the phone apps the Now Playing screen has a **Read along** button as well. The reader remembers that you had it open for a book and your place in it, so selecting the book again brings the text straight back.

With an EPUB, the reader follows the audio:

- The narrated sentence is highlighted and the page turns with the narration. With a precise sync map the narrated word is marked inside the sentence too.
- Tap any sentence to play from there.
- Turning a page by hand pauses following so you can read ahead. To rejoin the audio, turn following back on (the target button in the reader, or the **Follow** control), and the marker snaps to the narrated sentence again.
- With approximate sync, the marker can drift within a long chapter. Choose **Sync here**, then tap the sentence the narrator is reading: the server keeps that anchor with the book and re-times the sentences around it for every listener. One or two taps in a long chapter keep it close. An administrator can clear the adjustments from the reader.
- Themes, text size, and a full-screen focus mode are in the reader's toolbar. Arrow keys and swipes turn pages.

On the phone and tablet apps the ebook opens as a full-screen reader of its own, over whatever you were doing, and closing it puts you back there. It reads like a paper book: tap the left or right edge of the page to turn it, swipe if you prefer, and tap a sentence in the middle to play from there. A tap on an empty part of the page hides the bars for distraction-free reading and brings them back. The title bar holds the follow toggle, the **Contents** sheet (chapters and any other companion files), and the **Appearance** sheet (theme, text size, **Sync here**, **Improve sync**). The theme starts on **auto**, which turns the page dark whenever the app is in its dark look (the system theme, or the appearance chosen in Settings on the phone); pick **paper**, **sepia**, or **night** to fix it. Under the page a strip shows the sync state and the page within the chapter, and holds the full player so you never have to leave the book: play/pause, skip back and forward, and buttons for speed, the sleep timer, and the chapter list that open over the page. When the book isn't the one playing, a **Listen while you read** button starts it instead. Full-screen focus mode on the web uses the same layout.

Every EPUB can be followed straight away: with nothing else installed, the server times the text from the audiobook's chapter list, which the reader labels *Approximate sync* — close enough to keep the page and paragraph in step, but the marker can run a few lines ahead or behind. The narrator's pace is learned from the book itself: with enough chapters, how long this narrator spends per character, per sentence, per paragraph, and on dialogue is fitted from the chapters' known lengths. For sentence and word precision an administrator can either put a matching `.sync.json` file beside the book or set up automatic alignment:

1. Install [echogarden](https://github.com/echogarden-project/echogarden) on the server machine: `npm install -g echogarden`.
2. Restart OperaLibre. If `echogarden` is not on the server’s PATH, set `alignment_cli_path` in `server.config` to its full path instead.
3. Open the book’s reader and select **Improve sync**. Wait for the job to complete, then play the book.

Generated maps are saved in `data_dir/sync`; a matching `.sync.json` file beside the book takes priority. Alignment works best when the audio chapter or track names correspond to the EPUB chapter titles, in any spelling (`Chapter 3`, `Chapter Three`, `III.`).

### Extras: maps, illustrations, and supplements

Audible titles often come with a PDF of maps or illustrations rather than the book's text. OperaLibre opens each companion during a scan and tells the two apart, so a picture PDF is offered as **Extras** instead of being presented as the book. A book can have both: the reader pane then shows tabs for the ebook, each supplement, and a gallery of any loose pictures in the book's folder (in the phone reader these are listed under **Other files** in the Contents sheet). A book with only extras shows a **View extras** invitation in place of the reader.

## Import Audible books with Libation (optional)

Install a recent [Libation](https://github.com/rmcrackan/Libation) CLI on the same computer as OperaLibre. Add every Audible account in Libation itself; OperaLibre reads the accounts Libation already knows about rather than signing them in. Give each account a short label such as **Dad** or **UK**; that label appears on its books instead of the Audible email address. The catalog can be filtered or sorted by account.

Add the Libation CLI path and `libation_files_dir` to `server.config`, restart OperaLibre, and use the **Audible** area in the library to review account status, refresh purchases, and choose **Download** for a book. Detailed path examples and troubleshooting are in [Libation / Audible Import](libation.md).

## Games

The installed iPhone and Android apps include an optional games tab with small on-device diversions — a daily word puzzle and a match-three board. It is hidden by default; turn it on in **Settings**, and it appears in the bottom navigation. The games run entirely on the device and send nothing to the server.

## Check for application updates

Open **Administration → Overview** and choose **Check for updates** under **Software versions**. In a browser this checks the installed server and its separately updatable web application; in the installed iOS app it checks the connected server. Owners can install supported managed-package updates from the same card when one is available.

## Connect to Jellyfin instead

OperaLibre can be used as a client for an existing Jellyfin audiobook library; no OperaLibre server configuration is needed for this mode.

1. On the connection screen, choose **Jellyfin**.
2. Enter the Jellyfin address. The common local address is `http://localhost:8096`; on a phone, use the server’s LAN address instead.
3. Sign in with a normal Jellyfin user account.

In Jellyfin mode, OperaLibre lists and streams audiobooks, groups multi-file albums, shows cover art and chapters, and syncs resume position with Jellyfin. OperaLibre-only administration, uploading, Libation, metadata editing, readalong, and the reader ledger are not available in this mode.

## macOS app

The macOS app is a small native window around the web app. From the repository root, run `./script/build_and_run.sh`, then enter the address of a running OperaLibre or Jellyfin server on its first screen. It remembers the address and sign-in token between launches. Start the OperaLibre server separately with `npm run dev:server` while developing, or use the production server command in [Getting Started](getting-started.md#keep-it-running-recommended-after-you-have-tried-it).
