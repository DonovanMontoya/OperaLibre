# 0014. Restore state without reviving credentials

Status: Accepted.

## Context

Owners can export and restore OperaLibre state. A backup can outlive the server state that produced it, and a restore can race with updates, scans, and client disconnects.

## Decision

- Export account data, listening state and history, per-book settings, clips, metadata, works, Libation records, and the identity index. Keep audio, server configuration, and external Libation profiles outside the format. Permit missing fields from older backups. Omit empty clip data so old schema readers can still accept the backup.
- Include session records for format compatibility. At restore, keep only the owner session from the running server and invalidate the rest. A backup is outside the server's control and older backups can contain raw credentials. Restore the assistant-access setting and require new access tokens.
- Finish an accepted restore independently of its HTTP request. Exclude updates before the updater starts its exit deadline. Acquire the rescan lock before the state gate, matching scan order. Keep the lock through identity file replacement. A subsequent scan then reads the restored index.
- Overlay open reading sessions when exporting and when making a pre-restore safety copy. A normal export does not end the current sitting. Clear live sessions after the replacement commits.
- Validate document shapes and relational constraints before database commit. Treat Libation account IDs as directory names during validation. Commit state together and adopt the resulting cache values. Clear old checkpoint lineage on deliberate restore. If rolling back a failed replacement, restore live sessions and prior checkpoint receipts from the safety copy.
- Report successful state replacement separately from the rescan result. If the library is temporarily unavailable, retain the previous in-memory catalogue and report that a later scan is needed.

## Consequences

An owner can restore positions and accounts while old devices remain signed out. A client disconnect does not interrupt database and cache adoption, and the catalogue can recover after the media becomes available again.

See [backup.rs](../../apps/server/src/backup.rs) and [durable storage](0013-commit-durable-state-before-updating-caches.md).
