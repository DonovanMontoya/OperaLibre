import { formatDurationLabel } from "./formatting";
import type { Book, JobStatus } from "./types";

export function describeSyncJob({
  selectedBook,
  syncJob
}: {
  selectedBook: Book;
  syncJob: JobStatus | null;
}) {
  // Sync actions and notices, shared by the inline panel header and the
  // full-screen reader's appearance sheet.
  //
  // A job belongs to one book, so only that book's reader shows its progress;
  // the poll above keeps following it either way.
  const syncJobForBook =
    syncJob && selectedBook && syncJob.targetId === selectedBook.id ? syncJob : null;
  const syncJobRunning = !!syncJobForBook && ["queued", "running"].includes(syncJobForBook.status);
  const syncProgressPercent = (() => {
    const fraction = syncJobForBook?.progress?.fraction;
    return typeof fraction === "number" && Number.isFinite(fraction)
      ? Math.min(100, Math.max(0, Math.round(fraction * 100)))
      : null;
  })();
  const syncElapsedSeconds = (() => {
    if (syncJobForBook?.status !== "running") return null;
    const startedAt = Number(syncJobForBook.runningAt ?? syncJobForBook.startedAt);
    return Number.isFinite(startedAt) && startedAt > 0
      ? Math.max(0, (Date.now() - startedAt) / 1000)
      : null;
  })();
  // Alignment runs at a fairly steady pace, so what it has done so far
  // predicts the rest well enough to be worth saying — once there is enough of
  // both to divide by.
  const syncRemainingLabel = (() => {
    const fraction = syncJobForBook?.progress?.fraction ?? null;
    if (
      syncJobForBook?.status !== "running"
      || fraction === null
      || fraction < 0.05
      || syncElapsedSeconds === null
      || syncElapsedSeconds < 60
    ) {
      return null;
    }
    return formatDurationLabel((syncElapsedSeconds * (1 - fraction)) / fraction);
  })();
  const syncProgressNote = [
    syncElapsedSeconds !== null && syncElapsedSeconds >= 60
      ? `${formatDurationLabel(syncElapsedSeconds)} so far`
      : null,
    syncRemainingLabel ? `about ${syncRemainingLabel} left` : null,
    "keeps running if you close the reader"
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    syncJobForBook,
    syncJobRunning,
    syncProgressNote,
    syncProgressPercent
  };
}
