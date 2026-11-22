# 0013. Commit durable state before updating caches

Status: Accepted.

## Context

OperaLibre serves position and session reads frequently. Small sets are useful to keep in memory, but a rejected write, restart, or restore must leave them consistent with the durable state.

## Decision

- Store frequently queried progress as rows. Use the book key when reconstructing a position so the value cannot disagree with its key. Read the previous checkpoint, apply the decision, and commit the new copy in one transaction. Keep query text static when the callers share result traversal.
- Keep small, bounded account and session sets cached. Account writes replace the account and grant rows together. Persist the cache draft before adopting it. Use JSON documents for records whose owning handlers read and write them as a unit. Keep the account permissions version and avatars beside the rows so older releases can update accounts without removing the newer values. Treat corrupted optional artwork as absent. Fail reads of an unreadable permissions version so an upgrade does not reapply old grants.
- Index the session map by media-token digest for range requests. Serialize index rebuilding with session mutation and acquire the global state gate before the session gate. Rebuild from the committed map so entries cannot drift or publish out of order. Preserve a distinct representation for migrated sessions that have no media digest.
- Write only the changed day when adding listening time, under the cache write lock. Check the account inside the transaction because a previously admitted request can arrive after account deletion.
- Write private files to a temporary sibling, flush and sync the file, and rename it. Sync the parent and any newly created ancestor entries to persist their names. Remove the temporary file on failure. Use the same replace behavior for synchronous exports and handle existing destinations on Windows.
- Report a stable installation ID in the health route. Keep it outside the database so restoring a backup preserves the identity that clients pinned. The ID distinguishes saved installations and carries no authentication authority.
- Treat a manually chosen unity gain as a decision that overrides a suggestion. Enabling suggested gain clears the manual level and returns to the missing-row default. Turning it off retains a saved manual level. Clamp gains on reads as well as writes to cover older or hand-edited state.

## Consequences

The database can remain the source of truth while frequently used reads avoid loading entire stores. Restore can adopt committed values without issuing a second write per cache.

See [storage.rs](../../apps/server/src/storage.rs), [progress rules](0004-order-playback-checkpoints-on-the-server.md), and [backup and restore](0014-restore-state-without-reviving-credentials.md).
