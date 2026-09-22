---
layout: default
title: iOS Release Changelog
nav_order: 12
---

# iOS release changelog

Release history for the OperaLibre iPhone and iPad app, starting with **1.1.0 (0)**.
Entries use **version (build)** and appear newest first. iOS versions are tracked
independently of the server releases.

## Unreleased

### 1.2.7 (planned)

The iPhone Duo changes are scheduled for 1.2.7. The build number and
distribution date are pending. These changes were introduced in
[#167](https://github.com/DonovanMontoya/OperaLibre/pull/167) and are excluded
from 1.2.6 (2).

- Added iPhone Duo support: the shelf, player, reader, Settings, Ledger, and
  Games adapt to folding, rotation, and the space around the hinge. Native
  playback controls fit the side rail when space is available.
  ([#167](https://github.com/DonovanMontoya/OperaLibre/pull/167))
- Reader text size is remembered separately for open and closed screens in
  portrait and landscape, with a wider adjustment range. Page-edge taps turn
  pages more reliably, and Follow Along keeps its highlight through fold
  changes without pulling manually turned pages back to the narration.
  ([#167](https://github.com/DonovanMontoya/OperaLibre/pull/167))
- Get Books has consistent grid, list, and compact views. Native book-store
  connections and download settings live in Settings, with visible refresh
  errors and continued account-management access in the browser.
  ([#167](https://github.com/DonovanMontoya/OperaLibre/pull/167))
- Improved player and reader spacing, restored shelf ordering when closing
  the device, and kept playback controls clear of navigation.
  ([#167](https://github.com/DonovanMontoya/OperaLibre/pull/167))

These changes do not require a server update.

## 1.2.6 (2)

Prepared for App Store release on September 22, 2026, using Xcode 27.0.
Version and build confirmed by the maintainer; distribution has not yet been
recorded. Release branch: `feat/release-pre-iphone-duo`. App source baseline:
[`db31b5fb`](https://github.com/DonovanMontoya/OperaLibre/commit/db31b5fb2528f2a0530bbe2d7447b59c596dd358),
immediately before the iPhone Duo merge (#167).

- Downloaded books and the cached shelf open without a server connection.
  Offline playback restores its saved position, including after reopening
  the app from a cold launch.
  ([#168](https://github.com/DonovanMontoya/OperaLibre/pull/168),
  [#169](https://github.com/DonovanMontoya/OperaLibre/pull/169))
- Streamed audiobooks start with less redundant loading. Play shows when it
  is waiting for audio, and a second tap cancels the pending start. Returning
  to the app refreshes the live playback position and adopts progress from
  another device more reliably.
  ([#156](https://github.com/DonovanMontoya/OperaLibre/pull/156),
  [#160](https://github.com/DonovanMontoya/OperaLibre/pull/160),
  [#163](https://github.com/DonovanMontoya/OperaLibre/pull/163))
- Added newest-first shelf sorting, including corrected ordering for older
  library entries when the server supplies recovered addition dates.
  ([#157](https://github.com/DonovanMontoya/OperaLibre/pull/157),
  [#161](https://github.com/DonovanMontoya/OperaLibre/pull/161),
  [#166](https://github.com/DonovanMontoya/OperaLibre/pull/166))
- EPUBs can open chapter by chapter on compatible servers. Switching reader
  focus preserves the open book, and stale Follow Along highlights are
  cleared after rotation or switching books.
  ([#156](https://github.com/DonovanMontoya/OperaLibre/pull/156),
  [#154](https://github.com/DonovanMontoya/OperaLibre/pull/154),
  [#161](https://github.com/DonovanMontoya/OperaLibre/pull/161))
- Fixed landscape text clipping on iPhone and improved the iPad mini-player
  layout.
  ([#159](https://github.com/DonovanMontoya/OperaLibre/pull/159),
  [#165](https://github.com/DonovanMontoya/OperaLibre/pull/165))
- Corrected Word Grid's accepted-word dictionary.
  ([#158](https://github.com/DonovanMontoya/OperaLibre/pull/158))

Chapter-by-chapter EPUB streaming and recovered dates for older library
entries use the matching server features; older servers retain their existing
behavior.

## 1.2.4 (18)

Distributed via App Store Connect (TestFlight) on September 14, 2026. Source
commit: `3276728b`.

- Get books now has All accounts, Libro.fm, and Audible tabs, with shared
  search and account filtering. Libro.fm supports multiple connections and
  editable nicknames, and existing single-account data remains readable.
  ([#150](https://github.com/DonovanMontoya/OperaLibre/pull/150))
- Account management and purchase refresh no longer fail together: refreshing
  one Libro.fm account's purchases no longer breaks refresh for the others.
  ([#150](https://github.com/DonovanMontoya/OperaLibre/pull/150))
- Landscape shelves keep results outside the toolbar grid, restoring
  full-width books and visible controls while respecting the iPad native tab
  bar. ([#150](https://github.com/DonovanMontoya/OperaLibre/pull/150))
- Fixed the Ledger page's colors drifting from the app's paper theme.
  ([#149](https://github.com/DonovanMontoya/OperaLibre/pull/149))
- Fixed a duplicated Follow Along highlight left behind after rotating the
  reader. ([#148](https://github.com/DonovanMontoya/OperaLibre/pull/148))

## 1.2.3 (17)

Distributed via App Store Connect (TestFlight) on September 13, 2026. Source
commit: `e2068306`.

- Connect a Libro.fm account to browse, search, and import your purchases
  straight into your OperaLibre server library.
  ([#84](https://github.com/DonovanMontoya/OperaLibre/pull/84))
- Libro.fm purchases can now download directly to this device on iOS and
  Android, with no OperaLibre server required.
  ([#146](https://github.com/DonovanMontoya/OperaLibre/pull/146))
- Libro.fm purchases can be browsed as a cover grid (the new default) or a
  list, with a compact header shared with the Audible import flow.
  ([#146](https://github.com/DonovanMontoya/OperaLibre/pull/146))
- Fixed several Libro.fm import edge cases: numeric ISBNs, native response
  decoding, and rejected catalog fields are now handled correctly, and
  finished on-device download jobs are cleaned up automatically.
  ([#146](https://github.com/DonovanMontoya/OperaLibre/pull/146))

## 1.2.2 (16)

Distributed via App Store Connect (TestFlight) on September 12, 2026. Source
commit: `aad9110`.

- Follow Along can now use an uploaded matching EPUB, with a confirmation before
  a potentially time-consuming re-sync. Narration timing can also be tuned to
  match your listening preference. ([#126](https://github.com/DonovanMontoya/OperaLibre/pull/126),
  [#121](https://github.com/DonovanMontoya/OperaLibre/pull/121),
  [#120](https://github.com/DonovanMontoya/OperaLibre/pull/120))
- The reader opens and closes more smoothly, stays focused on the audiobook
  that is playing, and keeps the native tab bar visible while using games.
  ([#123](https://github.com/DonovanMontoya/OperaLibre/pull/123),
  [#122](https://github.com/DonovanMontoya/OperaLibre/pull/122),
  [#119](https://github.com/DonovanMontoya/OperaLibre/pull/119))
- Playback controls now give consistent haptic feedback, and the iPad mini
  landscape player fits without requiring a scroll.
  ([#118](https://github.com/DonovanMontoya/OperaLibre/pull/118),
  [#117](https://github.com/DonovanMontoya/OperaLibre/pull/117))
- Improved recovery when returning to the iOS app so native playback progress
  stays aligned after foregrounding. ([#125](https://github.com/DonovanMontoya/OperaLibre/pull/125))
- Each iOS section now carries its own color through the native app shell.
  ([#129](https://github.com/DonovanMontoya/OperaLibre/pull/129))
- iPhone landscape now gets the same treatments as iPad: Games puts the board
  against the right edge with the picker and now-playing strip alongside,
  the Ledger sets totals beside the listening calendar, and Settings cards
  flow into two columns. ([#143](https://github.com/DonovanMontoya/OperaLibre/pull/143))
- The landscape shelf reads as a book wall: a folded two-line toolbar, tighter
  covers set three across with a two-line title, and reading state (a gold
  progress rule or a finished ribbon) moves onto the cover itself.
  ([#143](https://github.com/DonovanMontoya/OperaLibre/pull/143))
- Landscape administration keeps the section list in a fixed column beside
  the scrolling content. ([#143](https://github.com/DonovanMontoya/OperaLibre/pull/143))
- The iPad shelf can now be hidden, so the player takes the full screen, or
  widened to a larger grid without losing your saved view.
  ([#140](https://github.com/DonovanMontoya/OperaLibre/pull/140))
- Settings cards on iPad landscape flow into two balanced columns.
  ([#139](https://github.com/DonovanMontoya/OperaLibre/pull/139))
- Fixed Follow Along dropping arcing or quick-flick page swipes; a sideways
  swipe or flick now reliably turns the page.
  ([#141](https://github.com/DonovanMontoya/OperaLibre/pull/141))
- Fixed Follow Along snapping a hand-turned page back to the narrated page a
  moment later. ([#132](https://github.com/DonovanMontoya/OperaLibre/pull/132))

## 1.2.0 (15)

Distributed via App Store Connect (TestFlight) on September 10, 2026. Source
commit: `ea152c2`.

- CarPlay audio is now signed with the granted `com.apple.developer.carplay-audio`
  entitlement; this is the first archive built with it included, rather than
  omitted for lack of a matching provisioning profile.
- Replaced the web tab strip with native iOS tab bar navigation; iPad now
  combines Shelf and Reading into one destination so every section fits
  without a "More" tab, and administration moved into Settings.
- Added Siri Shortcuts to resume the current audiobook by voice.
- Native audiobook access (CarPlay and offline playback) is now invalidated
  immediately on sign-out, so a session can no longer keep playing after
  leaving the account.
- Fixed the Sync activity panel stuttering during long library scans.
- Fixed inconsistent book title styling across screens.
- Fixed cramped spacing in the reading game board on portrait iPhone.

## 1.1.0 (0)

Tracking started: September 8, 2026.

- Starting baseline for the iOS changelog. Earlier releases have not been
  reconstructed, and existing features are not listed as new in this version.

## Maintaining this changelog

1. Add a short, user-facing note under **Unreleased** when a change affects the
   shipped iOS app, including changes to its bundled web interface. Link the
   relevant pull request or commit so the note can be checked later.
2. When distributing a build through TestFlight or the App Store, move only the
   notes included in that build into a new **version (build)** entry. Record its
   distribution date, channel, and source commit. Keep a separate entry for each
   distributed build, even when the version stays the same.
3. Use those notes for TestFlight's “What to Test” or the App Store's “What's New”.
   Keep **Unreleased** at the top for the next build, and preserve previous entries.

The initial version and build above were supplied when tracking began; its
distribution date, channel, and archived source commit have not been recorded.
For future entries, verify the version and build against the distributed archive.
