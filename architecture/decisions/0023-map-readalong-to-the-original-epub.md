# 0023. Map read-along to the original EPUB

Status: Accepted.

## Context

The reader needs to connect audiobook time to text in an EPUB. Editions can differ, an illustration can have spoken words absent from its text, and older maps must stay readable.

## Decision

- Store sentence fragments with book-relative times, original OPF hrefs, and the text to locate. Version 2 adds precision and optional word timing. Version 1 remains readable and defaults to sentence precision. Keep the mapping revision separate from the schema version and raise it only when regeneration would materially improve existing maps. Treat missing revisions as zero. Represent unknown audio as a recovery gap so the reader holds its place.
- Encode word timing as a four-element array of start, end, UTF-16 offset, and UTF-16 length. The web reader uses UTF-16 and a long book can have many word entries. Search repeated words in order and omit a word with no supported location. Shift engine times by the track's offset and accept the engine's array and wrapped timeline formats. Use top-level entries when no sentence descendants exist. Read large map files outside the async worker.
- Decompress only relevant EPUB entries and bound aggregate text, per-document work, and synthetic illustration sections. Count repeated spine reads against the same budget. Preserve original hrefs for reader lookup while normalizing archive-relative entry paths for extraction. Prefer EPUB 3 navigation, supplement it with older NCX labels, and preserve chapters addressed through several anchors in the same document.
- Extract readable body text, collapse whitespace, and retain paragraph breaks. Use ASCII folding for tag scans so byte positions still address the original source. Check tag and attribute boundaries. Bound entity reads without slicing a multibyte character. Cache failed searches so malformed markup cannot repeatedly traverse the same suffix.
- Split a narrated illustration at the end of a prose document into a logical section while leaving its EPUB location intact. A later readable character rules out an earlier picture as a trailing-only candidate. The original image-only section represents its first illustration. Record section UTF-16 ranges through transcript concatenation and rebase them for each alignment slice.

## Consequences

An old or partial map can keep working, and a new map points into the edition's existing documents without rewriting them.

See [alignment.rs](../../apps/server/src/alignment.rs), [API contract](../../docs/api.md), and [read-along](../../docs/using-operalibre.md).
