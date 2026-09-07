import type { Book } from "./types";

/**
 * Where a book sits for the viewer. The three values mirror the server's
 * `BookProgressStatus`, which already folds an explicit "mark finished" choice
 * into the status it reports, so the shelf never has to consult
 * `finishedOverride` itself. Jellyfin reports the same vocabulary, and a book
 * with no progress record at all has simply never been opened.
 */
export type ReadingStatus = "inProgress" | "notStarted" | "finished";

/**
 * Shelf order: what you are part-way through, then what is waiting, then what is
 * done. Finished books sink to the bottom because they are the ones you are
 * least likely to be reaching for.
 */
const READING_STATUS_ORDER: ReadingStatus[] = ["inProgress", "notStarted", "finished"];

const READING_STATUS_LABELS: Record<ReadingStatus, string> = {
  inProgress: "Reading",
  notStarted: "Not started",
  finished: "Finished"
};

/**
 * A device-only book, a backend that reports no progress, and a book the viewer
 * has never opened are all the same thing on the shelf: not started. Anything
 * unrecognised lands there too rather than inventing a fourth group.
 */
export function readingStatus(book: Pick<Book, "progress">): ReadingStatus {
  const status = book.progress?.status;
  return status === "inProgress" || status === "finished" ? status : "notStarted";
}

export function readingStatusLabel(status: ReadingStatus) {
  return READING_STATUS_LABELS[status];
}

export function readingStatusRank(status: ReadingStatus) {
  return READING_STATUS_ORDER.indexOf(status);
}

/**
 * The compact shelf's progress chip. A percentage rather than a time remaining,
 * and nothing at all for a book you have never opened: "Not started" on every
 * row is the least useful thing a dense shelf can spend its width on — it is the
 * default, and its absence says it just as well. Callers keep the full wording
 * on the chip's title/aria-label so the short form never costs a screen reader
 * anything.
 */
export function compactProgressLabel(book: Pick<Book, "progress">): string | null {
  const status = readingStatus(book);
  if (status === "notStarted") return null;
  if (status === "finished") return READING_STATUS_LABELS.finished;
  const percent = book.progress?.percentComplete;
  if (percent === null || percent === undefined) return "Started";
  return `${Math.min(100, Math.max(0, Math.round(percent)))}%`;
}

/** Groups the shelf by status; callers break the tie themselves, as with every other sort. */
export function compareReadingStatus(a: Pick<Book, "progress">, b: Pick<Book, "progress">) {
  return readingStatusRank(readingStatus(a)) - readingStatusRank(readingStatus(b));
}
