import { progressTimestamp } from "./reliability.ts";
import type { FinishEvent, FinishFeed } from "./types";

export const EMPTY_FINISH_FEED: FinishFeed = { entries: [], unseenCount: 0, latestId: null };

/**
 * Which entries are new since the last poll, newest first.
 *
 * `previous` being null means this is the first feed of the session, and
 * nothing is "new": everything in it happened while the app was closed, and
 * announcing a backlog of finishes as a burst of banners is the fastest way to
 * make someone turn the feature off. The badge still shows them as unseen —
 * only the banners are held back.
 */
export function arrivedSince(
  previous: FinishFeed | null,
  next: FinishFeed
): FinishEvent[] {
  if (!previous) return [];
  const known = new Set(previous.entries.map((entry) => entry.id));
  return next.entries.filter((entry) => entry.unseen && !known.has(entry.id));
}

/** "Elena finished The Lantern Atlas" — the whole point of the feature. */
export function finishAnnouncement(entry: FinishEvent) {
  return `${entry.username} finished ${entry.bookTitle}`;
}

/**
 * One banner per poll at most.
 *
 * Several people can finish between two polls, and a stack of banners for one
 * refresh reads as a malfunction. Beyond a single extra the rest are counted
 * rather than named, which also keeps the text a sensible length.
 */
export function finishBannerText(arrivals: FinishEvent[]): string | null {
  if (arrivals.length === 0) return null;
  const [first, ...rest] = arrivals;
  if (rest.length === 0) return finishAnnouncement(first);
  if (rest.length === 1) return `${finishAnnouncement(first)}, and 1 other finish`;
  return `${finishAnnouncement(first)}, and ${rest.length} other finishes`;
}

/**
 * Relative time for the feed list. Deliberately coarse: the exact minute a
 * book was finished is never the interesting part.
 */
export function finishedAgoLabel(finishedAt: string, now: number = Date.now()): string {
  // The server stamps these as unix seconds in a string, not the RFC 3339 the
  // field name suggests, and device-side records use ISO. progressTimestamp
  // already reconciles both, and returns 0 for anything it cannot read.
  const at = progressTimestamp(finishedAt);
  if (!at) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  return `${weeks}w ago`;
}
