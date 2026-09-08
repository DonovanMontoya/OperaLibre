import { useEffect, useState } from "react";
import { listJobs } from "./api";
import { jobElapsedMinutes } from "./jobTiming";
import type { Book, JobStatus } from "./types";

function jobOrder(job: JobStatus) {
  return job.status === "running" ? 0 : job.status === "queued" ? 1 : 2;
}

export function SyncJobMonitor({ books, onOpenBook }: {
  books: Book[];
  onOpenBook?: (bookId: string) => void;
}) {
  const [jobs, setJobs] = useState<JobStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function refresh() {
      try {
        const next = await listJobs("sync-generate");
        if (cancelled) return;
        setJobs(next.filter((job) => job.kind === "sync-generate").sort((a, b) =>
          jobOrder(a) - jobOrder(b)
          || (jobOrder(a) === 2 ? Number(b.startedAt) - Number(a.startedAt) : Number(a.startedAt) - Number(b.startedAt))
        ));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not refresh sync jobs.");
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void refresh(), 2000);
      }
    }
    void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  const running = jobs?.filter((job) => job.status === "running").length ?? 0;
  const queued = jobs?.filter((job) => job.status === "queued").length ?? 0;
  const booksById = new Map(books.map((book) => [book.id, book]));

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
          const fraction = job.progress?.fraction;
          const percent = typeof fraction === "number" && Number.isFinite(fraction)
            ? Math.round(Math.max(0, Math.min(1, fraction)) * 100) : null;
          const elapsed = jobElapsedMinutes(job, Date.now());
          return (
            <article className="admin-sync-job" key={job.id}>
              <div className="admin-sync-job-heading">
                {book && onOpenBook ? <button className="quiet-button" type="button" onClick={() => onOpenBook(book.id)}>{title}</button> : <strong>{title}</strong>}
                <span className="admin-sync-job-state">{job.status === "running" ? "Running" : job.status === "queued" ? "Queued" : job.status === "completed" ? "Completed" : job.status === "failed" ? "Failed" : job.status}</span>
              </div>
              {job.status === "running" ? <>
                <p>{job.progress?.step ?? "Aligning the narration to the text"}{percent !== null ? ` · ${percent}%` : ""}{elapsed !== null ? ` · ${elapsed < 1 ? "Less than a minute" : `${elapsed} min`} elapsed` : ""}</p>
                <progress aria-label={`Sync progress for ${title}`} max={100} value={percent ?? undefined} />
              </> : job.status === "queued" ? <p>Waiting for another sync to finish.</p> : null}
              {job.status === "failed" ? <p className="admin-sync-job-error">{job.error ?? "Sync generation failed."}</p> : null}
              {job.finishedAt && Number(job.finishedAt) > 0 ? <p className="admin-experiment-detail">Finished {new Date(Number(job.finishedAt)).toLocaleString()}</p> : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
