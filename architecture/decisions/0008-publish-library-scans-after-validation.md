# 0008. Publish library scans after validation

Status: Accepted.

## Context

A traversal failure or unstable mount can look like a large deletion. While a scan runs, readers may still stream media and administrators may change metadata.

## Decision

- Keep the last successful root manifest as the comparison baseline. Seed it during legacy migration. Withhold a scan with traversal errors or a substantial unconfirmed shrink. Accept a repeated shrink after three consecutive successful observations of the same book locations. Count and location digest distinguish stable losses from a flapping mount. A differing observation starts a new confirmation and a traversal failure breaks it. Record withheld shrink observations without publishing a catalogue or changing identities.
- Keep scan activity, catalogue availability, and failure as separate states. Until a scan publishes a catalogue, send library listings a retryable unavailable response. An empty successful listing could overwrite an offline shelf. Known per-book endpoints can continue to use the available state. Keep unpaged responses available for clients that omit pagination.
- Hold the rescan lock through publication. Persist identity changes before the works store or catalogue can refer to new IDs. Another scan after a failed identity write could mint different IDs. Run synchronous fingerprinting, identity resolution, sidecar inspection, and cover I/O off the async worker. Share directory listings for root-level books so each book does not scan the same directory again.
- Keep only cover metadata during the initial scan and fetch one selected picture per book. Process tag reads within the shared memory budget. Cover misses can run across the pool. Reuse a published length and digest match, otherwise check the cache content. Preserve embedded cover metadata when an override is active. Replace changed cover files atomically and remove obsolete files only after the new catalogue no longer references them. If a picture disappears between the scan and readback, the route can return 404 until the catalogue refreshes.
- Prepare covers before taking the library write lock so reads and streams can continue. Re-read metadata overrides under that lock so an edit that arrived during a scan also applies to the new catalogue.

## Consequences

A transient mount failure can leave the previous catalogue in place, and a stable loss eventually becomes visible. Cover and metadata preparation happens outside the publication lock. The server cannot publish references to newly assigned IDs until those IDs survive a restart.

See [library.rs](../../apps/server/src/library.rs).
