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

/** Groups the shelf by status; callers break the tie themselves, as with every other sort. */
export function compareReadingStatus(a: Pick<Book, "progress">, b: Pick<Book, "progress">) {
  return readingStatusRank(readingStatus(a)) - readingStatusRank(readingStatus(b));
}
