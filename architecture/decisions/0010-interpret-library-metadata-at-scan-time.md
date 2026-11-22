# 0010. Interpret library metadata at scan time

Status: Accepted.

## Context

Book metadata can come from audio tags, download metadata, adjacent documents, or explicit edits. The server also reads media and sidecars supplied by the library owner.

## Decision

- Use audio tags for a single-file title and the folder name for a grouped book. A Libation sidecar supplies the Audible record for the download, and user edits take precedence. Read the composer as narrator only when another tag supplied the author. Validate ISBN-10-shaped values in explicit Audible ID fields. In free text, require the Audible ASIN shape to avoid interpreting unrelated numbers as product IDs.
- Keep custom collection order independent of formal series order. Treat new metadata fields as optional for older clients so they can edit existing fields without clearing newer ones.
- Prefer an explicit reading-copy pairing even when the filename matcher cannot identify it. For files in a shared root, enumerate the trusted directory and compare names. Folder books can fall back to the first adjacent candidate because the folder represents one book. Cache companion-document classification across scans and prioritize the designated primary EPUB among supplements.
- Prefer a user sync-map sidecar before a generated map, and make a replacement take effect even when an older generated map was copied to the sidecar location. Recognize the full multi-part suffix without splitting a UTF-8 character. Probe metadata without loading all fragments. Serve files relative to configured roots and validate path components before joining them.
- Ignore hidden and bookkeeping files, including remux working files that carry the audio extension. Treat an unknown track duration as unknown when building whole-book offsets. Match analysis to the current content fingerprint before applying it.
- Give media tools an explicit set of allowed input protocols before they open each track. The scan's filename extension does not determine the demuxer. Serve cover responses with an image content type so a tag cannot choose an executable document type for that route.

## Consequences

Explicit edits and pairings remain authoritative, and the scan can cache expensive document and media reads without treating unverified metadata as a file location.

See [library.rs](../../apps/server/src/library.rs) and [API documentation](../../docs/api.md).
