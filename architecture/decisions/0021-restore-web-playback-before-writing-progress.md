# 0021. Restore web playback before writing progress

Status: Accepted.

## Context

The web player can open a book before its device stores and server agree on a position. A media element can report zero while metadata or a seek is still pending. Another device might have a newer position.

## Decision

- Resolve offline queue tracks individually, keeping an available local file and falling back for only a missing or unreadable one. Wait for native restore before building an initial queue from placeholder book state. A deliberate play or seek can take ownership. Carry play intent when replacing a queue and let the resolved queue own the source when ready.
- Attach the full local-first queue to AVPlayer at once. Use the queue's first source for the initial item so a separately resolved stream cannot replace a downloaded source. A fully local queue can start before authentication, while a remote fallback waits for a media credential. Skip attachment while CarPlay owns the engine.
- Restore from the best available local candidate while fetching the server copy. Read device stores concurrently and use library progress as a server fallback. Treat a near-zero checkpoint with no reset intent as suspect over substantial listed progress. Retain the pre-preview place when a clip interrupted recovery. An unchanged native acknowledgement is insufficient evidence of new listening.
- Show the restored clock and schedule the actual element seek when metadata arrives. Start a queued shelf Resume only after the target is known. A shelf restart uses the position the listener explicitly chose. Keep pause and play timing independent of whether a deliberate seek took ownership.
- When the element has already loaded the source, apply a late checkpoint and pending autoplay directly because there will be no second metadata event. Clear the startup seek before an adopted AVPlayer reports readiness. A newer lock-screen seek can change a pending target. A paused queue rebuild is insufficient evidence to override a recovered checkpoint.
- Retry a failed server read briefly using a shorter timeout than ordinary requests. Commit a new target only when the server has better evidence and the listener has not taken over. Allow React to commit the pending seek before saving again, so the previous media clock cannot win a render race. Key the restore to book identity, since progress saves replace book objects.
- Keep server revision and native recording order tied to the observation that produced them. Allow accepted writes from the same captured baseline to advance a pending recording. Do not rebase a queued seek merely because a later shelf listing arrived. Preserve a competing local edit during a save. A canonical server acknowledgement that already arrived through another replay is agreement.
- Block server writes while optimistic restore is still reconciling. Do not save a book that the listener only opened and closed. Persist a queued seek target in place of uninitialized element time, exclude preview time, and distinguish seek intent from permission to reset the book. A completion writes the final position and suppresses stale teardown saves.
- After each in-flight upload, drain the newest queued checkpoint. Heal an overruled checkpoint to the canonical response. Protect an active engine from that reposition until it can adopt the canonical copy. After foregrounding or resuming from the pop-out player, retry a server read that was held up by a draining save or an obsolete request.

## Consequences

Restore can offer local playback while the server is unreachable. An ordinary playhead update cannot claim another device's position until restoration settles and the listener acts. Recovery when persistence itself fails is tracked in [#540](https://github.com/DonovanMontoya/OperaLibre/issues/540).

See [usePlaybackRestore](../../apps/web/src/usePlaybackRestore.ts), [useProgressSync](../../apps/web/src/useProgressSync.ts), [offlinePlayback](../../apps/web/src/offlinePlayback.ts), [useAudioElement](../../apps/web/src/useAudioElement.ts), [useAudioSource](../../apps/web/src/useAudioSource.ts), and [server checkpoint ordering](0004-order-playback-checkpoints-on-the-server.md).
