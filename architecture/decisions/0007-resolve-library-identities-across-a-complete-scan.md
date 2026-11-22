# 0007. Resolve library identities across a complete scan

Status: Accepted.

## Context

Progress, preferences, overrides, and access grants refer to the audiobook edition by book and track ID. A move or remux can change its location or bytes without replacing the recording. A different recording at an old location needs its own identity.

## Decision

- Describe the entire scan before assigning identities. In every matching pass, accept a claim only if the scanned group has one candidate and the candidate has one claimant. Use the same rule for tracks within a book. The result stays in scan input order.
- Use current digest with path first. This distinguishes byte-identical copies at different paths. Then use an unambiguous current digest alone to retain identity through a move. For historical digests, consider a path match before a digest-only match. An identity with a current digest still present in an unclaimed group is ineligible for historical matches. Already claimed groups can be ignored for this check because two copies can share a current digest.
- Use a remembered path for remux continuity only when the identity was seen recently, its digests do not place it elsewhere, and track count and known duration match. If the stored duration is known, require a duration from the scan. Track count is the available layout evidence for an identity with no recorded duration. This continuity rule assumes a trusted library writer and provides no separate authorization boundary.
- Apply a separate migration for books formerly catalogued with hidden sidecars as tracks. Require every surviving track to match at its old path and digest. Drop only ignored tracks and keep existing IDs for those that survive. For this migration, the inherited manifest can establish prior presence before the new scan counter is populated.
- Store aliases by root and path. Retain bounded recent path and digest history, renewing aliases as they reappear. Rebuild the per-root fingerprint cache from the scan and reuse a cached digest when size and modification time agree. A transient read failure can use a path stand-in for that scan. Leave stand-ins out of the cache so the next scan retries the read. Fill fingerprint samples to accommodate short reads from a mount. Fingerprint files in parallel and fold results in input order.
- Mint unused opaque IDs for unmatched books. A path-derived ID could recreate one that an earlier recording used. Preserve every issued ID during format migration, back up the old store before rewriting it, and leave a newer unreadable store intact. Migrate old aliases into the default root. A zero last-seen scan keeps legacy identities out of ordinary path-only matching until a successful scan records them.
- Store first-added time on the identity. For old records, use the earliest track's file creation time when available, or its modification time when creation time is unavailable. This keeps a later replacement track from making an old book appear new.

## Consequences

A move or compatible rewrite can preserve progress. Ambiguous matches produce fresh IDs. A legacy migration or uncertain scan can defer reuse until the server has enough evidence.

See [library.rs](../../apps/server/src/library.rs) and [work matching](0009-group-editions-without-sharing-playback-position.md).
