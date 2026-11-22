# 0028. Bound read-along recognition and prefetch

Status: Accepted.

## Context

A forced aligner's working memory grows with audio length. A recognition window's ending determines the next input, but cloud requests can run in parallel when they use independent audio pieces.

## Decision

- Align short scopes at once. Cut longer scopes into bounded windows and search a limited stretch of text for unique speech. Give a closing anchor enough context before the cut. Check lookahead for omissions across the boundary. Retry a longer search once if necessary. Never advance the text cursor by an estimated pace.
- After losing alignment, scan overlapping short intervals for a complete unique sentence and align it again before closing the gap. Prefer stronger recognition for that recovery. Keep a prior usable recognition when a larger model fails. Retry local recognition with another model or shorter windows. Avoid resending the same audio to the same cloud model just to repeat a result.
- Base recognition language on the administrator's choice or the EPUB label. Normalize the code for the synthesis and recognition engines. Send an explicit language so rough text guesses do not select an unsupported voice. Choose an English-only local model for English.
- Prefetch cloud recognition as fixed pieces with limited concurrency, including across the next scope boundary. Give each piece short edge context and keep only words centered within it. Bound how much extra audio is billed and rebase piece time to the consuming window. Keep repairs separate when their scope audio differs. Skip pieces recovery passes over and release completed scopes. Stop sending new audio when the owner disables cloud recognition.
- Keep enough recognized opening words and text evidence to diagnose weak chapters. Recognize a missed opening in isolation when the original window cannot place it. Cap a closing interval at the last prose anchor when the recognizer only caught the tail of an added narration.

## Consequences

Long jobs can reconcile each window without holding an entire audiobook in the aligner. Prefetch overlaps recognition with alignment and keeps missing speech from becoming guessed timing.

See [sync.rs](../../apps/server/src/sync.rs) and [speech evidence](0024-require-speech-evidence-for-readalong-timing.md).
