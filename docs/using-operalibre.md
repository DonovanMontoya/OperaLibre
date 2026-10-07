---
title: Using OperaLibre
nav_order: 7
---

# Using OperaLibre

This is the everyday guide for listeners and the person who looks after the library. Connect to an OperaLibre or Jellyfin server, use the native app's on-device library, or try the bundled demo. [Getting Started](getting-started.md) explains the OperaLibre server setup.

## Try the demo

Choose **Explore the on-device demo** on the server connection screen to try OperaLibre without a server or account. The bundled demo pairs a 2 minute, 7 second excerpt of *Alice’s Adventures in Wonderland*, read by Kristen McQuillin for [LibriVox](https://librivox.org/alices-adventures-in-wonderland-by-lewis-carroll/), with the full [Project Gutenberg ebook #11](https://www.gutenberg.org/ebooks/11) and sentence timings. The recording and ebook text are public domain in the USA; copyright status elsewhere can differ. The EPUB retains its original license and credits. **Sources, credits, and license**, on the demo book page and in Settings, is available offline.

## Sign in and listen

1. Open the OperaLibre address in a browser. The person who set it up creates the first administrator account on this screen.
2. Sign in with your own reader name and password.
3. Select a book, then use **Play**, the speed control, 15-second rewind, 30-second skip, and the sleep timer as needed.

Tapping a book in **Continue Reading** loads your saved position in the player without starting playback. Its play button resumes immediately. To start playback from either tap, enable **Play when opening Continue Reading** in the native app’s **Settings → Behavior**, or under **Behavior** in the browser’s reader menu. This choice is remembered on the device.

OperaLibre remembers a reader’s position automatically. Each reader has separate progress, so two people can listen to the same book independently.

### Fix a book that is too quiet

Audiobooks are mastered at very different levels, so a device volume that suits one book leaves the next one hard to hear. **Book Volume**, in the player’s playback sheet (the speed pill) and on the book’s own page, trims or lifts that single book by up to 24 dB without touching anything else. It is saved per reader on the server, so a book you turned up on your phone is already turned up on every other device you sign in from.

The setting is a boost, not a re-recording: past the point where a book’s loudest passages reach full scale a limiter holds them there, so very large boosts trade some dynamic range for audibility. A frontend hosted separately from the OperaLibre server can only turn a book down, not up — the browser will not let it read the audio closely enough to amplify it.

Safari and other WebKit web players currently allow reductions only because routing audio through their boost engine can distort playback. This also applies to downloaded and imported books. Saved boosts remain available in supported players; Safari plays them at Original. To use boost, use the native iOS app or desktop Chrome or Firefox with a frontend served by OperaLibre.

### Set your own sleep timer

**Nightfall**, on the book’s own page and behind the timer button in the phone player, offers the usual 5, 15, 30, 45, and 60 minute stops. Choose **Custom** and type any length from 1 to 600 minutes when none of those matches the chapter you are in the middle of. Durations you type are kept on that device — the three most recent sit alongside the presets — so a length you use often is one tap away the next night. The countdown only runs while the book is playing.

## Add books to the library

You can add books in either of these ways:

1. **Copy files into the library folder.** Put them in the folder chosen as `library_root`, then choose **Rescan library** from the administrator controls. Follow [Library Layout](library-layout.md) for the expected folder and filename patterns.
2. **Upload through the app.** An administrator can choose **Upload audiobook** in the library header, enter the book name, select one audio file (such as an M4B) or every track for a multi-file book, then upload. The app puts it in a new library folder and rescans automatically.

Uploads accept the audio types listed in [Library Layout](library-layout.md#supported-audio-formats). Cover art initially comes from the artwork embedded in the audio files' tags. An administrator can open **Edit Info**, choose a JPEG, PNG, or WebP cover, and **Save Info** to replace it for everyone with access to the book. Images must be at most 8 MiB, 16 million pixels, and 8192 pixels per side; OperaLibre saves a resized copy without changing the audio. **Restore original cover** returns to the embedded artwork, or the placeholder if there is none.

Cover changes survive rescans and server restarts. They require a writable book folder; keep its hidden OperaLibre cover files when moving or backing up your library, alongside a server backup containing your metadata edits.

For a book without an EPUB, an administrator can choose **Add EPUB** on the details page and select a matching, unencrypted ebook up to 64 MiB (or the configured upload limit, if lower). OperaLibre validates it, saves it beside the audio, and rescans. Existing files are never overwritten, and a book with a sync map cannot be paired with a different reading copy until that map is removed. Other [companion formats](library-layout.md#readalong-companions) can be copied into the book's folder, followed by a rescan.

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

Open **Filters** to combine reading progress, genres, and tags, and to show
only books downloaded on this device or books you can read along with. Selecting
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

An administrator opens **Administration → Users & access** to add a reader, remove one, reset a password, or limit their shelf to selected books. In the native apps, Administration is inside **Settings**. Give every household member their own account rather than sharing the administrator password. See [Users & Accounts](users.md) for owner and administrator permissions.

If every administrator password is lost, the server owner can recover access by following [Resetting a forgotten admin password](users.md#resetting-a-forgotten-admin-password). Keep a backup of `data_dir`: it contains accounts and listening progress.

## Use it on a phone or tablet

### Install the web app

Open the OperaLibre address in Safari, Chrome, or another modern mobile browser and sign in.

- **iPhone or iPad (Safari):** tap **Share**, then **Add to Home Screen**.
- **Android (Chrome):** open the browser menu and choose **Install app** or **Add to Home screen**.

Open it from the new home-screen icon afterward. The web app offers the same library, player, readalong, and progress sync as the browser. Your phone must be able to reach the server; see [Getting Started: Running on the LAN](getting-started.md#running-on-the-lan).

### Listen from this device

In the native iPhone, iPad, or Android app, choose **Listen from this device** on the connection screen, then use the shelf's **Add audiobook from device** button to select audio files. Files are copied into the app's private storage; no server or account is needed. Select all tracks of a multi-file book together. You can also add device books while connected to a server; they stay on the device and are not uploaded automatically.

Open an imported book's details and choose **Add EPUB** to pair an unencrypted ebook up to 64 MiB for offline reading. This preserves the audio and listening position. Chapter sync is available; generating a sentence map requires an OperaLibre server. Removing a device book deletes its imported audio and EPUB while keeping listening progress; your original files are left in place.

### Download server books for offline use

In the native iPhone, iPad, and Android apps, open a book's details and choose **Download**. The app saves its audio, cover, companions, and available sync map. Wait for the book to show as downloaded before disconnecting. Downloads and cached server shelves belong to the selected server account; imported device books are separate.

After downloading, the book can play and its EPUB can open without reaching the server, including after restarting the app. Progress is kept locally and reconciled when the server becomes reachable again. Tap the downloaded control to remove the device copy; the server's book and your listening progress remain. The browser and home-screen web app do not create this offline library.

<a id="native-iphone-app"></a>

### Native iPhone and iPad app

The repository also includes a native iPhone and iPad app with background spoken-audio playback. Building it requires a Mac with Xcode and an Apple development team:

1. From the repository root, run `npm run ios:open -w @operalibre/web`.
2. In Xcode, select the **App** target, then select your development team under **Signing & Capabilities**.
3. Connect your iPhone, select it as the run destination, and press Run.
4. In the app, choose **OperaLibre**, enter the server’s LAN address (for example `http://192.168.1.20:4920`), and sign in.

The app supports HTTP for private home-network and Tailscale-style addresses. Use HTTPS for a public server.

On a wide iPad window, **Shelf** shows the collection across the available width, while **Reading** shows the shelf beside the player or selected book details. Starting playback or opening details brings back Reading. Narrow iPad windows use a single pane, and the ebook opens in its own full-screen reader. The app keeps the active tab in step as you resize or rotate.

To reach the same server from more than one network, save its other addresses under **Settings → Connection → Address aliases**. Each address keeps its own sign-in: the first time you use one, tap **Sign in** beside it and enter your password. After that the app moves between your signed-in addresses by itself whenever one stops answering. Signing out signs you out of all of them.

#### Siri and Shortcuts

On iOS 16 or later, say **“Siri, resume OperaLibre,”** **“Siri, resume my
audiobook in OperaLibre,”** or **“Siri, resume my book in OperaLibre.”**
The **Resume Audiobook** action is also available
in Apple's Shortcuts app. To use **“Siri, resume my audiobook”** without the
app name, create a personal shortcut named **Resume my audiobook** and add
OperaLibre's **Resume Audiobook** action.

Open OperaLibre and play a book once before using Siri. Resume uses the loaded
player, or the last book's saved position on this device after a cold launch.
If there is no recent playback record and several books are in progress, open
the app to choose one. Finished books are not automatically restarted.
Downloaded books can resume offline; streaming needs access to your server
and a valid saved media URL. Cold launches use the device's cached library;
open the app to refresh changes made on another device. Listening progress
from Siri is kept locally and reconciled with the server when the app opens.

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
- Starting a book in the car takes over playback; the shelf shows an **Audiobook
  playing** banner with an **Open player** button to bring it back to the phone.

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
4. In the app, choose **OperaLibre**, enter the server’s LAN address (for example `http://192.168.1.20:4920`), and sign in.

For a directly installable development build, run `npm run build:android`; the APK is written to `apps/web/android/app/build/outputs/apk/debug/app-debug.apk`. Configure release signing in Android Studio before distributing the app. Private-network HTTP is supported; public servers should use HTTPS.

### Use another audiobook app

The server implements part of the Audiobookshelf API for compatible clients. For BookPlayer, add an Audiobookshelf server, enter the OperaLibre address with `/abs` appended (for example `http://192.168.1.20:4920/abs`), and sign in with a normal OperaLibre account. Its browsing and download HTTP contracts have been checked; full app playback has not been verified. BookPlayer imports downloads locally and does not automatically send listening progress back to OperaLibre. The official Audiobookshelf app needs additional endpoints that OperaLibre does not implement. See [Client compatibility](client-compatibility.md) for coverage.

There is also an [OPDS](https://opds.io/) catalog for generic reading apps; see the [API Reference](api.md#opds) for the feed address.

## Read along with the ebook

The ebook reader is available by default when a book has a text companion. Open it from the book details or the Read along button while listening.

To read while listening, place an EPUB, PDF, text, or HTML companion beside the audio as described in [Library Layout](library-layout.md#readalong-companions). Books that have one show a **Read along** tag in the library, and their details page opens with an invitation to **Open reader**. On the phone apps the Now Playing screen has a **Read along** button as well. The reader remembers that you had it open for a book and your place in it, so selecting the book again brings the text straight back.

In a browser the reader fills the window. The book's contents run down the left, with the title above them as the way back to the book; the page sits in the middle; and on a wide window the right-hand column shows whether the page is following the narration, your place, and the sync tools. The player stays docked along the bottom with speed, the sleep timer, and the chapter list. A narrow window reads full screen instead, with the same bars as the phone apps.

EPUBs support chapter sync. For sentence sync, the owner must enable **Follow along** under **Administration → Experiments**, and the book must have an aligned sync map. You can then tap a mapped sentence to play from there. In the ebook, press **Follow** to start following the narration. Following starts off for a new reader and remembers the last choice afterward. With following on:

- The narrated sentence is highlighted and the page turns with the narration.
- Turning a page by hand pauses following so you can read ahead. To rejoin the audio, turn following back on (the target **Follow** button in the reader), and the marker snaps to the narrated sentence again.
- Themes and text size are under **Aa** above the page, next to the full-screen focus mode. The arrows under the page, the arrow keys, and swipes turn pages.

If you update the frontend separately, update the server too so ordinary readers can check the experiment setting. Older servers that deny that check offer chapter sync until upgraded; a denied check does not enable sentence following. The app retains a previously confirmed setting for offline reading.

On the phone and tablet apps the ebook opens as a full-screen reader of its own, over whatever you were doing, and closing it puts you back there. It reads like a paper book: tap the left or right edge of the page to turn it, swipe if you prefer, and tap a mapped sentence in the middle to play from there. A turned page curls over like paper, and a page you drag follows your finger until you let go: carry it across to turn it, or put it back down to stay where you are; to turn pages instantly instead, switch off **Page turn animation** in **Settings → Behavior**. It is also skipped when the device asks for reduced motion. A tap on an empty part of the page hides the bars for distraction-free reading and brings them back. The title bar holds the follow toggle, the **Contents** sheet (chapters and any other companion files), and the **Appearance** sheet (theme, text size, **Improve sync**). The theme starts on **auto**, which turns the page dark whenever the app is in its dark look (the system theme, or the appearance chosen in Settings on the phone); pick **paper**, **sepia**, or **night** to fix it. Under the page a strip shows the sync state and the page within the chapter, and holds the full player so you never have to leave the book: play/pause, skip back and forward, and buttons for speed, the sleep timer, and the chapter list that open over the page. When the book isn't the one playing, a **Listen while you read** button starts it instead. Full-screen focus mode on the web uses the same layout.

EPUBs without an aligned map use chapter sync; OperaLibre does not estimate sentence timings. To enable sentence following, an administrator can either put a matching `.sync.json` file beside the book and rescan, or set up automatic alignment:

1. Open **Administration → Experiments** and install the optional follow-along generator (owner only).
2. Choose **Enable**.
3. Open the book’s reader and select **Improve sync**.

The reader explains what the button does before you press it, and shows a progress bar with the chapter being aligned, the percentage done, how long it has been running, and a rough estimate of the time left. The bar is read from the server, so closing the reader, moving to another book, or reloading the page does not stop the run — reopening the book picks the progress back up.

Alignment matches numbered chapter labels across formats such as “Chapter One” and “1”, and “Interlude Three” and “I-3”. It keeps narrated image titles separate from prose and recognizes trailing illustrations that share an EPUB document with a chapter. The reader can use accessible image descriptions to distinguish a part heading from an illustration on the same page. When confidently matched speech skips whole EPUB sentences, those sentences remain unhighlighted; surrounding narration keeps its own timing. Additional speech, such as a diagram description absent from the visible EPUB text, can likewise be kept separate when matching phrases bracket it. Suspect speech-recognition windows are retried automatically with a stronger model and, if needed, shorter overlapping windows. A shorter retry is used only when it improves the ordered text matches. These checks can increase generation time. These improvements apply when generating a new map; updating the client alone does not regenerate saved timings.

Follow-along generation is developed and tested with English books. The audiobook and EPUB must be in the same language; a translation cannot be aligned with audio in another language. Other languages that separate words with spaces, such as Spanish, French, or German, can be aligned, but they use a general multilingual recognizer that is less accurate than the English one, so expect more retries and more unhighlighted passages. The EPUB’s language metadata selects the recognizer, so a Spanish book whose EPUB is labelled English aligns poorly; correct the label before generating. Chapter words and spelled-out numbers are understood only in English (“Chapter Twelve”); in other languages, chapters are paired by identical titles, leading digits, or their order. Languages written without spaces between words, such as Chinese, Japanese, and Thai, are not supported.

Generation downloads any missing model files, so initial use requires network access. Generation runs locally; audiobook contents are not uploaded anywhere. Jobs run one at a time; repeated requests for the same book reuse its queued, running, or paused job.

To monitor several books together, open **Administration → Experiments** and expand **Sync activity** under the follow-along sync generator. It shows running and queued books, progress, elapsed time, and recent completed or failed results. Select a book title to open it. The view refreshes while expanded; collapsing it does not stop server jobs. Use the small × to remove a queued or paused book, and the up/down arrows to change the queue order. Pause saves completed chapters or tracks after the current section finishes; a book without matched chapter boundaries may need to finish its whole track first. Resume puts the book back at the end of the queue. Paused books stay paused across server restarts. Server updates interrupt running syncs at their last saved section and resume them automatically once the server is ready; the unfinished section is repeated. A failed update resumes the queue on the current server. The queue, saved sections, and recent results survive restarts. Interrupted books resume from the last completed section once the library is ready and the generator is enabled; an unfinished section is repeated. If the audio, EPUB, alignment runtime, or server alignment code changes, generation starts over. Previous maps stay usable until replacements are saved.

When an update includes a mapping improvement that warrants regeneration, older generated maps show an **Outdated map** badge in Sync activity. Ordinary updates do not trigger this. Maps generated before revision tracking was introduced are treated as older maps. You can re-sync a single book, sync all missing and outdated maps now, or enable nightly batches. Choose a time and a books-per-night limit (two by default, from 1 to 100); the panel estimates the minimum number of nights needed. Batches run one book at a time and may continue into the day. Current maps and third-party sidecars are left alone. Disable the nightly rule to stop future batches; work already queued continues. Individually scheduled books keep their chosen start time. Starts missed by more than 15 minutes move to the next night for nightly batches, or show as missed for individual schedules.

Generated maps are saved in `data_dir/sync`; disabling or removing the add-on keeps them but disables sentence following. Chapter sync remains available. The app remembers the last server setting so downloaded audio, EPUBs, and sync maps can still follow sentences after an offline restart; reconnecting applies any setting changes made on the server. A matching `.sync.json` file beside the book takes priority, except when a current generated map replaces an outdated OperaLibre map. Sync quality is best when the audio track names, or the chapters embedded in an M4B, correspond to the EPUB chapter titles. Processing time and memory depend on the book and server; generation can compete with playback on smaller machines. The current implementation transcribes successive windows across long chapters and then aligns their text; it does not yet use sparse speech sampling. Wait for queued and running jobs to finish before updating, disabling, or removing the add-on.

Development and manually managed installations may instead set `alignment_cli_path` to an existing echogarden executable. A manually configured generator is treated as installed and enabled, but OperaLibre does not update or remove it.

### Extras: maps, illustrations, and supplements

Audible titles often come with a PDF of maps or illustrations rather than the book's text. OperaLibre opens each companion during a scan and tells the two apart, so a picture PDF is offered as **Extras** instead of being presented as the book. A book can have both: the reader then shows tabs above the page for the ebook, each supplement, and a gallery of any loose pictures in the book's folder (in the phone reader these are listed under **Other files** in the Contents sheet). A book with only extras shows a **View extras** invitation in place of the reader.

## Import Audible books with Libation (optional)

Install a recent [Libation](https://github.com/rmcrackan/Libation) CLI on the same computer as OperaLibre. Add every Audible account in Libation itself; OperaLibre reads the accounts Libation already knows about rather than signing them in. Give each account a short label such as **Dad** or **UK**; that label appears on its books instead of the Audible email address. The catalog can be filtered or sorted by account.

Add the Libation CLI path and `libation_files_dir` to `server.config`, restart OperaLibre, and choose **Get books → Audible** to browse purchases and download or request a title. In the native apps, account status and refresh controls are under **Settings → Book stores → Audible**. Detailed path examples and troubleshooting are in [Libation / Audible Import](libation.md).

## Games

The installed iPhone and Android apps include a games tab with small on-device diversions — a daily word puzzle and a match-three board. It appears in the bottom navigation by default, and you can hide it in **Settings**. The games run entirely on the device and send nothing to the server.

## Check for application updates

Open **Administration → Overview** and choose **Check for updates** under **Software versions**. In a browser this checks the installed server and its separately updatable web application; in the installed iOS app it checks the connected server. Owners can install supported managed-package updates from the same card when one is available.

## Connect to Jellyfin instead

OperaLibre can be used as a client for an existing Jellyfin audiobook library; no OperaLibre server configuration is needed for this mode.

1. On the connection screen, choose **Use a Jellyfin server**.
2. Enter the Jellyfin address. The common local address is `http://localhost:8096`; on a phone, use the server’s LAN address instead.
3. Sign in with a normal Jellyfin user account.

In Jellyfin mode, OperaLibre lists and streams audiobooks, groups multi-file albums, shows cover art and chapters, and syncs resume position with Jellyfin. Playback speed, sleep timers, and local volume adjustment remain available. OperaLibre-only administration, uploading, Libation, metadata editing, server readalong, and the reader ledger are not available in this mode.

Use a **Books** library in Jellyfin and give your account access to it. Audiobooks stored as music are not included. Audio streams use the original file: the browser or device must support its format; OperaLibre does not currently negotiate Jellyfin transcoding.

When your Jellyfin account permits downloads, iOS and Android offer offline audio downloads. The web app offers **Download tracks** with individual file links; it does not create a book ZIP or an offline web library. Download permission also applies to Jellyfin administrators. A previously cached account with unknown permission needs an online sign-in refresh before new downloads are offered; existing offline copies remain available.

Audiobookshelf is not yet a supported server connection in these apps. OperaLibre's `/abs` endpoints serve compatible clients connecting to an OperaLibre server.

## macOS app

The macOS app is a small native window around the web app. From the repository root, run `./script/build_and_run.sh`, then enter the address of a running OperaLibre or Jellyfin server on its first screen. It remembers the address and sign-in token between launches. Start the OperaLibre server separately with `npm run dev:server` while developing, or use the production server command in [Getting Started](getting-started.md#keep-it-running-recommended-after-you-have-tried-it).
