# 0011. Translate third-party catalogue and progress requests

Status: Accepted.

## Context

Audiobookshelf clients and OPDS readers need to browse and play the existing library. Their wire formats differ from OperaLibre's native API.

## Decision

- Mount Audiobookshelf compatibility under `/abs` so its login and account routes can coexist with the native routes. Present one virtual library with a fixed ID and keep the host filesystem layout private. Represent unsupported parts of the foreign API with empty results where appropriate. The compatibility guide lists the supported operations.
- Retain flat aliases for older clients and duplicate expanded audio file metadata at the item level for BookPlayer. Encode names that need path-safe IDs with a reserved prefix to avoid collisions. Count under the library lock and copy or enrich only the page being returned.
- Use the same login and session rules as the native API. Account information requires a bearer or cookie session. Direct play passes a read-only media credential in the URL because an external platform player may be unable to attach an authorization header. The media route serves ranges without transcoding.
- Convert Audiobookshelf's whole-book seconds or fractions into a single track and its offset. For zero or unknown duration, avoid clamping a reported position to zero. Give chapters without an end the next chapter's start or the book end, so a missing duration can still display a useful scrubber.
- Preserve Audiobookshelf's millisecond checkpoint timestamp for stale-write checks. For clients that send no seek flag, treat a bounded backward position as a possible rewind, subject to freshness and reset protection. Delegate position-bearing writes to the native progress rules. A completion-only patch keeps the prior position and advances the revision, without recording a dated completion.
- Serve an OPDS 1.2 catalogue from the existing bookshelf and use one acquisition link per track. The feed accepts bearer or read-only media authorization. Include narrator and duration in the summary because the feed has no dedicated fields. Escape only valid XML scalars and stream escaped, trimmed descriptions into the bounded catalogue spool in chunks.

## Consequences

Third-party playback shares the same position storage as native playback. Client support depends on which parts of the Audiobookshelf or OPDS API the reader uses.

See [abs.rs](../../apps/server/src/abs.rs), [opds.rs](../../apps/server/src/opds.rs), and [client compatibility](../../docs/client-compatibility.md).
