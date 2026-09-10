import { useEffect, useMemo, useState } from "react";
import { listJobs } from "./api";
import { jobElapsedMinutes } from "./jobTiming";
import {
  syncFeedChanged,
  syncJobPercent,
  syncJobPollDelay,
  sortSyncJobs
} from "./syncJobFeed";
import type { Book, JobStatus } from "./types";

type Feed = { jobs: JobStatus[]; now: number };

function statusLabel(status: string) {
  switch (status) {
    case "running": return "Running";
    case "queued": return "Queued";
    case "completed": return "Completed";
    case "failed": return "Failed";
    default: return status;
  }
}

export function SyncJobMonitor({ books, onOpenBook }: {
  books: Book[];
  onOpenBook?: (bookId: string) => void;
}) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    // The last list this effect saw, so a repeat poll can be dropped without
    // reading it back out of React state.
    let seen: Feed | null = null;
    let inFlight = false;

    function schedule(delay: number) {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), delay);
    }

    async function refresh() {
      // A backgrounded panel has nobody to inform. Polling it only burns a
      // request and a render, and on iOS the queued-up work lands in a burst
      // the moment the app comes forward.
      if (document.visibilityState === "hidden" || inFlight) return;
      inFlight = true;
      try {
        const received = await listJobs("sync-generate");
        if (cancelled) return;
        const next = sortSyncJobs(received.filter((job) => job.kind === "sync-generate"));
        const now = Date.now();
        if (syncFeedChanged(seen, next, now)) {
          seen = { jobs: next, now };
          setFeed(seen);
        }
        setError(null);
        schedule(syncJobPollDelay(next));
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not refresh sync jobs.");
        schedule(syncJobPollDelay(seen?.jobs ?? null));
      } finally {
        inFlight = false;
      }
    }

    // Coming back to the panel should show the current state at once rather
    // than after the next tick of whatever cadence was running.
    function wake() {
      if (document.visibilityState !== "hidden") schedule(0);
    }

    void refresh();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, []);

  const jobs = feed?.jobs ?? null;
  const running = jobs?.filter((job) => job.status === "running").length ?? 0;
  const queued = jobs?.filter((job) => job.status === "queued").length ?? 0;
  const booksById = useMemo(() => new Map(books.map((book) => [book.id, book])), [books]);

  return (
    <div className="admin-sync-monitor">
      <p role="status">{jobs ? `${running} running · ${queued} queued` : error ? "Sync jobs unavailable" : "Loading sync jobs…"}</p>
      <p className="admin-experiment-detail">Books run one at a time. This view refreshes automatically; closing it does not stop jobs. Recent results are temporary and clear when the server restarts.</p>
      {error ? <p role="alert">{error} {jobs ? "Showing the last received status. " : ""}Retrying automatically…</p> : null}
      {jobs?.length === 0 ? <p>No sync jobs to show. Use Improve sync in a book’s reader to add it to the queue.</p> : null}
      <div className="admin-sync-jobs">
        {jobs?.map((job) => {
          const book = job.targetId ? booksById.get(job.targetId) : undefined;
          const title = book?.title ?? (job.targetId ? `Unavailable book (${job.targetId})` : "Unknown book");
          const percent = syncJobPercent(job);
          const elapsed = jobElapsedMinutes(job, feed?.now ?? 0);
          return (
            <article className="admin-sync-job" key={job.id}>
              <div className="admin-sync-job-heading">
                {book && onOpenBook ? <button className="quiet-button" type="button" onClick={() => onOpenBook(book.id)}>{title}</button> : <strong>{title}</strong>}
                <span className="admin-sync-job-state">{statusLabel(job.status)}</span>
              </div>
              {job.status === "running" ? (
                <div className="sync-progress">
                  <div className="sync-progress-head">
                    <span className="sync-progress-step">{job.progress?.step ?? "Aligning the narration to the text"}</span>
                    {percent !== null ? <span className="sync-progress-percent">{percent}%</span> : null}
                  </div>
                  <div
                    className="sync-progress-track"
                    role="progressbar"
                    aria-label={`Sync progress for ${title}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent ?? undefined}
                    aria-valuetext={percent === null ? "Working" : `${percent}% aligned`}
                  >
                    {/* A sliding bar rather than a native indeterminate
                        <progress>: this one animates a transform the
                        compositor can carry, and it stops under reduced
                        motion. The aligner reports no fraction for minutes at
                        a time, so whatever fills this space animates for that
                        whole run. */}
                    <div
                      className={percent === null ? "sync-progress-fill waiting" : "sync-progress-fill"}
                      style={percent === null ? undefined : { width: `${percent}%` }}
                    />
                  </div>
                  {elapsed !== null ? (
                    <div className="sync-progress-note">{elapsed < 1 ? "Less than a minute" : `${elapsed} min`} elapsed</div>
                  ) : null}
                </div>
              ) : job.status === "queued" ? <p>Waiting for another sync to finish.</p> : null}
              {job.status === "failed" ? <p className="admin-sync-job-error">{job.error ?? "Sync generation failed."}</p> : null}
              {job.finishedAt && Number(job.finishedAt) > 0 ? <p className="admin-experiment-detail">Finished {new Date(Number(job.finishedAt)).toLocaleString()}</p> : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
