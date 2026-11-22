# 0026. Checkpoint read-along jobs before handoff

Status: Accepted.

## Context

Aligning an audiobook can take hours. Pausing, restarting, or updating the server must preserve the queue and finished sections. The server must still start when an older build cannot read a newer queue.

## Decision

- Keep queue rank separate from creation time so reordering does not affect elapsed time or history. Until a job is ranked explicitly, use creation order. Keep the latest completed result for a book while active and unrelated jobs run.
- Persist a queue update under the job table lock. Publish a sweep as one snapshot before scheduling workers. An update can delay dispatch, but its saved queue must still contain the accepted jobs. Defer recovery when the alignment runtime is unavailable. Keep unreadable queue files aside and start the listening server with an empty active queue.
- Persist completed sections under the existing job ID. Checkpoint identity includes input file metadata, settings, mapping code, and scope layout. Changed inputs or an unreadable checkpoint require a new run. Checkpoint invalidation can be stricter than the revision required to replace published maps.
- Exclude new workers before updating. Signal running and waiting workers and wait for them to release their guards. Finish a checkpoint write before interrupting expensive work. Stop the aligner child when its task is dropped. Keep manually paused jobs paused and preserve the signal until an interrupted handoff has quiesced. Release only the stop signal owned by that update.
- Resume from the last durable section. Recover a job whose map already published by letting the scan find the map. A queued whole-book run covers chapter requests, while a narrower in-flight run cannot cover a wider one. Validate chapter indices and map provenance at admission and again on execution after recovery.

## Consequences

A restart can repeat unfinished work while retaining completed alignment. Queue or runtime problems do not stop playback and progress sync.

See [sync.rs](../../apps/server/src/sync.rs) and [managed update trials](0015-start-managed-updates-as-trials.md).
