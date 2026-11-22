# 0019. Keep the native audio clock and play intent together

Status: Accepted.

## Context

AVPlayer can change tracks, lose a route, or outlive the WebView. A premature tick or a delayed callback can overwrite the listener's position or start playback after a pause.

## Decision

- Treat the restored seek target as the clock until the item has a real position. Keep a recent Play intent through track replacement and let a later Pause win. Apply the first track's resumed offset and start subsequent tracks at their normal beginning. Load startup metadata on demand so a long queue does not delay the first track. The optional packet source can supply a smaller equivalent index to native playback.
- Give every seek one readiness and cancellation path. A newer seek supersedes the older one. Retry interrupted seeks and report a failed initial resume to web audio so it can restore the same target. After an item has played, retain its real position if another seek fails. Publish successful deliberate seek intent before a state event that can save the new position. Preview playback takes a checkpoint before moving and keeps its clock out of ordinary recovery.
- Keep track identity attached to clock samples through failures and teardown. Report a failed queued item or disappearance of an interrupted initial item so the web layer can recover. During a route change, retain the last real clock until the replacement renderer adopts it. New seeks and tracks can set a new clock first.
- Expose stored checkpoints before any player is loaded. Adopt live playback across WebView reload when book, track, and media source agree. Ignore a refreshed media query token in that source comparison. Send the clock immediately after adoption because a buffering player might otherwise send no tick. Resolve file, streaming, and Capacitor file sources through one path.
- Let CarPlay observe state while JavaScript is suspended. Defer bridge events in the background and send an up-to-date clock during reactivation. Replay the pending state and seek before a deferred error because the web layer stops its native subscription when it fails over. The track ID lets it reject a tick from a replaced track.
- Activate and release the audio session on a serial queue off the main thread. Check interruption and player generations before acting on a late result. An interruption can finish while another process still holds the session, so retry within a bounded window. Cancel a superseded retry or one that outlives the background task. Keep pause or a new interruption authoritative and stay paused if activation cannot complete. Disconnecting an output pauses and saves progress before audio can move to the speaker. Rebuild on audio-service reset from the current queue item and clock, with the saved play intent.
- Preserve pitch with the spoken-audio time-pitch algorithm. Apply above-unity gain through the audio mix because player volume stops at unity. Load only the needed asset tracks and check their identity when loading completes. Prime the next item's mix after startup. Publish the real effective playing rate to Now Playing and zero while waiting or paused. Offset the native file clock against chapter markers on the whole-book clock. Bound artwork size and perform remote artwork reads off the main thread.
- Disarm the sleep timer on stop. The web layer can rearm it across deliberate reattachments. For a chapter stop, advance the boundary after seeks and marker changes. Count a boundary only during ordinary playback, including a chapter that ends at its file boundary. A gap after a marker belongs to that marker's chapter.

## Consequences

The native engine can continue while the WebView is suspended and later report the same book and clock. The app can recover from an interrupted launch or route without saving a placeholder position.

See [AudiobookPlayer](../../apps/web/ios/App/App/AudiobookPlayer.swift) and [native playback ownership](0001-native-playback-ownership-and-progress.md).
