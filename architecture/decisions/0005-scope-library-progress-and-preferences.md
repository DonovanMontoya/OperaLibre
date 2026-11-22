# 0005. Scope library progress and preferences to the listener

Status: Accepted.

## Context

One library serves multiple accounts. A work may also outlive a particular audiobook edition. The shelf needs to show a reader's position and completion without exposing another reader's resume point or attaching a position to a different recording.

## Decision

- Check visibility before copying book metadata. Enrich only the selected page with progress after authorization. Copy the information a database write needs out of the library before handing the write to its blocking task.
- Progress sharing is reciprocal. Return other readers' status and percentage only, and leave untouched books out of the count even if opening the page created a row. Sort finished readers first and then by how far they reached.
- Keep work completion separate from an edition's progress. An edition can inherit a finished label but receives its own track and position. Local progress and explicit completion choices take precedence. A later mark-unfinished prevents an old completion from supplying an inherited label.
- Clamp the furthest position to known book duration. Use it as ground covered because a seek changes it without contributing elapsed listening.
- Store gain and the suggested-gain preference per listener and book. Readers who can access a book can set their own gain. A manual gain takes precedence. The gain range can compensate for quiet or hot transfers. Decode missing preference fields using defaults so a missing field does not prevent the entire library from loading.

## Consequences

A reader's playback state and preferences stay with their account. A new edition can show the history of a finished work while starting with its own progress.

See [progress.rs](../../apps/server/src/progress.rs) and [the API contract](../../docs/api.md).
