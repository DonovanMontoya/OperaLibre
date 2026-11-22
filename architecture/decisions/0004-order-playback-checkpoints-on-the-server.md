# 0004. Order playback checkpoints on the server

Status: Accepted.

## Context

Clients can lose a write response, record a position offline, or report an uninitialized position. Their clocks can differ from the server's. Native progress and compatibility endpoints also need to derive the same listening history from an accepted position.

## Decision

- Assign accepted writes monotonic server revisions. Accept a newer sequence in the same local recording lineage even if a response was lost. A different recording must name the current revision when it sends a base revision. An empty base means the client observed no server checkpoint. The response reports acknowledgement separately from the resulting position, since a competing write can have the same position.
- Keep legacy clients on the timestamp path when they omit a base revision. If available, use client send time to translate checkpoint age into the server's clock domain and cap the result at receive time. A missing client timestamp skips the timestamp comparison. The position guards still apply. Read both legacy second and current millisecond revisions.
- Decide whether to keep or replace a checkpoint before touching storage. Compare whole-book positions, including for migrated rows with only a track offset. Allow small backward clock drift. Require seek intent for larger regressions and backward intent for a near-zero reset after substantial progress. Keep a rollback copy for a sufficiently large accepted regression.
- Use the server's track ordering to derive whole-book position. A client offset can fill a gap only when earlier track durations are unknown. A non-positive duration is unknown and must not clamp a restored position to zero. The library can provide this position when the detailed progress fetch is unavailable.
- Explicit mark-finished and mark-unfinished requests bypass automatic write guards but still qualify for a rollback copy. A status-only native update retains the base revision so the next checkpoint from that app can save. Audiobookshelf updates advance the revision because those clients use it to select the newest copy. A deliberate restart near the beginning clears a prior finished override. Completion routes share one initializer for books with no checkpoint.
- Derive activity, listening sessions, and dated completions from accepted playback. A status-only mark does not record a completion date. A first checkpoint may be restoration and contributes no elapsed listening. An explicit seek contributes no listening time. Cap ordinary forward movement by elapsed time plus grace. Accept finite playback rates within the server's range and short printable client identifiers. Interpret time-zone offsets as minutes east of UTC, with UTC as the default.

## Consequences

Clock correction helps older clients, while revision and recording order let current clients distinguish stale writes from delayed recordings. The library can still restore a position from older data, and explicit progress edits have a recovery copy when they replace a much later position.

See [progress.rs](../../apps/server/src/progress.rs), [Audiobookshelf compatibility](../../apps/server/src/abs.rs), and [the API contract](../../docs/api.md).
