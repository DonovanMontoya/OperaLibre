# 0024. Require speech evidence for read-along timing

Status: Accepted.

## Context

Forced alignment will distribute text across audio even when the narrator omitted or added words or the recognizer stopped hearing speech. Plausible-looking timing can then move the reader to the wrong paragraph.

## Decision

- Use bounded recognition windows and align only the slices supported by unique text matches. Normalize recognition and transcript tokens before matching. Use an increasing chain of unique phrases and cut at the last supported sentence boundary. Look for an opening match before the first long anchor because recognition can misspell the opening words. Compare recognitions by shared phrases and retry smaller windows if speech repeats or leaves a substantial unexplained gap.
- Give spoken titles and image descriptions room in the aligner input without attaching them to visible prose. Require unique opening or enclosing phrases. At an actual scope end, a trailing description can use the last anchor without a following one. Check for duplicate scripted speech that the recognizer tokenized differently before treating it as new narration. Ignore layout or contents labels alone as evidence of speech.
- Infer an edition omission only between supported nearby phrases that leave too little audio to contain the omitted whole sentences. Keep edits within the document and preserve original offsets. A clock stretched across silence cannot establish such an omission. Local lexical matches can veto removing heard text but supply no timing. Recover the opening of a missed passage by recognizing the span alone and rebasing its clocks.
- Repair a late opening or local drift only with nearby unique speech and valid clocks. Keep onsets ordered against both adjusted and original neighbors. Recheck after rejecting a proposal that creates another overlap. Shorten a word at the next confirmed onset as needed. Recover a collapsed single-word timing only with nearby unique support.
- To resume after alignment loss, search forward for a complete sentence and include consumed text when testing uniqueness. Reject a match that would justify a large unsupported prefix. A stretched first clock can identify a small retry window but cannot supply the resulting time. Treat these boundaries as inputs to fresh forced alignment. Preserve unmapped spans if evidence remains insufficient.

## Consequences

Repeated phrases and uncertain clocks can leave gaps. The reader keeps its last supported position until an independently aligned passage resumes.

See [alignment.rs](../../apps/server/src/alignment.rs) and [EPUB mapping](0023-map-readalong-to-the-original-epub.md).
