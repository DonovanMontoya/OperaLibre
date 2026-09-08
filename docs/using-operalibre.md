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

### Set your own sleep timer

**Nightfall**, on the book’s own page and behind the timer button in the phone player, offers the usual 5, 15, 30, 45, and 60 minute stops. Choose **Custom** and type any length from 1 to 600 minutes when none of those matches the chapter you are in the middle of. Durations you type are kept on that device — the three most recent sit alongside the presets — so a length you use often is one tap away the next night. The countdown only runs while the book is playing.

## Add books to the library

You can add books in either of these ways:

1. **Copy files into the library folder.** Put them in the folder chosen as `library_root`, then choose **Rescan library** from the administrator controls. Follow [Library Layout](library-layout.md) for the expected folder and filename patterns.
2. **Upload through the app.** An administrator can choose **Upload audiobook** in the library header, enter the book name, select one audio file (such as an M4B) or every track for a multi-file book, then upload. The app puts it in a new library folder and rescans automatically.

Uploads accept the audio types listed in [Library Layout](library-layout.md#supported-audio-formats). Cover art comes from the artwork embedded in the audio files' tags; add a readalong file by copying it into the book’s folder afterward, then rescan.

### Organize books with custom tags

An administrator can open a book, choose **Edit book info**, and add one or
more custom tags. Each tag can also have its own optional book number. This is
useful when a title has an immediate series but also belongs to a wider world
or reading order: keep its normal series as **Mistborn**, then add **Cosmere**
with the appropriate Cosmere book number. Tags survive library rescans, appear
on the book, participate in search, and can be selected as the library sort.

### Sort and filter your shelf

Use **Sort by** to choose the order and the arrow beside it to reverse that
order. Your choice is remembered separately for Your Library and Audible.
The count below the controls shows how many books match.

Open **Filters** to combine reading progress, genres, and tags. Selecting
multiple genres or tags includes any of those choices within that group;
combining groups narrows the results. Larger genre and tag lists have their
own search fields. Counts update as you filter, and selected filters remain
visible as removable chips after you close the panel. **Clear all** removes
filters; the search field has its own clear button.

For a wider reading order, filter to **Cosmere** and choose **Tag** under
**Sort by**. Books then follow their Cosmere numbers, even if Cosmere is not
their first tag. With multiple tags selected, the first selected tag that a
book carries determines its group and number; without tag filters, its first
tag is used.

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

#### CarPlay

The iPhone app appears on the car screen once it is connected to CarPlay. It has
three tabs — **Listening**, **Downloaded**, and **Library** — and tapping a book
resumes it where you left off. The Now Playing screen carries the usual
transport, a playback-speed button, and a **Chapters** list under **Up Next**.

A few things worth knowing:

- The car reads a snapshot of your library that the phone app writes as the
  shelf changes, so **open the app on the phone once** after signing in or
  adding books. This is also what makes the car screen work when the app was not
  already running.
- Books you have downloaded play with no network at all. Books that stream are
  still listed, marked with a cloud, and need the server to be in reach — which
  it usually is not once you have driven away.
- Progress from a drive is saved by the phone app, not by the car, so it reaches
  the server the next time you open OperaLibre. Your position is kept on the
  device meanwhile.
- Starting a book in the car takes over playback; the shelf shows a **Playing in
  the car** banner with a **Play here** button to bring it back to the phone.

To try it in the CarPlay simulator, build with signing on so the entitlement is
linked into the binary, then re-sign without it — SpringBoard refuses to launch a
simulator build whose *signature* claims the CarPlay entitlement, while CarPlay
only lists apps whose *binary* carries it:

```bash
xcodebuild -project apps/web/ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath dist/ios-derived \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES \
  CODE_SIGN_STYLE=Manual PROVISIONING_PROFILE_SPECIFIER="" DEVELOPMENT_TEAM="" build
codesign --force --sign - dist/ios-derived/Build/Products/Debug-iphonesimulator/OperaLibre.app
```

Install that build, then turn on **I/O › External Displays › CarPlay** in
Simulator. (`npm run build:ios` signs nothing, so the app runs on the phone
screen but will not appear on the car's.)

Apple gates CarPlay behind an entitlement it grants per app: request
`com.apple.developer.carplay-audio` for your App ID at
[developer.apple.com/contact/carplay](https://developer.apple.com/contact/carplay/).
Until it is granted, Xcode cannot sign a build for a device — remove
**CODE_SIGN_ENTITLEMENTS** from the App target's build settings to keep
installing the app in the meantime. The CarPlay simulator (**I/O › External
Displays › CarPlay** in Simulator) needs no entitlement.

### Native Android app

The repository includes a native Android 7+ app. Building it requires Android Studio, an installed Android SDK, and JDK 21:

1. From the repository root, run `npm run android:open -w @operalibre/web`.
2. Let Android Studio finish its first Gradle sync, then select an emulator or connected Android device.
3. Press Run.
4. In the app, choose **OperaLibre**, enter the server’s LAN address (for example `http://192.168.1.20:4000`), and sign in.

For a directly installable development build, run `npm run build:android`; the APK is written to `apps/web/android/app/build/outputs/apk/debug/app-debug.apk`. Configure release signing in Android Studio before distributing the app. Private-network HTTP is supported; public servers should use HTTPS.

### Use another audiobook app

The server also speaks an Audiobookshelf-compatible API, so audiobook apps with Audiobookshelf support — BookPlayer, for example — can connect directly. In the app, add an Audiobookshelf server, enter the OperaLibre address with `/abs` appended (for example `http://192.168.1.20:4000/abs`), and sign in with a normal OperaLibre account. Browsing, streaming, cover art, search, genre and tag filters, and resume position all sync with the reader's OperaLibre progress.

There is also an [OPDS](https://opds.io/) catalog for generic reading apps; see the [API Reference](api.md#opds) for the feed address.

## Read along with the ebook

Read along is a **beta feature and is off by default.** Turn it on per device under **Settings → Extras → Read along** in the phone and tablet apps, or from the account menu (**Read along: On/Off**) in the browser. With it off, none of the read-along controls appear.

To read while listening, place an EPUB, PDF, text, or HTML companion beside the audio as described in [Library Layout](library-layout.md#readalong-companions). Books that have one show a **Read along** tag in the library, and their details page opens with an invitation to **Open reader**. On the phone apps the Now Playing screen has a **Read along** button as well. The reader remembers that you had it open for a book and your place in it, so selecting the book again brings the text straight back.

EPUBs support chapter sync. For sentence following, the owner must enable **Follow along** under **Administration → Experimental features**, and each reader must turn on **Follow the narration** in their settings or account menu. With both enabled:

- The narrated sentence is highlighted and the page turns with the narration.
- Tap any sentence to play from there.
- Turning a page by hand pauses following so you can read ahead. To rejoin the audio, turn following back on (the target button in the reader, or the **Follow** control), and the marker snaps to the narrated sentence again.
- With approximate sync, the marker can drift within a long chapter. Choose **Sync here**, then tap the sentence the narrator is reading: the server keeps that anchor with the book and re-times the sentences around it for every listener. One or two taps in a long chapter keep it close. An administrator can clear the adjustments from the reader.
- Themes, text size, and a full-screen focus mode are in the reader's toolbar. Arrow keys and swipes turn pages.

If you update the frontend separately, update the server too so ordinary readers can check the experiment setting. Older servers that deny that check offer chapter sync until upgraded; a denied check does not enable sentence following. The app retains a previously confirmed setting for offline reading.

On the phone and tablet apps the ebook opens as a full-screen reader of its own, over whatever you were doing, and closing it puts you back there. It reads like a paper book: tap the left or right edge of the page to turn it, swipe if you prefer, and tap a sentence in the middle to play from there. A tap on an empty part of the page hides the bars for distraction-free reading and brings them back. The title bar holds the follow toggle, the **Contents** sheet (chapters and any other companion files), and the **Appearance** sheet (theme, text size, **Sync here**, **Improve sync**). The theme starts on **auto**, which turns the page dark whenever the app is in its dark look (the system theme, or the appearance chosen in Settings on the phone); pick **paper**, **sepia**, or **night** to fix it. Under the page a strip shows the sync state and the page within the chapter, and holds the full player so you never have to leave the book: play/pause, skip back and forward, and buttons for speed, the sleep timer, and the chapter list that open over the page. When the book isn't the one playing, a **Listen while you read** button starts it instead. Full-screen focus mode on the web uses the same layout.

When the experiment is enabled, EPUBs without a precise map use text timings estimated from the audiobook's chapter list, which the reader labels *Approximate sync* — close enough to keep the page and paragraph in step, but the marker can run a few lines ahead or behind. The narrator's pace is learned from the book itself: with enough chapters, how long this narrator spends per character, per sentence, per paragraph, and on dialogue is fitted from the chapters' known lengths. For sentence-exact precision an administrator can either put a matching `.sync.json` file beside the book or set up automatic alignment:

1. Open **Administration → Experimental features** and install the optional follow-along generator (owner only).
2. Choose **Enable**.
3. Open the book’s reader and select **Improve sync**.

The reader explains what the button does before you press it, and shows a progress bar with the chapter being aligned, the percentage done, how long it has been running, and a rough estimate of the time left. The bar is read from the server, so closing the reader, moving to another book, or reloading the page does not stop the run — reopening the book picks the progress back up.

Generation downloads any missing model files, so initial use requires network access. Generation runs locally; audiobook contents are not uploaded anywhere. Jobs run one at a time; repeated requests for the same book reuse its queued or running job.

To monitor several books together, open **Administration → Experiments** and expand **Sync activity** under the follow-along sync generator. It shows running and queued books, progress, elapsed time, and recent completed or failed results. Select a book title to open it. The view refreshes while expanded; collapsing it does not stop server jobs. Recent results are temporary and clear when the server restarts.

Generated maps are saved in `data_dir/sync`; disabling or removing the add-on keeps them but disables sentence following. Chapter sync remains available. The app remembers the last server setting so downloaded audio, EPUBs, and sync maps can still follow sentences after an offline restart; reconnecting applies any setting changes made on the server. A matching `.sync.json` file beside the book takes priority. Sync quality is best when the audio track names, or the chapters embedded in an M4B, correspond to the EPUB chapter titles. Processing time and memory depend on the book and server; generation can compete with playback on smaller machines. The current implementation transcribes successive windows across long chapters and then aligns their text; it does not yet use sparse speech sampling. Wait for queued and running jobs to finish before updating, disabling, or removing the add-on.

Development and manually managed installations may instead set `alignment_cli_path` to an existing echogarden executable. A manually configured generator is treated as installed and enabled, but OperaLibre does not update or remove it.

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
