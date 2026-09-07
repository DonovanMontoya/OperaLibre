import type { SyncFragment } from "./types.ts";

/** UTF-16 position to keep visible, without changing the sentence highlight. */
export function narrationTextOffset(fragment: SyncFragment, seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= fragment.startSeconds) return 0;
  const words = fragment.words?.filter(([start, end, offset, length]) =>
    Number.isFinite(start) && Number.isFinite(end) && end > start &&
    Number.isInteger(offset) && Number.isInteger(length) &&
    offset >= 0 && length > 0 && offset + length <= fragment.text.length);
  if (words?.length) {
    // Hold the preceding word through pauses; seeking backwards recomputes it.
    let offset = words[0][2];
    for (const [start, , wordOffset] of words) {
      if (start > seconds) break;
      offset = wordOffset;
    }
    return offset;
  }
  // Older and estimated maps have only sentence times. Approximate progress
  // through the text so a page break does not hide the entire continuation.
  const duration = fragment.endSeconds - fragment.startSeconds;
  if (!(duration > 0)) return 0;
  const progress = Math.max(0, Math.min(1, (seconds - fragment.startSeconds) / duration));
  const target = Math.min(fragment.text.length - 1, Math.floor(progress * fragment.text.length));
  let offset = 0;
  for (const match of fragment.text.matchAll(/\S+/gu)) {
    if (match.index > target) break;
    offset = match.index;
  }
  return offset;
}
