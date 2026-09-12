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

export type PageGesture = "next" | "prev" | "tap" | null;

// A thumb holding the device sweeps in an arc, so a turn is judged by which
// way the finger mostly travelled rather than by staying inside a straight
// band. A short, quick flick counts too; a slow short drift does not.
const TAP_SLOP_PX = 12;
const TAP_MAX_MS = 600;
const TURN_DISTANCE_PX = 36;
const FLICK_DISTANCE_PX = 18;
const FLICK_SPEED_PX_PER_MS = 0.35;
const HORIZONTAL_RATIO = 1.15;

/** What a finger that went down and came up on the page asked for. */
export function classifyPageGesture(deltaX: number, deltaY: number, durationMs: number): PageGesture {
  const across = Math.abs(deltaX);
  const down = Math.abs(deltaY);
  if (across <= TAP_SLOP_PX && down <= TAP_SLOP_PX) {
    return durationMs <= TAP_MAX_MS ? "tap" : null;
  }
  if (across < down * HORIZONTAL_RATIO) {
    return null;
  }
  const flick = across >= FLICK_DISTANCE_PX && across / Math.max(durationMs, 1) >= FLICK_SPEED_PX_PER_MS;
  if (across < TURN_DISTANCE_PX && !flick) {
    return null;
  }
  // Pages sit side by side: dragging the page leftward brings the next one in.
  return deltaX < 0 ? "next" : "prev";
}
