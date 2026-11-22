# 0001. Share the native playback engine and hand off progress

Status: Accepted.

## Context

iOS can start OperaLibre for CarPlay or Siri before it creates a window or a Capacitor bridge. Playback must work from that entry point, including when the phone has no network connection. Once the web player opens, its normal progress path still needs to apply the server's stale-write and reset checks.

## Decision

- The Capacitor plugin, CarPlay, and Siri share one process-wide `AudiobookPlayer`. The app declares a separate phone window scene alongside CarPlay. The phone scene loads the bridge from `Main.storyboard` and exposes its window to plugins that still use `AppDelegate.window`. CarPlay tracks its connection independently of which client started the current book. Resuming the loaded book keeps its existing owner. The coordinator queues the rest of the book so track transitions can continue without the WebView.
- The web layer writes a snapshot with the account scope, track sources, saved position, and gain. It supplies the scope prefix directly so the web and native recovery keys agree. CarPlay and Siri can open the snapshot before the WebView runs. Automatic resume requires an eligible pending session from that scope or exactly one in-progress book. An explicit request to play a finished book starts at the beginning.
- Coalesce snapshot updates from loading the library, fetching progress, and scanning downloads. Bucket progress by minute to avoid a filesystem lookup for every saved position. Resolve local track sources for downloads or imports and fall back to streaming. Exclude books with no playable source. The whole-book positions in the snapshot are built from offsets into the original track list.
- The bridge exchanges the nested snapshot and session payloads as JSON strings and decodes them as typed models. The bridge dispatches coordinator operations to the main queue. This serializes acknowledgement with session writes. The car reads playback changes directly from the engine while JavaScript can be suspended in the background.
- CarPlay and Siri leave pending progress on disk for the web player to save. The coordinator matches an engine checkpoint to the full server, account, and book scope before using it. During book switches, the old engine can still emit a checkpoint after ownership has changed. A matching checkpoint is required to keep its position out of the new book.
- The web bridge requires an explicit load position because silently starting at zero can overwrite a saved position. It queues the car handoff before loading a replacement player. After a page reload it can adopt playback when the loaded file and track match. Detaching at a track boundary retains the audio session for the next track. Events cross the bridge as strings, numbers, and booleans.
- The web player reads live state in native event handlers and fetches any missed sessions when the app returns to the foreground. If the book has yet to load, leave the record pending and retry after a library update. Unchanged positions need no progress write. After the web player claims the engine, ignore a briefly stale native ownership report while the replacement load reaches the engine.
- There is one pending checkpoint per book. The handoff store writes ordinary checkpoints less often than the engine and writes immediately on a transport change, disconnect, or ownership transfer. Within the current track, a chapter jump seeks in the existing queue. Checkpoint recording follows that seek in the engine's queue.
- A seek or restart can carry permission to pass the server's reset guard. The coordinator stamps the jump after it queues the playback operation. An acknowledgement can clear the permission only if it covers the jump. A newer checkpoint survives the acknowledgement. The store also preserves records it cannot decode so changes to the record format do not erase unsaved listening.
- Logout drops ownership before stopping playback, drains earlier snapshot writes, and invalidates the snapshot. This prevents a final checkpoint or queued write from restoring the signed-out library. Download removal keeps ownership through the final checkpoint and waits for playback to stop before the bridge permits the web layer to delete the media.
- The widget receives display data. Playback URLs and recovery records stay in the app. The stored-record readers decode and preserve unknown array entries and object values. A new valid record for an object key replaces an unreadable entry at that key.

## Consequences

Native entry points can resume from the last snapshot or native checkpoint before the web player starts. Server progress waits until the web player can submit the pending record. The snapshot and pending records are cleared with the account, and the order of queue operations is part of the progress contract.

See [#537](https://github.com/DonovanMontoya/OperaLibre/issues/537) for gaps in a native track queue and [#540](https://github.com/DonovanMontoya/OperaLibre/issues/540) for acknowledgement when durable writes fail.

See [AudiobookPlayer](../../apps/web/ios/App/App/AudiobookPlayer.swift), [CarPlayCoordinator](../../apps/web/ios/App/App/CarPlayCoordinator.swift), [CarLibrary](../../apps/web/ios/App/App/CarLibrary.swift), [CarLibraryStore](../../apps/web/ios/App/App/CarLibraryStore.swift), [CarPlayBridge](../../apps/web/ios/App/App/CarPlayBridge.swift), [NativeAudio](../../apps/web/ios/App/App/NativeAudio.swift), and [StoredRecords](../../apps/web/ios/App/App/StoredRecords.swift).

See [useCarPlay](../../apps/web/src/useCarPlay.ts) and [carLibrary](../../apps/web/src/carLibrary.ts) for the web side.
