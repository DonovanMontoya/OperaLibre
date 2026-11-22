# 0025. Match chapter labels in playback order

Status: Accepted.

## Context

Audiobook tracks, embedded chapters, and EPUB contents can use different label formats or cover different sections of a work.

## Decision

- Score chapter numbers and titles, then choose the best in-order pairing. Use separate number series for parts, interludes, and main chapters. Normalize explicit prefixes, decimal, Roman, and spelled-out numbers. Require proper token boundaries and canonical Roman spelling. Chapter zero is a valid number and integer overflow is not. Prefer the full form of a compound number.
- Fold matches to multiple contents anchors in one spine document into the same document. Retain full audio intervals for matched embedded chapters. Combine only explicit consecutive lettered parts of one numbered chapter where the EPUB has an unsplit label. Leave unmatched tracks out of the map unless no common chapters remain at all.
- Use a unique heading or image-only section between confirmed neighbors when the contents omits it. Recover illustrations displaced in the NCX order using their spine position. Keep a heading and its trailing figures together when supported by the narration. Stop at the next TOC entry after the last matched chapter so unrelated back matter does not stretch its timing.
- Treat credits, title pages, and other apparatus separately from main prose. An uncertain interior region can use one shared scope bounded by reliable chapter resets. The recognition evidence then determines sentence timing inside that scope.

## Consequences

Repeated names can match their correct occurrence. An uncertain interior heading can keep its place in the surrounding scope without supplying a guessed timestamp.

See [alignment.rs](../../apps/server/src/alignment.rs) and [speech evidence](0024-require-speech-evidence-for-readalong-timing.md).
