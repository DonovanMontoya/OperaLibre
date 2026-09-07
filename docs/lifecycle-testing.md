# Everyday lifecycle testing

Target normal use with up to six simultaneous streams. Use small, disposable libraries; this suite is not a hardware stress test or throughput benchmark.

## Automated browser checks

From the repository root:

```sh
npm ci
npx playwright install chromium
npm run test:lifecycle
```

The command builds the Rust server and production web client, then runs Chromium with one test worker. Each test creates an isolated server, database and two-book WAV library in a temporary directory, binds to loopback, and removes its fixtures afterwards. It never uses your configured library or data directory. `CARGO_TARGET_DIR` is supported.

Coverage:

- First-run owner creation, real audio playback, seek, pause and reload.
- Abrupt termination of the fixture server: saved progress, account sessions and book/track identities survive restart.
- Network loss during buffered playback: an offline pause survives closing the tab and synchronizes after reconnection.
- Signing out stops playback; another account starts with its own listening position.
- Six signed-in listeners play real audio concurrently and save independent positions, without throughput or hardware saturation targets.

Failure screenshots, traces and server logs are under `output/lifecycle`. The server unit/HTTP suite separately checks malformed backups, restore rollback and request cancellation. These browser tests check completed writes surviving process termination; they do not establish power-loss durability or recovery from termination halfway through a multi-file restore.

## Device acceptance checks

These require physical devices and are not covered by Chromium. Use disposable accounts and books, then verify both the displayed position and the server's saved position.

| Scenario | Expected result |
| --- | --- |
| Lock screen / background / foreground | Audio follows the platform's playback policy; returning does not jump backwards or start a second player. |
| Call or audio interruption; headphone disconnect | Playback pauses or ducks appropriately; resume uses the same book and position. |
| Bluetooth / CarPlay / Android Auto controls | Play, pause, seek and chapter controls affect one active player and persist progress. |
| Wi-Fi to cellular to airplane mode and back | Buffered/downloaded audio behaves predictably; reconnect preserves the newest position. |
| Close or terminate app, then relaunch | Account and downloads survive; playback resumes from the latest recoverable checkpoint. |
| Pause, resume or cancel a download; run out of storage | Incomplete downloads are not presented as playable; existing downloads and library files remain intact. |
| Switch accounts or servers | Downloads and progress remain scoped to the correct account/server. |
| Two devices use the same account | A paused device adopts newer progress without overwriting it with stale state. |
| One through six listeners, ordinary playback and seeking | Listeners retain independent progress; no runaway retries or duplicate players. |

For data recovery, test update rollback, backup export/restore, malformed input, disk-full writes and interruption during restore against disposable copies. Validate account access, book identity, bookmarks, reading history and progress after recovery; a successful HTTP response alone is insufficient.
