# 0009. Group editions without sharing playback position

Status: Accepted.

## Context

Two recordings of the same work can belong together in reading history. A time or track offset remains specific to one recording.

## Decision

- Resolve work identity after the edition scan. Keep the work index for history and keep playback keyed by edition. Preserve old edition links after the media is removed so a replacement copy can inherit history.
- Honor an existing link before evaluating new evidence, and apply administrator links and permanent exclusions. A rejected link detaches the edition from that work. Otherwise try ASIN, ISBN, then normalized title and author with compatible duration. Include the author in the key to distinguish common titles and retain alternate spellings that later editions add.
- Use the longest matched runtime as the comparison point. If duration is missing or differs enough to suggest an abridgement or other edition, keep the edition separate and offer the match for review. Rebuild suggestions as books come and go. Keep the first edition's display title and author so a later badly tagged copy cannot rename the work.
- Resolve history through the current edition-to-work link. An administrator can merge or separate the histories of recordings that already have events without rewriting historical rows.

## Consequences

Work links can change retrospectively in reading history. The listener's position follows the edition's track layout. An uncertain match costs an extra history entry pending review and preserves the option to join it later.

See [works.rs](../../apps/server/src/works.rs) and [library.rs](../../apps/server/src/library.rs).
