# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- iPhone and iPad have two Home Screen widgets. Continue listening comes in small, medium, and large sizes, and tapping it resumes the book it shows. The reading streak widget shows your current and longest streaks and recent activity. ([#535](https://github.com/DonovanMontoya/OperaLibre/pull/535))
- On a phone or tablet, hold a planned book in Up Next and drag it to a new place. ([#520](https://github.com/DonovanMontoya/OperaLibre/pull/520))
- Settings → Behavior in the iPhone and Android apps has Remove downloads when finished, which deletes a book's downloaded audio from the phone when you finish it. It is off by default, and books imported from the phone are never removed. ([#519](https://github.com/DonovanMontoya/OperaLibre/pull/519))
- Games has two new games in place of Word Grid: Shelf Sort, where you move books between stacks until each stack holds one color, and Cover Grid, a sliding puzzle made from one of your own covers. ([#515](https://github.com/DonovanMontoya/OperaLibre/pull/515))
- The web player can pop out into its own small window from Pop out in the player or the window button on the mini player. Chrome and Edge keep the window on top of other windows. ([#513](https://github.com/DonovanMontoya/OperaLibre/pull/513))
- Listeners can save private audio clips. The Clip ribbon on the cover in Now Playing saves the last 30 seconds and the next 10, and a clip can be named, trimmed, shared as an audio file, or used to continue listening from that point. Clips are off by default. Turn on Audio clips under Beta Features in Settings or the account menu. Only the listener who saved a clip can see it. ([#305](https://github.com/DonovanMontoya/OperaLibre/pull/305))
- Settings → Display offers eight Home Screen icons on iOS and Android. The choice applies to the device, and Classic restores the original icon. ([#570](https://github.com/DonovanMontoya/OperaLibre/pull/570))
- Administration → Experiments lists the experiments with their state and opens one at a time. Where Administration has a navigation column, the list sits beside the open experiment. ([#565](https://github.com/DonovanMontoya/OperaLibre/pull/565))
- Nightly builds now offer new sync add-on releases that match the add-on version in their source. ([#563](https://github.com/DonovanMontoya/OperaLibre/pull/563))

### Changed

- The game picker in the apps is a row of tabs, and game names stay inside their tabs at large text sizes. ([#531](https://github.com/DonovanMontoya/OperaLibre/pull/531))
- Book previews start sooner, and in the apps a downloaded book previews from the copy on the device. ([#530](https://github.com/DonovanMontoya/OperaLibre/pull/530))
- The one-line installer now requires a verified release signature before it installs, and explains how to set up OpenSSL 3 when it cannot check one. It no longer installs releases older than 0.4.6. ([#522](https://github.com/DonovanMontoya/OperaLibre/pull/522)), ([#551](https://github.com/DonovanMontoya/OperaLibre/pull/551))
- Chapter notes start collapsed behind a toggle that shows the chapter count and the current chapter, and fold back up when you are done. ([#561](https://github.com/DonovanMontoya/OperaLibre/pull/561))
- English follow-along sync recognizes speech with NVIDIA Parakeet models, sized to the server. ([#562](https://github.com/DonovanMontoya/OperaLibre/pull/562))

### Fixed

- Full-screen tabs in the iOS app, such as Listening and Games, no longer show a scrollbar or shift when dragged. ([#534](https://github.com/DonovanMontoya/OperaLibre/pull/534), [#518](https://github.com/DonovanMontoya/OperaLibre/pull/518))
- A PDF companion built to expand to a huge size can no longer use up the server's memory during a library scan. ([#528](https://github.com/DonovanMontoya/OperaLibre/pull/528))
- Loudness analysis, clip export, follow-along, and faststart conversion only read library tracks as local audio files, so a file disguised as audio cannot make the server fetch something else. A track whose contents are in another format still streams but can no longer be analyzed, clipped, or synced. ([#527](https://github.com/DonovanMontoya/OperaLibre/pull/527))
- Changing the chapter notes endpoint to a different address asks for the API key again instead of sending the saved key to the new address. ([#526](https://github.com/DonovanMontoya/OperaLibre/pull/526))
- Faststart conversion checks that each file is still inside the library before converting it, and stops ffmpeg if it hangs instead of blocking later conversions. ([#525](https://github.com/DonovanMontoya/OperaLibre/pull/525))
- A cancelled or dropped audiobook upload no longer leaves partial files in the library folder until the server restarts. ([#524](https://github.com/DonovanMontoya/OperaLibre/pull/524))
- Another program on the same computer can no longer use a signed-in browser session by posing as one of the OperaLibre apps. The apps themselves are not affected. ([#523](https://github.com/DonovanMontoya/OperaLibre/pull/523))
- The apps no longer offer an Open link for companion files downloaded to the device, which on Android could let an HTML companion run as part of the app. ([#521](https://github.com/DonovanMontoya/OperaLibre/pull/521))
- Books with a large, full-resolution embedded cover keep their cover, title, author, and chapters. ([#510](https://github.com/DonovanMontoya/OperaLibre/pull/510))
- New follow-along maps keep their timing where narration resumes after a stretch of noise. ([#502](https://github.com/DonovanMontoya/OperaLibre/pull/502))
- The Reading Streak widget on iOS now counts listening done offline, because the app records daily listening time on the device. ([#566](https://github.com/DonovanMontoya/OperaLibre/pull/566))
- The medium and large Continue listening widgets show the Resume button, and the corner icon is now the open book from the app icon. ([#568](https://github.com/DonovanMontoya/OperaLibre/pull/568))
- Text and icons that were hard to read are legible in every appearance. The worst case was the Saved clips sheet in the light themes. ([#569](https://github.com/DonovanMontoya/OperaLibre/pull/569))
- On the Duo, the shelf refresh spinner is centered over the shelf and availability badges stay in place. ([#564](https://github.com/DonovanMontoya/OperaLibre/pull/564))
- On iOS, your listening position is saved before a pause finishes, and again when the audio route changes or the app goes to the background. ([#560](https://github.com/DonovanMontoya/OperaLibre/pull/560))
- Reopening a book after listening offline no longer leaves the player on the old position when another device has listened further on. ([#550](https://github.com/DonovanMontoya/OperaLibre/pull/550))
- On iOS, web content stays visible when you resize a window, and tab controls and touch routing line up in the rail layout. ([#552](https://github.com/DonovanMontoya/OperaLibre/pull/552)), ([#559](https://github.com/DonovanMontoya/OperaLibre/pull/559))
- CarPlay stops at an unavailable track instead of skipping it, and keeps your listening progress until it has been saved. ([#553](https://github.com/DonovanMontoya/OperaLibre/pull/553)), ([#558](https://github.com/DonovanMontoya/OperaLibre/pull/558))
- Android downloads no longer get stuck when one finishes while the download worker is shutting down. ([#554](https://github.com/DonovanMontoya/OperaLibre/pull/554))
- A managed update that was applied but whose confirmation was lost now recovers without restoring old data. ([#557](https://github.com/DonovanMontoya/OperaLibre/pull/557))

## [0.5.5] - 2026-11-15

### Added

- Settings → Display in the apps, and Account menu → Display on the web, offer red-green, blue-yellow, and monochrome color options and a Stronger visual cues switch. The choices stay on the device. ([#490](https://github.com/DonovanMontoya/OperaLibre/pull/490))
- Owners can have follow-along send its speech recognition clips to OpenAI with their own API key. Recognition on the server stays the default. ([#476](https://github.com/DonovanMontoya/OperaLibre/pull/476))
- Chapter notes, an experiment the owner turns on under Administration → Experiments, write a spoiler-free synopsis, a summary, and a list of people and terms for each chapter, using a model the owner chooses. Summaries of chapters you have not finished stay hidden until you tap Show spoilers. ([#470](https://github.com/DonovanMontoya/OperaLibre/pull/470))
- When ffmpeg is available, the server measures each book's loudness after a scan and plays books mastered too quietly or too loudly at a corrected volume. The playback sheet says when the volume was adjusted, and each listener can turn it off or set their own level. Audio files are never changed. ([#457](https://github.com/DonovanMontoya/OperaLibre/pull/457))

### Changed

- An assistant can no longer add or request a book by itself. It sends you to Get books to do it. The server also limits how much it reads from chapter note and transcription providers. ([#499](https://github.com/DonovanMontoya/OperaLibre/pull/499))
- Long audiobooks start playing much sooner on iPhone, because the player no longer downloads the whole seek index before it starts. ([#491](https://github.com/DonovanMontoya/OperaLibre/pull/491))
- Covers already saved on the phone show without downloading them again, and first loads fetch a smaller copy for display. ([#487](https://github.com/DonovanMontoya/OperaLibre/pull/487))

### Fixed

- The server limits memory and disk use for Cloudflare replies, recaps, companion files, and the phone cover cache, and a waiting gift can no longer take every download slot. Audible refresh works again for listeners who cannot see account details. ([#498](https://github.com/DonovanMontoya/OperaLibre/pull/498))
- The Listening screen shows cover art at its own shape instead of stretching the frame around it. ([#495](https://github.com/DonovanMontoya/OperaLibre/pull/495))
- On phones, the Up Next card keeps its move and remove buttons on the status line, so the card is only as tall as its text. ([#494](https://github.com/DonovanMontoya/OperaLibre/pull/494))
- Phone Shelf and queue rows give the title and author more room beside the cover. ([#486](https://github.com/DonovanMontoya/OperaLibre/pull/486))
- Choosing a chapter from Contents in the reader moves to that chapter, and fast page turns no longer leave old work running. ([#485](https://github.com/DonovanMontoya/OperaLibre/pull/485))

### Removed

- The apps no longer connect to Jellyfin servers. A saved Jellyfin connection is cleared once, and the app asks for an OperaLibre server instead. ([#428](https://github.com/DonovanMontoya/OperaLibre/pull/428))

## [0.5.4] - 2026-11-13

### Added

- Owners who turn on book gifts can set up the gift broker by pasting a Cloudflare token, and can reinstall it after an update or connect an existing broker by hand. ([#469](https://github.com/DonovanMontoya/OperaLibre/pull/469))
- Book gifts, an experiment the owner turns on under Administration → Experiments, send a book as a one-time link that the iPhone and Android apps can open and keep without an account. Each phone asks before opening its first gift and can turn receiving off in Settings. ([#430](https://github.com/DonovanMontoya/OperaLibre/pull/430))

### Changed

- On an unfolded iPhone Duo, the Listening page no longer repeats the playing book on the left, and the player page uses lighter type. ([#473](https://github.com/DonovanMontoya/OperaLibre/pull/473))
- Gifting a book moved into More → Gift this book, gift availability updates without a reload, and the audiobook files are selected by default. ([#471](https://github.com/DonovanMontoya/OperaLibre/pull/471))

### Fixed

- The upload spinner no longer touches the Uploading label. ([#482](https://github.com/DonovanMontoya/OperaLibre/pull/482))
- EPUB chapters, stylesheets, and images open faster, most of all in large books, and small server replies no longer wait on a network delay. ([#477](https://github.com/DonovanMontoya/OperaLibre/pull/477))
- Secondary text, gold accents, series names, and the Games boards read clearly on the iPhone light themes. ([#474](https://github.com/DonovanMontoya/OperaLibre/pull/474))
- The Pick up where you left off cards on the empty player open the book at its saved position. ([#468](https://github.com/DonovanMontoya/OperaLibre/pull/468))

### Removed

- The ebook reader no longer offers chapter sync: a book without a sync map shows no Follow button and says it is not synced. ([#475](https://github.com/DonovanMontoya/OperaLibre/pull/475))

## [0.5.3] - 2026-11-09

### Fixed

- An update that starts in the same second as a rolled-back one now gets its own backup folder instead of failing with "File exists". ([#463](https://github.com/DonovanMontoya/OperaLibre/pull/463))

## [0.5.2] - 2026-11-09

### Added

- The Up next heading on the Shelf can collapse the queue, and the choice stays on this device. ([#455](https://github.com/DonovanMontoya/OperaLibre/pull/455))
- Refreshing Get books asks Audible for new purchases instead of only rereading the last Libation scan. ([#417](https://github.com/DonovanMontoya/OperaLibre/pull/417))
- Settings → Display on iPhone and iPad also offers five light themes: Parchment, Linen, Sage, Harbor, and Pure White. ([#416](https://github.com/DonovanMontoya/OperaLibre/pull/416))
- Settings → Display on iPhone and iPad offers five dark themes: Warm, Graphite, Midnight, Reading Room, and True Black. ([#412](https://github.com/DonovanMontoya/OperaLibre/pull/412))

### Changed

- The iPhone app follows the system text size, the Shelf header gathers import, upload, and refresh into one Add button, and the playback and sleep timer sheets follow the chosen theme. ([#452](https://github.com/DonovanMontoya/OperaLibre/pull/452))
- Updates keep only the most recent completed backup of the server, web app, and follow-along add-on instead of every earlier copy. ([#447](https://github.com/DonovanMontoya/OperaLibre/pull/447))
- App fonts (Fraunces, Instrument Serif, and JetBrains Mono) load from the app instead of Google Fonts. ([#405](https://github.com/DonovanMontoya/OperaLibre/pull/405))
- A rebuilt follow-along map is picked up right away instead of keeping an older cached copy. ([#400](https://github.com/DonovanMontoya/OperaLibre/pull/400))

### Fixed

- The web app's layout holds up at every window size, from a phone on its side to a wide monitor. ([#462](https://github.com/DonovanMontoya/OperaLibre/pull/462))
- The server and launcher bundle a patched SQLite that fixes a security advisory. ([#459](https://github.com/DonovanMontoya/OperaLibre/pull/459))
- The iPhone and Android apps keep a copy of each Shelf cover, so covers still show after signing in again, switching addresses, or losing the server. ([#456](https://github.com/DonovanMontoya/OperaLibre/pull/456))
- Shelf badge icons stay visible in the iPhone light themes. ([#454](https://github.com/DonovanMontoya/OperaLibre/pull/454))
- Rotating an open iPhone Duo in the read-along no longer flashes the player and library over the book. ([#453](https://github.com/DonovanMontoya/OperaLibre/pull/453))
- The Games room takes the colors of the Linen, Sage, Harbor, and Pure White light themes. ([#450](https://github.com/DonovanMontoya/OperaLibre/pull/450))
- Covers already seen load from the app's cache, and a cover that fails to load is retried when the network returns. ([#449](https://github.com/DonovanMontoya/OperaLibre/pull/449))
- Owners can turn a follow-along runtime found on the server's PATH off and on again in Administration → Experiments. ([#448](https://github.com/DonovanMontoya/OperaLibre/pull/448))
- Deleting an account also removes its listening activity, so it no longer shows up in backups or on a new account. ([#445](https://github.com/DonovanMontoya/OperaLibre/pull/445))
- A forward seek from CarPlay or the lock screen can no longer let a stray 0:00 overwrite saved progress. ([#442](https://github.com/DonovanMontoya/OperaLibre/pull/442))
- The server start scripts no longer print a fixed localhost address that may not be where the server listens. ([#440](https://github.com/DonovanMontoya/OperaLibre/pull/440))
- Wrong sign-in guesses can no longer keep an account's owner locked out or block every new sign-in, and http://localhost is no longer a trusted app origin. ([#437](https://github.com/DonovanMontoya/OperaLibre/pull/437))
- An unreadable follow-along checkpoint restarts that book instead of failing the job. ([#436](https://github.com/DonovanMontoya/OperaLibre/pull/436))
- A server download on iPhone that finishes just after it was cancelled no longer leaves a stray file behind. ([#435](https://github.com/DonovanMontoya/OperaLibre/pull/435))
- When a failed update is rolled back, the database and library identities it upgraded are restored too. ([#434](https://github.com/DonovanMontoya/OperaLibre/pull/434))
- Android downloads only follow links on the connected server, so the access token is not sent anywhere else. ([#433](https://github.com/DonovanMontoya/OperaLibre/pull/433))
- Closing a browser tab saves the last listening position more reliably. ([#432](https://github.com/DonovanMontoya/OperaLibre/pull/432))
- Progress carried over from older installs is protected from an accidental reset to 0:00 like any other saved position. ([#431](https://github.com/DonovanMontoya/OperaLibre/pull/431))
- The macOS app rolls back to the previous web app when an updated one fails to start. ([#429](https://github.com/DonovanMontoya/OperaLibre/pull/429))
- iOS keeps saved downloads and CarPlay sessions it cannot read, instead of dropping them on save. ([#425](https://github.com/DonovanMontoya/OperaLibre/pull/425))
- An unreadable read-along job file no longer stops the server from starting. ([#424](https://github.com/DonovanMontoya/OperaLibre/pull/424))
- An unreadable permissions version no longer re-grants admin rights. ([#423](https://github.com/DonovanMontoya/OperaLibre/pull/423))
- Playback continues when the iOS app's page reloads instead of loading the book again. ([#422](https://github.com/DonovanMontoya/OperaLibre/pull/422))
- The library reconnects on its own when the first request at launch fails. ([#421](https://github.com/DonovanMontoya/OperaLibre/pull/421))
- The mini player uses the selected light theme's Shelf color. ([#420](https://github.com/DonovanMontoya/OperaLibre/pull/420))
- The Chapters sheet opens with the playing chapter centered. ([#419](https://github.com/DonovanMontoya/OperaLibre/pull/419))
- Store purchase cards open from anywhere on the row and close with a downward swipe. ([#418](https://github.com/DonovanMontoya/OperaLibre/pull/418))
- Secondary actions on the book page and mini player look and act as buttons. ([#415](https://github.com/DonovanMontoya/OperaLibre/pull/415))
- Long book titles in Settings → On Device stay inside the card, and store status labels stay on one line. ([#413](https://github.com/DonovanMontoya/OperaLibre/pull/413))
- The iPhone player keeps drawing when a scheduler message is lost. ([#411](https://github.com/DonovanMontoya/OperaLibre/pull/411))
- Embedded cover art and audio tags are read with size limits so a bad file cannot exhaust memory. ([#410](https://github.com/DonovanMontoya/OperaLibre/pull/410))
- Library scans stay under the library folder and do not follow links out of it. ([#409](https://github.com/DonovanMontoya/OperaLibre/pull/409))
- Native Libro.fm downloads stop when a book's retained parts would exceed 25 GiB. ([#408](https://github.com/DonovanMontoya/OperaLibre/pull/408))
- Large library catalogue responses are bounded so a busy server returns a retry later response instead of running out of memory. ([#407](https://github.com/DonovanMontoya/OperaLibre/pull/407))
- Public server addresses must use HTTPS in the macOS app as well. Private LAN and loopback HTTP still work. ([#404](https://github.com/DonovanMontoya/OperaLibre/pull/404))
- Libro.fm responses on iPhone are rejected when they grow past a size limit. ([#403](https://github.com/DonovanMontoya/OperaLibre/pull/403))
- Session creation waits for password changes and credential revocation to finish, so a just-replaced password cannot still issue a session. ([#402](https://github.com/DonovanMontoya/OperaLibre/pull/402))
- Sign-in throttling counts attempts before checking the password, so concurrent tries cannot slip past the limit. ([#399](https://github.com/DonovanMontoya/OperaLibre/pull/399))
- Saved sign-ins keep the original case of reverse-proxy paths. Older path-based vault keys need a fresh sign-in. ([#398](https://github.com/DonovanMontoya/OperaLibre/pull/398))
- Direct Libation downloads stop accepting new work after a per-user and overall limit, and return a retry later response when full. ([#395](https://github.com/DonovanMontoya/OperaLibre/pull/395))

## [0.5.1] - 2026-10-29

### Added

- Stand a folded iPhone Duo on its edges and the playing book fills the cover screen with large playback controls. The screen stays awake while it plays. ([#383](https://github.com/DonovanMontoya/OperaLibre/pull/383))
- Private support questions can go to operalibre@agentmail.to. Public bugs stay on GitHub. ([#381](https://github.com/DonovanMontoya/OperaLibre/pull/381))
- While a book plays, the Shelf lists it first under Now listening, with a pause button, and keeps the rest under Up next. ([#375](https://github.com/DonovanMontoya/OperaLibre/pull/375))

### Changed

- Settings, sign-in, and the account menu link to the privacy policy, and the policy describes what an assistant can be allowed to read. ([#386](https://github.com/DonovanMontoya/OperaLibre/pull/386))
- The file picker includes the privacy manifest Apple requires. ([#385](https://github.com/DonovanMontoya/OperaLibre/pull/385))
- The iPhone and iPad app requires a 64-bit device and ships Apple's privacy manifest. ([#384](https://github.com/DonovanMontoya/OperaLibre/pull/384))
- The macOS app reports the server version instead of a fixed 0.1.0. ([#380](https://github.com/DonovanMontoya/OperaLibre/pull/380))
- The server and the phone apps are versioned on separate lines. iPhone and Android share one version and build number. ([#377](https://github.com/DonovanMontoya/OperaLibre/pull/377))

### Fixed

- HTML book descriptions show as readable text, and published dates show as dates. ([#393](https://github.com/DonovanMontoya/OperaLibre/pull/393))
- A whole-book download keeps every track when two filenames would collide inside the archive. ([#391](https://github.com/DonovanMontoya/OperaLibre/pull/391))
- A failed pull-to-refresh says that it failed, and a pull the system cancels does not start a refresh. ([#390](https://github.com/DonovanMontoya/OperaLibre/pull/390))
- Dismissing metadata suggestions keeps what you typed and leaves the editor open. ([#389](https://github.com/DonovanMontoya/OperaLibre/pull/389))
- On an iPhone Duo lying flat, the reader keeps its two-page spread and lines its controls up with the tab bar. ([#382](https://github.com/DonovanMontoya/OperaLibre/pull/382))
- Follow and close keep working if a page drag is interrupted by switching apps, rotating, or folding. ([#376](https://github.com/DonovanMontoya/OperaLibre/pull/376))

## [0.5.0] - 2026-10-23

### Added

- An assistant you allow can find Audible and Libro.fm books you own that are not on the server yet, and import them or request them the same way the app does. ([#370](https://github.com/DonovanMontoya/OperaLibre/pull/370))
- Connected assistants can read your achievements and where you are in each series. ([#369](https://github.com/DonovanMontoya/OperaLibre/pull/369))
- The owner can turn on AI assistants. Each listener then creates a token for an assistant they already use, and chooses what it may read: the library, progress, listening history, and book text only up to the current position. ([#368](https://github.com/DonovanMontoya/OperaLibre/pull/368))
- A wide browser window can give the whole page to the Shelf, with cover grid, letter index, and Up Next across the top. ([#354](https://github.com/DonovanMontoya/OperaLibre/pull/354))
- Audio previews can be turned off under Behavior. The choice stays on this device. ([#330](https://github.com/DonovanMontoya/OperaLibre/pull/330))

### Changed

- Icon buttons no longer spin upside down on hover. The bell, upload, and refresh icons move with the action, and they stay still when reduced motion is on. ([#362](https://github.com/DonovanMontoya/OperaLibre/pull/362))
- On an open iPhone Duo, the Shelf fills one page and Up Next is a single list. ([#329](https://github.com/DonovanMontoya/OperaLibre/pull/329))

### Fixed

- Sliding a finger off a button before lifting it cancels the press, so a brushed skip or play does not move your place. ([#365](https://github.com/DonovanMontoya/OperaLibre/pull/365))
- Book details hide the Now playing link while the mini player is showing. ([#364](https://github.com/DonovanMontoya/OperaLibre/pull/364))
- On an open iPhone Duo, player and reader sheets open on one side of the fold, and the shared-reading list stays beside its bell. ([#359](https://github.com/DonovanMontoya/OperaLibre/pull/359))
- Expanding the Shelf to fill the browser window animates the covers and the mini player instead of snapping. ([#358](https://github.com/DonovanMontoya/OperaLibre/pull/358))
- Reconnecting an Audible account reports Libation's own error when the account list cannot be read. ([#347](https://github.com/DonovanMontoya/OperaLibre/pull/347))
- Older catalogue language codes on an EPUB are converted before follow-along alignment. ([#345](https://github.com/DonovanMontoya/OperaLibre/pull/345))
- A missing audio file during follow-along is no longer treated as a crashed recognizer. ([#344](https://github.com/DonovanMontoya/OperaLibre/pull/344))
- A missing seek position on iPhone no longer jumps playback to 0:00. ([#335](https://github.com/DonovanMontoya/OperaLibre/pull/335))
- Sleep timer labels stay inside their tiles. ([#333](https://github.com/DonovanMontoya/OperaLibre/pull/333))
- The mini player cover keeps its shape on the book details page. ([#332](https://github.com/DonovanMontoya/OperaLibre/pull/332))
- The Downloading status fits in the purchase list. ([#331](https://github.com/DonovanMontoya/OperaLibre/pull/331))

## [0.4.17] - 2026-10-13

### Added

- Listeners can pick an illustrated profile picture, or go back to their initial. ([#327](https://github.com/DonovanMontoya/OperaLibre/pull/327))
- A book page can play the first five minutes without saving progress or changing Up Next, then continue into the book. ([#325](https://github.com/DonovanMontoya/OperaLibre/pull/325))
- Choosing an Audible or Libro.fm purchase opens a details page for it before the book is on the server. ([#324](https://github.com/DonovanMontoya/OperaLibre/pull/324))
- Up Next holds books you plan to play without starting them or moving their saved position. The queue stays on this device for the current server and account. ([#323](https://github.com/DonovanMontoya/OperaLibre/pull/323))
- Poor and failed follow-along chapters explain the likely cause and can offer a bounded repair, including a re-sync in another language. ([#317](https://github.com/DonovanMontoya/OperaLibre/pull/317))
- A follow-along run keeps going when one chapter fails, and an administrator can re-run just the failed chapters. ([#316](https://github.com/DonovanMontoya/OperaLibre/pull/316))
- Follow-along maps are graded by chapter, and Administration shows which books need attention. ([#315](https://github.com/DonovanMontoya/OperaLibre/pull/315))

### Changed

- A newer follow-along result replaces older activity cards, and finished results can be dismissed. ([#318](https://github.com/DonovanMontoya/OperaLibre/pull/318))
- Marking a book finished or unfinished asks you to confirm first. ([#310](https://github.com/DonovanMontoya/OperaLibre/pull/310))

### Fixed

- The iPhone player is rebuilt after an audio-services reset. ([#322](https://github.com/DonovanMontoya/OperaLibre/pull/322))
- iPhone retries resuming playback after an interruption. ([#321](https://github.com/DonovanMontoya/OperaLibre/pull/321))
- Opening the book that is already playing does not pause it or move its position. ([#320](https://github.com/DonovanMontoya/OperaLibre/pull/320))
- When recognition has already produced a usable follow-along result, a crash in a later pass does not fail the book. ([#314](https://github.com/DonovanMontoya/OperaLibre/pull/314))
- Follow-along alignment uses the book's language, so an English EPUB is not guessed as another language. ([#313](https://github.com/DonovanMontoya/OperaLibre/pull/313))
- A stream the server refuses is reported separately from audio the device cannot play. ([#312](https://github.com/DonovanMontoya/OperaLibre/pull/312))
- EPUB form controls stay readable in dark themes. ([#311](https://github.com/DonovanMontoya/OperaLibre/pull/311))
- Tapping the Shelf tab again scrolls the Shelf back to the top. ([#309](https://github.com/DonovanMontoya/OperaLibre/pull/309))

## [0.4.16] - 2026-10-11

### Added

- Collapsed shelf groups can be opened all at once. ([#306](https://github.com/DonovanMontoya/OperaLibre/pull/306))
- Shelf groups for series, tag, genre, or progress can be folded. The folds stay on this device, and search still finds books inside them. ([#304](https://github.com/DonovanMontoya/OperaLibre/pull/304))
- The sleep timer can stop at the end of the current chapter. ([#301](https://github.com/DonovanMontoya/OperaLibre/pull/301))
- Audible accounts can be connected, renamed, and removed in OperaLibre, and accepted imports survive a restart. ([#291](https://github.com/DonovanMontoya/OperaLibre/pull/291))
- The Shelf can be filtered to books with an ebook, or to books whose text follows the audio. ([#289](https://github.com/DonovanMontoya/OperaLibre/pull/289))

### Changed

- The release installer no longer asks for an Audible login. Connect Audible in the app after setup. ([#298](https://github.com/DonovanMontoya/OperaLibre/pull/298))
- Publishing a stable release also publishes a nightly build from the same commit. ([#287](https://github.com/DonovanMontoya/OperaLibre/pull/287))
- The connection screen leads with the server address, Jellyfin, and listening with no server. ([#285](https://github.com/DonovanMontoya/OperaLibre/pull/285))

### Fixed

- Update notes use the previous release even when history was rewritten, so an update does not repeat changes you already have. ([#308](https://github.com/DonovanMontoya/OperaLibre/pull/308))
- Opening a paused book no longer treats a timestamp refresh as new listening that can overwrite another device. ([#303](https://github.com/DonovanMontoya/OperaLibre/pull/303))
- On the phone, Get books links each store to its account settings, and Add to server fits on one line. ([#302](https://github.com/DonovanMontoya/OperaLibre/pull/302))
- Removing the download of the book you are playing saves the position and stops playback, including on CarPlay, before deleting the files. ([#300](https://github.com/DonovanMontoya/OperaLibre/pull/300))
- Password reset and Audible sign-in are limited to the right accounts, and deleting a book folder cannot remove a nested book. ([#297](https://github.com/DonovanMontoya/OperaLibre/pull/297))
- Book actions on a phone stay in fixed places, including when a book has no ebook. ([#295](https://github.com/DonovanMontoya/OperaLibre/pull/295))
- Descriptions that are only nonbreaking spaces are hidden, so a real catalogue description can show instead. ([#294](https://github.com/DonovanMontoya/OperaLibre/pull/294))
- Downloaded audio becomes playable as soon as the audio check finishes, even if a cover or ebook check is still running. ([#293](https://github.com/DonovanMontoya/OperaLibre/pull/293))
- A download says which of the audio, ebook, and sentence sync is actually on the device, and missing pieces can be retried without dropping the audio. ([#292](https://github.com/DonovanMontoya/OperaLibre/pull/292))
- Library search matches every word across title, author, narrator, series, tags, and genres. ([#290](https://github.com/DonovanMontoya/OperaLibre/pull/290))
- Pausing a follow-along job stops the alignment in progress and keeps the chapters already finished. ([#286](https://github.com/DonovanMontoya/OperaLibre/pull/286))

### Removed

- The library header no longer says The Collection. ([#307](https://github.com/DonovanMontoya/OperaLibre/pull/307))

## [0.4.15] - 2026-10-06

### Added

- Administrators can reorder, pause, resume, and remove queued follow-along jobs. A paused job stays paused across a restart. ([#282](https://github.com/DonovanMontoya/OperaLibre/pull/282))
- The ebook reader can curl the page as you turn it. The animation can be turned off, and it stays off when reduced motion is on. ([#276](https://github.com/DonovanMontoya/OperaLibre/pull/276))
- The Shelf can be filtered to books that have their text beside the audio. ([#273](https://github.com/DonovanMontoya/OperaLibre/pull/273))

### Fixed

- Tapping the playback timeline on iPhone seeks there instead of freezing the scrubber. ([#280](https://github.com/DonovanMontoya/OperaLibre/pull/280))
- If the server saved a position but the reply was lost, later listening on that phone continues forward instead of jumping backward. ([#279](https://github.com/DonovanMontoya/OperaLibre/pull/279))
- An older progress replay from the same iPhone no longer overwrites newer listening the phone already recorded. ([#277](https://github.com/DonovanMontoya/OperaLibre/pull/277))
- Opening Reading on iPad no longer flashes a second player over the Shelf animation. ([#275](https://github.com/DonovanMontoya/OperaLibre/pull/275))
- On a split iPhone Duo screen, the page stays clear of the side tab bar. ([#274](https://github.com/DonovanMontoya/OperaLibre/pull/274))

## [0.4.14] - 2026-10-04

### Fixed

- Audible imports no longer fail because Libation left diagnostic sockets in the staging folder. ([#272](https://github.com/DonovanMontoya/OperaLibre/pull/272))
- Scheduled nightly builds start after 8:17pm Eastern. ([#271](https://github.com/DonovanMontoya/OperaLibre/pull/271))

## [0.4.13] - 2026-10-03

### Added

- In a browser, the ebook reader fills the window, with contents, the page, and follow-along controls around it. ([#266](https://github.com/DonovanMontoya/OperaLibre/pull/266))
- iPad has separate Shelf and Reading tabs. Shelf is the library at full width, and Reading is the library beside the player. ([#262](https://github.com/DonovanMontoya/OperaLibre/pull/262))

### Changed

- The offline demo is an excerpt of Alice's Adventures in Wonderland, with its EPUB and sentence timing. ([#264](https://github.com/DonovanMontoya/OperaLibre/pull/264))

### Fixed

- After an update signing key rotates, the server and the macOS app remember the new key. ([#261](https://github.com/DonovanMontoya/OperaLibre/pull/261))

## [0.4.12] - 2026-10-02

### Added

- Owners and administrators can replace a book's cover from Edit Info without rewriting the audio file. ([#246](https://github.com/DonovanMontoya/OperaLibre/pull/246))
- The phone app's opening cover draws the wordmark in, and stays a simple fade when reduced motion is on. ([#242](https://github.com/DonovanMontoya/OperaLibre/pull/242))
- Follow-along jobs are kept across a restart, and older generated maps can be marked outdated so a nightly batch can rebuild them. ([#226](https://github.com/DonovanMontoya/OperaLibre/pull/226))

### Changed

- Libation downloads stop when they would pass the storage budget. ([#253](https://github.com/DonovanMontoya/OperaLibre/pull/253))
- Opening a book from Continue Reading leaves it paused. A separate play button starts it, and Behavior can turn autoplay back on. ([#237](https://github.com/DonovanMontoya/OperaLibre/pull/237))

### Fixed

- On Windows, a Libation job stops when OperaLibre is finished with it. ([#259](https://github.com/DonovanMontoya/OperaLibre/pull/259))
- Duo layouts stay off the hinge. ([#256](https://github.com/DonovanMontoya/OperaLibre/pull/256))
- Scanning an image-heavy EPUB reads trailing pictures in one pass and stops after an unreasonable number of tags. ([#255](https://github.com/DonovanMontoya/OperaLibre/pull/255))
- One account cannot hold every EPUB processing slot. ([#254](https://github.com/DonovanMontoya/OperaLibre/pull/254))
- EPUB pages cannot send requests to other websites. Images and styles that travel with the book still load. ([#252](https://github.com/DonovanMontoya/OperaLibre/pull/252))
- Companion files are analyzed a few at a time so a scan does not hold them all in memory. ([#251](https://github.com/DonovanMontoya/OperaLibre/pull/251))
- The macOS app limits how often it downloads the update manifest. ([#250](https://github.com/DonovanMontoya/OperaLibre/pull/250))
- The reader lays the page out again at the right height after the window changes size. ([#248](https://github.com/DonovanMontoya/OperaLibre/pull/248))
- Only a limited number of EPUB entries are unpacked at once. ([#247](https://github.com/DonovanMontoya/OperaLibre/pull/247))
- Each saved server address keeps its own sign-in. ([#245](https://github.com/DonovanMontoya/OperaLibre/pull/245))
- The Android app can connect to the server. ([#244](https://github.com/DonovanMontoya/OperaLibre/pull/244))
- Duo reader and shelf layouts keep their place when the hinge moves. ([#243](https://github.com/DonovanMontoya/OperaLibre/pull/243))
- The tab bar ignores a swipe that was not meant to change tabs. ([#241](https://github.com/DonovanMontoya/OperaLibre/pull/241))
- iPad playback controls are larger. ([#240](https://github.com/DonovanMontoya/OperaLibre/pull/240))
- Author links prepared for BookPlayer are checked before they are used. ([#238](https://github.com/DonovanMontoya/OperaLibre/pull/238))
- When another device already has a newer position, reopening the book uses that position instead of a rejected offline one. ([#234](https://github.com/DonovanMontoya/OperaLibre/pull/234))
- Library scans skip hidden files and recycle-bin folders. ([#233](https://github.com/DonovanMontoya/OperaLibre/pull/233))
- The iPhone app lands on a stable tab when it launches. ([#232](https://github.com/DonovanMontoya/OperaLibre/pull/232))
- Place controls no longer sit on the full-screen reader. ([#231](https://github.com/DonovanMontoya/OperaLibre/pull/231))
- Playback and offline progress survive an interruption instead of falling back to an older position. ([#230](https://github.com/DonovanMontoya/OperaLibre/pull/230))
- A seek you chose is kept across an offline restart. ([#228](https://github.com/DonovanMontoya/OperaLibre/pull/228))
- Books already on the device stay there after an upload. ([#227](https://github.com/DonovanMontoya/OperaLibre/pull/227))
- An update handoff keeps the server process id, so the old process is the one that is replaced. ([#225](https://github.com/DonovanMontoya/OperaLibre/pull/225))
- Generated release notes compare against the previous release instead of repeating older changes. ([#224](https://github.com/DonovanMontoya/OperaLibre/pull/224))

## [0.4.11] - 2026-09-27

### Added

- Administration can switch the server between stable and nightly updates, and return to stable without wiping the library or listening progress. ([#223](https://github.com/DonovanMontoya/OperaLibre/pull/223))

### Fixed

- Reloading the native player keeps the restored position. ([#220](https://github.com/DonovanMontoya/OperaLibre/pull/220))

## [0.4.10] - 2026-09-26

### Added

- An imported audiobook on the device can be paired with an EPUB and read offline. ([#213](https://github.com/DonovanMontoya/OperaLibre/pull/213))
- The ebook reader and follow-along are available without turning on a beta switch, and the web library adds a Continue Reading row. ([#211](https://github.com/DonovanMontoya/OperaLibre/pull/211))

### Changed

- A shared Audible title appears once, with each owning account listed, and a failed download tries the other owners. ([#216](https://github.com/DonovanMontoya/OperaLibre/pull/216))
- The Games tab is on by default. ([#214](https://github.com/DonovanMontoya/OperaLibre/pull/214))

### Fixed

- Choosing another tab on iPhone changes the page, not only the tab bar. ([#215](https://github.com/DonovanMontoya/OperaLibre/pull/215))
- Follow-along stays with the narrated sentence across illustrations, headings, and chapter titles that are written in more than one way. ([#212](https://github.com/DonovanMontoya/OperaLibre/pull/212))

## [0.4.9] - 2026-09-25

### Fixed

- Follow-along keeps illustrated pages and headings on screen until the prose begins. ([#208](https://github.com/DonovanMontoya/OperaLibre/pull/208))

## [0.4.8] - 2026-09-24

### Added

- Edit Info suggests series and tag names that are already in the library. ([#201](https://github.com/DonovanMontoya/OperaLibre/pull/201))

### Changed

- Volume boost is turned off in Safari, where it distorted the audio. ([#207](https://github.com/DonovanMontoya/OperaLibre/pull/207))
- Finishing one edition marks linked editions of the same work as finished. Each edition keeps its own position. ([#205](https://github.com/DonovanMontoya/OperaLibre/pull/205))

### Fixed

- The book details page and its page turns stop jumping while the book loads. ([#206](https://github.com/DonovanMontoya/OperaLibre/pull/206))
- A title owned by more than one Audible account stays available from each owner, and Download all continues with the accounts that can still sign in. ([#204](https://github.com/DonovanMontoya/OperaLibre/pull/204))

## [0.4.7] - 2026-09-24

### Fixed

- The launcher reads server.config the same way the server does. ([#199](https://github.com/DonovanMontoya/OperaLibre/pull/199))

## [0.4.6] - 2026-09-24

### Changed

- Updates are described by one signed manifest, with one package per platform. ([#198](https://github.com/DonovanMontoya/OperaLibre/pull/198))

### Fixed

- Update packages that fail validation are rejected. ([#202](https://github.com/DonovanMontoya/OperaLibre/pull/202))
- iPhone book details, the scrubber, and landscape side bands fit their screens. ([#200](https://github.com/DonovanMontoya/OperaLibre/pull/200))
- One Audible account that cannot sign in no longer stops the other accounts from refreshing. ([#197](https://github.com/DonovanMontoya/OperaLibre/pull/197))

## [0.4.5] - 2026-09-23

### Added

- A wide browser gets the two-page Ledger, a side list in Administration, and a two-page reader in focus mode. ([#186](https://github.com/DonovanMontoya/OperaLibre/pull/186))
- The iPhone app follows the hinge on iPhone Duo and lays out the reader, Shelf, Ledger, and Games for folded and open postures. ([#167](https://github.com/DonovanMontoya/OperaLibre/pull/167))

### Changed

- EPUB checks read the file from disk instead of loading the whole book into memory. ([#189](https://github.com/DonovanMontoya/OperaLibre/pull/189))
- Library scans stay off the playback path, and Libation matches titles more strictly. ([#183](https://github.com/DonovanMontoya/OperaLibre/pull/183))
- Downloaded updates must carry an Ed25519 signature. ([#178](https://github.com/DonovanMontoya/OperaLibre/pull/178))
- The server stores only digests of session and media tokens. ([#177](https://github.com/DonovanMontoya/OperaLibre/pull/177))

### Fixed

- Follow-along can take the page while a restored position is still settling. ([#195](https://github.com/DonovanMontoya/OperaLibre/pull/195))
- If the book being restored disappears from the live library, the Shelf is shown instead of a blank player. ([#194](https://github.com/DonovanMontoya/OperaLibre/pull/194))
- The reader's page survives a resize while the book is opening or the device is folding. ([#192](https://github.com/DonovanMontoya/OperaLibre/pull/192))
- The iPhone audio session starts off the main thread, so preparing playback does not freeze the interface. ([#188](https://github.com/DonovanMontoya/OperaLibre/pull/188))
- Older offline download records are kept until they migrate, instead of disappearing on a failed upgrade. ([#187](https://github.com/DonovanMontoya/OperaLibre/pull/187))
- An Android download skips files that an earlier attempt already finished. ([#185](https://github.com/DonovanMontoya/OperaLibre/pull/185))
- iPhone cover art, CarPlay redraws, and queued downloads recover after a failure. ([#184](https://github.com/DonovanMontoya/OperaLibre/pull/184))
- A truncated Android download is rejected, and a script error no longer takes down the macOS app. ([#182](https://github.com/DonovanMontoya/OperaLibre/pull/182))
- Approving a Libation download requires the Audible account to still own the book. ([#181](https://github.com/DonovanMontoya/OperaLibre/pull/181))
- CarPlay rewind stays on that car session, and car playback bookkeeping stays on the main thread. ([#180](https://github.com/DonovanMontoya/OperaLibre/pull/180))
- Cancelling an EPUB upload removes the file it had staged. ([#179](https://github.com/DonovanMontoya/OperaLibre/pull/179))
- Lock-screen controls use the latest progress rules, and repeated sign-in attempts are throttled. ([#176](https://github.com/DonovanMontoya/OperaLibre/pull/176))
- A response that stalls after its headers no longer hangs the app, a slow download scan cannot overwrite a newer one, and the Shelf does not redraw every row on each playback tick. ([#175](https://github.com/DonovanMontoya/OperaLibre/pull/175))

## [0.4.4] - 2026-09-21

### Fixed

- Linux installs can supply the libraries Libation needs. ([#172](https://github.com/DonovanMontoya/OperaLibre/pull/172))
- Libation downloads work on a minimal Linux install. ([#171](https://github.com/DonovanMontoya/OperaLibre/pull/171))
- The release installer can walk through optional Libation sign-in without discarding an existing setup. ([#170](https://github.com/DonovanMontoya/OperaLibre/pull/170))
- A cold start with no network restores playback from books already downloaded. ([#169](https://github.com/DonovanMontoya/OperaLibre/pull/169))
- Downloaded books stay playable offline. ([#168](https://github.com/DonovanMontoya/OperaLibre/pull/168))

## [0.4.3] - 2026-09-19

### Fixed

- Sort by newest works for books that were already in the library. ([#166](https://github.com/DonovanMontoya/OperaLibre/pull/166))

## [0.4.2] - 2026-09-17

### Added

- The Shelf can be sorted by newest. ([#157](https://github.com/DonovanMontoya/OperaLibre/pull/157))

### Changed

- Audiobooks and EPUBs start streaming sooner. ([#156](https://github.com/DonovanMontoya/OperaLibre/pull/156))
- A new install listens on port 4920. ([#155](https://github.com/DonovanMontoya/OperaLibre/pull/155))

### Fixed

- The docked mini player no longer covers the iPad book page. ([#165](https://github.com/DonovanMontoya/OperaLibre/pull/165))
- Pressing Play on a streamed book shows that it is starting, a second tap cancels that start, and coming back to the app adopts a newer position saved on another device. ([#163](https://github.com/DonovanMontoya/OperaLibre/pull/163))
- The reader keeps its page across focus changes, newest sorting handles older dates, and an upgrade keeps Libation paths. ([#161](https://github.com/DonovanMontoya/OperaLibre/pull/161))
- Returning to the app shows the live playback position. ([#160](https://github.com/DonovanMontoya/OperaLibre/pull/160))
- The landscape ebook reader stays clear of the Dynamic Island. ([#159](https://github.com/DonovanMontoya/OperaLibre/pull/159))
- Word Grid rejects guesses that are not words. ([#158](https://github.com/DonovanMontoya/OperaLibre/pull/158))
- Rotating the reader clears follow-along marks that the new layout orphaned. ([#154](https://github.com/DonovanMontoya/OperaLibre/pull/154))
- Libation can start from a fresh settings file, and a missing ICU library no longer crashes it. ([#153](https://github.com/DonovanMontoya/OperaLibre/pull/153))

## [0.4.1] - 2026-09-14

### Added

- Get books can use more than one Libro.fm account, with nicknames, shared search, and separate Audible and Libro.fm lists. ([#150](https://github.com/DonovanMontoya/OperaLibre/pull/150))

### Changed

- Ledger pages use the same paper colors as the rest of the app. ([#149](https://github.com/DonovanMontoya/OperaLibre/pull/149))

### Fixed

- Rotating the reader clears a follow-along highlight that belonged to the old layout. ([#148](https://github.com/DonovanMontoya/OperaLibre/pull/148))

## [0.4.0] - 2026-09-13

### Added

- The iPhone and Android apps can download Libro.fm purchases onto the device without an OperaLibre server. ([#146](https://github.com/DonovanMontoya/OperaLibre/pull/146))
- iPhone, the Shelf, and Administration have landscape layouts. ([#143](https://github.com/DonovanMontoya/OperaLibre/pull/143))
- On iPad, the Shelf can hide so the player fills the screen, or widen to a larger grid. ([#140](https://github.com/DonovanMontoya/OperaLibre/pull/140))
- Listeners can connect a Libro.fm account, browse purchases, and import them into the server library. ([#84](https://github.com/DonovanMontoya/OperaLibre/pull/84))

### Changed

- Settings uses two columns on iPad in landscape. ([#139](https://github.com/DonovanMontoya/OperaLibre/pull/139))
- Headings sit clear of the iPad tab bar in landscape. ([#138](https://github.com/DonovanMontoya/OperaLibre/pull/138))
- On iPad in landscape, the Ledger is a compact dashboard. ([#137](https://github.com/DonovanMontoya/OperaLibre/pull/137))
- On iPad in landscape, the games sit under the thumb. ([#136](https://github.com/DonovanMontoya/OperaLibre/pull/136))

### Fixed

- Follow-along swipes match the stroke a thumb actually makes. ([#141](https://github.com/DonovanMontoya/OperaLibre/pull/141))
- iPad no longer dims the reader under a clock veil. ([#135](https://github.com/DonovanMontoya/OperaLibre/pull/135))
- iPad shelf actions wrap instead of being clipped. ([#134](https://github.com/DonovanMontoya/OperaLibre/pull/134))
- The iPad tab bar can be tapped, and it no longer covers the page. ([#133](https://github.com/DonovanMontoya/OperaLibre/pull/133))
- Turning a page by hand is not pulled back by follow-along. ([#132](https://github.com/DonovanMontoya/OperaLibre/pull/132))

## [0.3.12] - 2026-09-12

### Fixed

- A boosted book no longer loops after a pause in Safari. ([#131](https://github.com/DonovanMontoya/OperaLibre/pull/131))

## [0.3.11] - 2026-09-12

### Added

- Administration can schedule a nightly follow-along run and start one immediately. ([#128](https://github.com/DonovanMontoya/OperaLibre/pull/128))
- An administrator can upload an EPUB and attach it to a book. ([#126](https://github.com/DonovanMontoya/OperaLibre/pull/126))
- Follow-along timing can be Relaxed, Balanced, or Aggressive. The choice stays on this device. ([#121](https://github.com/DonovanMontoya/OperaLibre/pull/121))

### Changed

- Each screen's color continues into the iPhone status bar and the area around the page. ([#129](https://github.com/DonovanMontoya/OperaLibre/pull/129))
- Follow-along is offered only after the book has a forced alignment. ([#127](https://github.com/DonovanMontoya/OperaLibre/pull/127))
- The ebook reader opens and closes with a short transition on iPhone. ([#122](https://github.com/DonovanMontoya/OperaLibre/pull/122))
- Replacing a follow-along map asks you to confirm first. ([#120](https://github.com/DonovanMontoya/OperaLibre/pull/120))
- Playback controls use the same haptic tap. ([#118](https://github.com/DonovanMontoya/OperaLibre/pull/118))

### Fixed

- Rewind on iPhone uses the right position after the app returns to the foreground. ([#125](https://github.com/DonovanMontoya/OperaLibre/pull/125))
- The Reading tab stays on the book that is playing. ([#123](https://github.com/DonovanMontoya/OperaLibre/pull/123))
- The native tabs stay visible when Games is turned on or off. ([#119](https://github.com/DonovanMontoya/OperaLibre/pull/119))
- The iPad mini player fits in landscape without scrolling. ([#117](https://github.com/DonovanMontoya/OperaLibre/pull/117))
- The iPhone app reports its real version. ([#114](https://github.com/DonovanMontoya/OperaLibre/pull/114))

## [0.3.10] - 2026-09-10

### Added

- The iPhone app uses native tabs. Administration lives in Settings, and the Ledger leads with listening totals, streaks, and a habit calendar. ([#113](https://github.com/DonovanMontoya/OperaLibre/pull/113))
- Siri shortcuts can resume the audiobook. ([#110](https://github.com/DonovanMontoya/OperaLibre/pull/110))
- iPad can read an ebook as a two-page spread. ([#108](https://github.com/DonovanMontoya/OperaLibre/pull/108))
- The ebook reader keeps the screen awake while it is open. ([#104](https://github.com/DonovanMontoya/OperaLibre/pull/104))
- The Ledger works offline from saved progress on the device, and shows achievements when the server has been reached. ([#103](https://github.com/DonovanMontoya/OperaLibre/pull/103))

### Changed

- Book titles use one text style across the app. ([#109](https://github.com/DonovanMontoya/OperaLibre/pull/109))

### Fixed

- Portrait iPhone gives the game board enough room again. ([#112](https://github.com/DonovanMontoya/OperaLibre/pull/112))
- Exported cover images are not listed as extra book files. ([#111](https://github.com/DonovanMontoya/OperaLibre/pull/111))
- The follow-along activity panel no longer stutters on iPhone. ([#106](https://github.com/DonovanMontoya/OperaLibre/pull/106))
- Jellyfin playback respects what that account is allowed to download, and progress writes cannot overwrite a newer stop. ([#102](https://github.com/DonovanMontoya/OperaLibre/pull/102))
- BookPlayer can connect and read metadata through the Audiobookshelf-compatible API. ([#101](https://github.com/DonovanMontoya/OperaLibre/pull/101))

## [0.3.9] - 2026-09-08

### Added

- The Shelf can be filtered to books downloaded on this device. ([#100](https://github.com/DonovanMontoya/OperaLibre/pull/100))
- Administration has a Sync activity section for running and queued follow-along jobs. ([#98](https://github.com/DonovanMontoya/OperaLibre/pull/98))
- The Shelf has a compact density. ([#86](https://github.com/DonovanMontoya/OperaLibre/pull/86))
- The iPhone app plays audiobooks on CarPlay. ([#83](https://github.com/DonovanMontoya/OperaLibre/pull/83))

### Changed

- The library header uses the OperaLibre name. ([#99](https://github.com/DonovanMontoya/OperaLibre/pull/99))

### Fixed

- On the phone apps, disposing of one listener no longer silences another component's events. ([#95](https://github.com/DonovanMontoya/OperaLibre/pull/95))
- Sign-in tokens are generated with a library that runs on older x86 machines. ([#94](https://github.com/DonovanMontoya/OperaLibre/pull/94))
- A backup restore finishes even if the browser cancels the request. ([#92](https://github.com/DonovanMontoya/OperaLibre/pull/92))
- Saved positions are kept for tracks whose duration is unknown. ([#90](https://github.com/DonovanMontoya/OperaLibre/pull/90))
- A failed cover download does not drop audio that is already on the device. ([#89](https://github.com/DonovanMontoya/OperaLibre/pull/89))
- If preparing an update fails, the previous server is started again. ([#88](https://github.com/DonovanMontoya/OperaLibre/pull/88))
- Follow-along stays behind its experiment switch, and sentence breaks fall at sentence boundaries. ([#85](https://github.com/DonovanMontoya/OperaLibre/pull/85))

### Removed

- The reader no longer draws a separate word-by-word highlight. Follow-along marks the current sentence. ([#82](https://github.com/DonovanMontoya/OperaLibre/pull/82))

## [0.3.8] - 2026-09-06

### Added

- The reader shows follow-along progress, including the current step and an estimate of the time remaining. ([#81](https://github.com/DonovanMontoya/OperaLibre/pull/81))
- The sleep timer accepts a custom duration. ([#80](https://github.com/DonovanMontoya/OperaLibre/pull/80))

### Changed

- A managed update coordinates with systemd so the new server takes over after it is healthy. ([#77](https://github.com/DonovanMontoya/OperaLibre/pull/77))

### Fixed

- A downloaded companion opens from storage on the device. ([#79](https://github.com/DonovanMontoya/OperaLibre/pull/79))
- iPhone downloads books that include a companion file. ([#78](https://github.com/DonovanMontoya/OperaLibre/pull/78))

## [0.3.7] - 2026-09-05

### Added

- Follow-along generation is an optional add-on the owner can install, update, or remove. ([#76](https://github.com/DonovanMontoya/OperaLibre/pull/76))
- Books can have custom tags, and the Shelf can filter and sort by them. ([#74](https://github.com/DonovanMontoya/OperaLibre/pull/74))
- Companion files are classified as the book text, a picture supplement, or a loose image. Books without a sync map can follow an estimate, and the reader can jump once to the listening chapter and still return to the old page. ([#68](https://github.com/DonovanMontoya/OperaLibre/pull/68))

### Changed

- The first time you open the app on the local network, setup no longer asks for a setup token. ([#62](https://github.com/DonovanMontoya/OperaLibre/pull/62))

### Fixed

- The server reports the version of the release that is installed. ([#73](https://github.com/DonovanMontoya/OperaLibre/pull/73))

## [0.3.6] - 2026-09-03

### Fixed

- Playback, downloads, and updates recover when an operation is interrupted or the process restarts. ([#67](https://github.com/DonovanMontoya/OperaLibre/pull/67))

## [0.3.5] - 2026-08-31

### Added

- The owner can download a backup of accounts, progress, and library identity, and restore it from Administration. Audiobook files are not included. ([#59](https://github.com/DonovanMontoya/OperaLibre/pull/59))
- macOS and Linux can be installed with a one-line script. ([#56](https://github.com/DonovanMontoya/OperaLibre/pull/56))

### Changed

- A new iPhone install opens the on-device library instead of the server gate. ([#60](https://github.com/DonovanMontoya/OperaLibre/pull/60))
- Marking a book finished by hand does not record a dated completion. Listening through to the end still does. ([#58](https://github.com/DonovanMontoya/OperaLibre/pull/58))

### Fixed

- The Chapter Match board stays inside its frame. ([#63](https://github.com/DonovanMontoya/OperaLibre/pull/63))

### Removed

- Audible accounts are no longer added by pasting a browser URL into OperaLibre. Account setup for that release belonged to Libation. ([#65](https://github.com/DonovanMontoya/OperaLibre/pull/65))

## [0.3.4] - 2026-08-30

### Fixed

- BookPlayer can read items from the Audiobookshelf-compatible API. ([#55](https://github.com/DonovanMontoya/OperaLibre/pull/55))
- Games fit an iPhone in landscape. ([#54](https://github.com/DonovanMontoya/OperaLibre/pull/54))

## [0.3.3] - 2026-08-30

### Fixed

- Audiobookshelf items include the fields BookPlayer expects. ([#53](https://github.com/DonovanMontoya/OperaLibre/pull/53))

## [0.3.2] - 2026-08-30

### Added

- Scrubbing on iPhone shows the playback time under your finger. ([#48](https://github.com/DonovanMontoya/OperaLibre/pull/48))
- When sharing is on, the library bell can tell you that someone else finished a book. You can turn the announcements off. ([#25](https://github.com/DonovanMontoya/OperaLibre/pull/25))

### Fixed

- Game swipes register, and the iPad landscape layout fits. ([#51](https://github.com/DonovanMontoya/OperaLibre/pull/51))
- Putting a different book in a folder that used to hold another one no longer inherits the old progress, settings, or access. ([#50](https://github.com/DonovanMontoya/OperaLibre/pull/50))
- Returning to the app picks up a newer position from the server. ([#49](https://github.com/DonovanMontoya/OperaLibre/pull/49))
- Chapter Match accepts a swipe to swap pieces on a small phone, and a volume change made offline stays put. ([#44](https://github.com/DonovanMontoya/OperaLibre/pull/44))

## [0.3.1] - 2026-08-26

### Added

- The iPhone app can follow the system appearance, including dark mode. ([#43](https://github.com/DonovanMontoya/OperaLibre/pull/43))
- The phone apps have a Games tab with Word Grid and Chapter Match. ([#42](https://github.com/DonovanMontoya/OperaLibre/pull/42))

### Changed

- The browser tab title is OperaLibre - Audiobooks. ([#40](https://github.com/DonovanMontoya/OperaLibre/pull/40))
- Only the owner can grant permission to approve Libation downloads. ([#38](https://github.com/DonovanMontoya/OperaLibre/pull/38))

### Fixed

- On iPhone, the sleep timer follows time spent playing, including pauses that happen while the app is suspended. ([#41](https://github.com/DonovanMontoya/OperaLibre/pull/41))

## [0.3.0] - 2026-08-23

### Added

- Other apps can browse the library over OPDS, and Audiobookshelf clients can use a compatible API. ([#36](https://github.com/DonovanMontoya/OperaLibre/pull/36))
- The server keeps a listening history, records each finish, and can treat editions of the same work as one book. ([#31](https://github.com/DonovanMontoya/OperaLibre/pull/31))

### Changed

- A request that never finishes is cut off after 90 seconds. Uploads and whole-book downloads are left alone. ([#35](https://github.com/DonovanMontoya/OperaLibre/pull/35))
- Accounts, sessions, listening progress, and related server state are stored in SQLite. ([#30](https://github.com/DonovanMontoya/OperaLibre/pull/30))

### Fixed

- Book descriptions cannot reconstruct markup after they are cleaned. ([#32](https://github.com/DonovanMontoya/OperaLibre/pull/32))
- A failed listening-activity write no longer comes back as a jump in the totals, and two library refreshes cannot both pass a one-at-a-time limit. ([#29](https://github.com/DonovanMontoya/OperaLibre/pull/29))
- Listening progress and other server state are flushed to disk before a write counts as saved. ([#26](https://github.com/DonovanMontoya/OperaLibre/pull/26))

## [0.2.12] - 2026-08-19

### Added

- The Shelf can be sorted by reading progress: Reading, then Not started, then Finished. ([#24](https://github.com/DonovanMontoya/OperaLibre/pull/24))

### Fixed

- A volume boost no longer snaps back when an older library listing arrives after you changed it. ([#23](https://github.com/DonovanMontoya/OperaLibre/pull/23))

## [0.2.11] - 2026-08-18

### Added

- Each listener can set a per-book volume boost, and it follows that listener to other devices. ([#21](https://github.com/DonovanMontoya/OperaLibre/pull/21))

## [0.2.10] - 2026-08-16

### Fixed

- Cover art embedded in M4B files is extracted again. ([#19](https://github.com/DonovanMontoya/OperaLibre/pull/19))

## [0.2.9] - 2026-08-16

### Added

- The macOS app can download and install a newer web frontend, and it remembers your sign-in and shelf sort. ([#16](https://github.com/DonovanMontoya/OperaLibre/pull/16))

### Fixed

- The macOS frontend updater ignores a development build and does not keep offering an update that failed to install. ([#18](https://github.com/DonovanMontoya/OperaLibre/pull/18))
- Libation downloads accept Audible titles whose product id is an ISBN-10, not only ids that start with B. ([#17](https://github.com/DonovanMontoya/OperaLibre/pull/17))

## [0.2.8] - 2026-08-14

### Added

- Administration → Downloaded books finds MP4 and M4B files that make a player fetch the end of the file before it can start, and can rewrite them in place with ffmpeg. Audio and saved progress are left as they were. ([87af794](https://github.com/DonovanMontoya/OperaLibre/commit/87af794))
- Books imported on the device show their embedded title, author, narrator, description, cover, and chapters instead of a bare file name. ([87af794](https://github.com/DonovanMontoya/OperaLibre/commit/87af794))

### Fixed

- A missing narrator is filled in from the composer tag when it differs from the author. ([87af794](https://github.com/DonovanMontoya/OperaLibre/commit/87af794))

## [0.2.7] - 2026-08-13

### Added

- The library can be grouped by series or genre, and a started book can be reset to unplayed. ([d27959a](https://github.com/DonovanMontoya/OperaLibre/commit/d27959a))

### Changed

- On iOS, an edge swipe goes back from book details, and detail sheets stay clear of the keyboard. ([d27959a](https://github.com/DonovanMontoya/OperaLibre/commit/d27959a))

## [0.2.6] - 2026-08-13

### Added

- Libation metadata files fill in series, contributors, genres, publication details, and ASIN. ([5ab36cf](https://github.com/DonovanMontoya/OperaLibre/commit/5ab36cf))

### Fixed

- M4B downloads on iOS are more reliable and can be cancelled. ([5ab36cf](https://github.com/DonovanMontoya/OperaLibre/commit/5ab36cf))

## [0.2.5] - 2026-08-10

### Changed

- Administration shows the installed server and web app versions together, with whether an update is available. ([d8c63e3](https://github.com/DonovanMontoya/OperaLibre/commit/d8c63e3))

### Fixed

- The last Shelf row stays scrollable above the mini player when its controls wrap. ([d8c63e3](https://github.com/DonovanMontoya/OperaLibre/commit/d8c63e3))

## [0.2.4] - 2026-08-10

### Added

- Listeners on the same server can see who else is reading or has finished a book, and each listener can turn sharing off. ([059c156](https://github.com/DonovanMontoya/OperaLibre/commit/059c156))

## [0.2.3] - 2026-08-05

### Added

- On iPhone, playback pauses when headphones disconnect and resumes when a new output is ready, without losing your place. ([e0c00c2](https://github.com/DonovanMontoya/OperaLibre/commit/e0c00c2))

### Changed

- Listening totals count time actually heard, and streaks follow your local calendar day. ([e5de9d7](https://github.com/DonovanMontoya/OperaLibre/commit/e5de9d7))

### Fixed

- A stale or delayed checkpoint can no longer roll your listening position back. ([5ff82b9](https://github.com/DonovanMontoya/OperaLibre/commit/5ff82b9))
- Audible account management works again in the apps. ([1651f8e](https://github.com/DonovanMontoya/OperaLibre/commit/1651f8e))
- iPad playback controls are centered. ([0e1a6f2](https://github.com/DonovanMontoya/OperaLibre/commit/0e1a6f2))

## [0.2.2] - 2026-07-31

### Fixed

- The library, details, and player panes in the web app scroll on their own instead of moving the whole page. ([3bd1cf2](https://github.com/DonovanMontoya/OperaLibre/commit/3bd1cf2))

## [0.2.1] - 2026-07-31

### Added

- Releases include an unsigned Android app. You sign it before installing. ([#7](https://github.com/DonovanMontoya/OperaLibre/pull/7))
- More than one Audible account can be signed in, refreshed, and downloaded from through Libation. ([59929db](https://github.com/DonovanMontoya/OperaLibre/commit/59929db))

### Changed

- The web app uses the same player and mini player as the phone apps. ([a415bb8](https://github.com/DonovanMontoya/OperaLibre/commit/a415bb8))

## [0.2.0] - 2026-07-31

### Added

- Deployment profiles for local, trusted LAN or VPN, and HTTPS proxy setups, with a one-time setup token for first-run setup from another machine. ([83586ae](https://github.com/DonovanMontoya/OperaLibre/commit/83586ae))

### Changed

- Uploads, generated ZIP downloads, and simultaneous ZIP builds have limits you can configure. Existing configs get safe defaults. ([83586ae](https://github.com/DonovanMontoya/OperaLibre/commit/83586ae))

### Fixed

- Chapters, offline downloads, native setup, and account sign-up are more reliable. ([6464cf3](https://github.com/DonovanMontoya/OperaLibre/commit/6464cf3))

## [0.1.5] - 2026-07-25

### Fixed

- Library rescans skip unchanged files and keep going past unreadable audio files. ([a19ba9f](https://github.com/DonovanMontoya/OperaLibre/commit/a19ba9f))
- Update checks pick the right package, server-only updates refresh the launcher, and a combined install refuses a frontend-only update. ([3a3c37e](https://github.com/DonovanMontoya/OperaLibre/commit/3a3c37e))
- Marking a book finished is kept separate from starting it over. ([9807945](https://github.com/DonovanMontoya/OperaLibre/commit/9807945))

## [0.1.4] - 2026-07-24

### Fixed

- A delayed update from one device can no longer roll back newer progress from another, including around seeks, track changes, and reconnects. ([fa13f3e](https://github.com/DonovanMontoya/OperaLibre/commit/fa13f3e))

## [0.1.3] - 2026-07-23

### Changed

- Playback speed holds more reliably, and the native player's controls and layout are cleaner. ([5f7a1bb](https://github.com/DonovanMontoya/OperaLibre/commit/5f7a1bb))

### Fixed

- Native playback recovers when the audio source, track, or app state changes, without overwriting newer progress. ([5f7a1bb](https://github.com/DonovanMontoya/OperaLibre/commit/5f7a1bb))

## [0.1.2] - 2026-07-21

### Added

- Release installs can download and apply verified updates, managed by the owner from Administration. ([b97f6fb](https://github.com/DonovanMontoya/OperaLibre/commit/b97f6fb))
- The iPhone app plays audio natively and downloads books in the background, and Android downloads books in the background for offline listening. ([b97f6fb](https://github.com/DonovanMontoya/OperaLibre/commit/b97f6fb))

## [0.1.1] - 2026-07-20

### Added

- An Android app. ([6a52337](https://github.com/DonovanMontoya/OperaLibre/commit/6a52337))
- The phone apps can play without a server: the demo, a library on the device, and downloaded books. ([b5a0587](https://github.com/DonovanMontoya/OperaLibre/commit/b5a0587))
- The owner approves Libation downloads before they run. ([e2f0a3e](https://github.com/DonovanMontoya/OperaLibre/commit/e2f0a3e))
- A privacy policy for the apps. ([3ab3345](https://github.com/DonovanMontoya/OperaLibre/commit/3ab3345))

### Changed

- Libation refresh and download actions are clearer, and Libation jobs recover from more failures. ([e4c3ea7](https://github.com/DonovanMontoya/OperaLibre/commit/e4c3ea7), [c2ff59e](https://github.com/DonovanMontoya/OperaLibre/commit/c2ff59e))

## [0.1.0] - 2026-07-17

First tagged release: a private audiobook server with a web app, an iPhone app, and a macOS app.

### Added

- Scan a folder of audiobooks, stream them, and save listening progress.
- Read companion EPUBs, including sentence-level follow-along when a sync map is present.
- Connect to a Jellyfin server, or import Audible titles through Libation.
- Playback speed, a sleep timer, chapters, cover art, and metadata editing.
- Packaged builds for Windows, Linux, and macOS, with a launcher that starts the server without a terminal window.

[Unreleased]: https://github.com/DonovanMontoya/OperaLibre/compare/0.5.5...HEAD
[0.5.5]: https://github.com/DonovanMontoya/OperaLibre/compare/0.5.4...0.5.5
[0.5.4]: https://github.com/DonovanMontoya/OperaLibre/compare/0.5.3...0.5.4
[0.5.3]: https://github.com/DonovanMontoya/OperaLibre/compare/0.5.2...0.5.3
[0.5.2]: https://github.com/DonovanMontoya/OperaLibre/compare/0.5.1...0.5.2
[0.5.1]: https://github.com/DonovanMontoya/OperaLibre/compare/0.5.0...0.5.1
[0.5.0]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.17...0.5.0
[0.4.17]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.16...0.4.17
[0.4.16]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.15...0.4.16
[0.4.15]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.14...0.4.15
[0.4.14]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.13...0.4.14
[0.4.13]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.12...0.4.13
[0.4.12]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.11...0.4.12
[0.4.11]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.10...0.4.11
[0.4.10]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.9...0.4.10
[0.4.9]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.8...0.4.9
[0.4.8]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.7...0.4.8
[0.4.7]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.6...0.4.7
[0.4.6]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.5...0.4.6
[0.4.5]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.4...0.4.5
[0.4.4]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.3...0.4.4
[0.4.3]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.2...0.4.3
[0.4.2]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.1...0.4.2
[0.4.1]: https://github.com/DonovanMontoya/OperaLibre/compare/0.4.0...0.4.1
[0.4.0]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.12...0.4.0
[0.3.12]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.11...0.3.12
[0.3.11]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.10...0.3.11
[0.3.10]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.9...0.3.10
[0.3.9]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.8...0.3.9
[0.3.8]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.7...0.3.8
[0.3.7]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.6...0.3.7
[0.3.6]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.5...0.3.6
[0.3.5]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.4...0.3.5
[0.3.4]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.3...0.3.4
[0.3.3]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.2...0.3.3
[0.3.2]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.1...0.3.2
[0.3.1]: https://github.com/DonovanMontoya/OperaLibre/compare/0.3.0...0.3.1
[0.3.0]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.12...0.3.0
[0.2.12]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.11...0.2.12
[0.2.11]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.10...0.2.11
[0.2.10]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.9...0.2.10
[0.2.9]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.8...0.2.9
[0.2.8]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.7...0.2.8
[0.2.7]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.6...0.2.7
[0.2.6]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.5...0.2.6
[0.2.5]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.4...0.2.5
[0.2.4]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.3...0.2.4
[0.2.3]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.2...0.2.3
[0.2.2]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.1...0.2.2
[0.2.1]: https://github.com/DonovanMontoya/OperaLibre/compare/0.2.0...0.2.1
[0.2.0]: https://github.com/DonovanMontoya/OperaLibre/compare/0.1.5...0.2.0
[0.1.5]: https://github.com/DonovanMontoya/OperaLibre/compare/0.1.4...0.1.5
[0.1.4]: https://github.com/DonovanMontoya/OperaLibre/compare/0.1.3...0.1.4
[0.1.3]: https://github.com/DonovanMontoya/OperaLibre/compare/0.1.2...0.1.3
[0.1.2]: https://github.com/DonovanMontoya/OperaLibre/compare/0.1.1...0.1.2
[0.1.1]: https://github.com/DonovanMontoya/OperaLibre/compare/v0.1.0...0.1.1
[0.1.0]: https://github.com/DonovanMontoya/OperaLibre/releases/tag/v0.1.0
