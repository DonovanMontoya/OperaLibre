import { AlertTriangle, ArrowUpRight, BookOpen, Check, ChevronDown, Clock, LoaderCircle, Moon, PlayCircle, RefreshCw, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cancelBookSyncSchedule, generateSyncMap, getBooks, getSyncSweep, listJobs, listSyncSchedules, runSyncSweep, scheduleBookSync, setSyncSweep, type SyncSchedule, type SyncSweep } from "./api";
import { jobElapsedMinutes } from "./jobTiming";
import {
  syncFeedChanged,
  syncJobPercent,
  syncJobPollDelay,
  sortSyncJobs
} from "./syncJobFeed";
import type { Book, JobStatus } from "./types";

type Feed = { jobs: JobStatus[]; now: number };

/** The label and colour a job's state carries in the activity list. */
function jobState(status: string) {
  if (status === "running") return { label: "Running", tone: "running" };
  if (status === "queued") return { label: "Queued", tone: "queued" };
  if (status === "completed") return { label: "Completed", tone: "done" };
  if (status === "failed") return { label: "Failed", tone: "failed" };
  return { label: status, tone: "queued" };
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "in 7 hours" beside a scheduled start, so a date alone need not be decoded. */
function relativeTime(runAt: number, now: number) {
  const minutes = Math.round((runAt - now) / 60_000);
  if (Math.abs(minutes) < 60) return RELATIVE.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return RELATIVE.format(hours, "hour");
  return RELATIVE.format(Math.round(hours / 24), "day");
}

/** One nightly rule and one "do it now" button for the whole library. */
function SyncSweepPanel({ syncEnabled, revision, onQueued }: {
  syncEnabled: boolean;
  revision: number;
  onQueued: () => void;
}) {
  const [sweep, setSweep] = useState<SyncSweep | null>(null);
  const [time, setTime] = useState("01:00");
  const [busy, setBusy] = useState<"run" | "rule" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    // The pending count falls as the queue drains, so it is polled rather than
    // read once; the editable time is only adopted from the server on arrival,
    // never mid-edit.
    let adopted = false;
    async function refresh() {
      try {
        const next = await getSyncSweep();
        if (cancelled) return;
        setSweep(next);
        if (!adopted && next.localTime) { setTime(next.localTime); adopted = true; }
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not load the nightly sync.");
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void refresh(), 15000);
      }
    }
    void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [revision]);

  async function saveRule(enabled: boolean, atTime: string) {
    setBusy("rule");
    setError(null);
    try {
      setSweep(await setSyncSweep(
        enabled,
        atTime,
        sweep?.timeZone || localTimeZone,
      ));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the nightly sync.");
    } finally {
      setBusy(null);
    }
  }

  async function runNow() {
    setBusy("run");
    setError(null);
    setOutcome(null);
    try {
      const result = await runSyncSweep();
      setOutcome(result.queued === 0
        ? result.skipped > 0 ? "Every book that needs a sync is already in the queue." : "Nothing to sync."
        : `Queued ${result.queued} ${result.queued === 1 ? "book" : "books"}.${result.skipped ? ` ${result.skipped} already in the queue.` : ""}`);
      if (result.error) setError(result.error);
      onQueued();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start a full sync.");
    } finally {
      setBusy(null);
    }
  }

  const pending = sweep?.pendingCount ?? 0;
  return (
    <section className="admin-sync-panel admin-sync-sweep">
      <div className="admin-sync-panel-head">
        <h4>Full library sync</h4>
        <span className="admin-sync-panel-status">
          {sweep ? `${pending} of ${sweep.eligibleCount} ${sweep.eligibleCount === 1 ? "book needs" : "books need"} a sync` : "Loading…"}
        </span>
      </div>
      <div className="admin-sync-sweep-controls">
        <button
          type="button"
          className="admin-sync-sweep-run"
          disabled={!syncEnabled || busy !== null || !sweep || pending === 0}
          onClick={() => void runNow()}
        >
          {busy === "run" ? <LoaderCircle size={15} className="spin-icon" /> : <PlayCircle size={15} />}
          {busy === "run" ? "Queueing…" : pending === 0 ? "Everything is synced" : `Sync all ${pending} now`}
        </button>
        <div className="admin-sync-sweep-nightly">
          <label>
            <input
              type="checkbox"
              checked={sweep?.enabled ?? false}
              disabled={!syncEnabled || busy !== null || !sweep}
              onChange={(event) => void saveRule(event.target.checked, time)}
            />
            <Moon size={13} aria-hidden="true" />Every night at
          </label>
          <input
            type="time"
            value={time}
            aria-label="Nightly sync time"
            disabled={!syncEnabled || busy !== null || !sweep}
            onChange={(event) => {
              setTime(event.target.value);
              if (sweep?.enabled) void saveRule(true, event.target.value);
            }}
          />
          <span className="admin-sync-time-zone">{sweep?.timeZone || localTimeZone}</span>
        </div>
      </div>
      <p className="admin-experiment-detail">
        {sweep?.enabled && sweep.nextRunAt
          ? `Next sweep ${new Date(sweep.nextRunAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} · ${relativeTime(sweep.nextRunAt, Date.now())}. `
          : "A nightly sweep queues every book that still needs a sync, newly added ones included. "}
        {sweep?.lastRunAt
          ? `Last sweep ${new Date(sweep.lastRunAt).toLocaleDateString([], { dateStyle: "medium" })} queued ${sweep.lastQueued ?? 0}.`
          : "Books already synced are left alone."}
      </p>
      {outcome ? <p className="admin-sync-sweep-outcome" role="status">{outcome}</p> : null}
      {error ? <p className="admin-sync-notice admin-sync-notice-warn" role="alert"><AlertTriangle size={14} aria-hidden="true" />{error}</p> : null}
      {sweep?.lastError && !error ? <p className="admin-sync-notice admin-sync-notice-warn" role="alert"><AlertTriangle size={14} aria-hidden="true" />{sweep.lastError}</p> : null}
    </section>
  );
}

export function SyncJobMonitor({ books, onOpenBook, syncEnabled }: {
  books: Book[];
  syncEnabled: boolean;
  onOpenBook?: (bookId: string) => void;
}) {
  const [revision, setRevision] = useState(0);
  const [schedules, setSchedules] = useState<SyncSchedule[] | null>(null);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{ bookId: string; message: string } | null>(null);
  const [busyBook, setBusyBook] = useState<string | null>(null);
  const [schedulingBook, setSchedulingBook] = useState<string | null>(null);
  const [scheduledTime, setScheduledTime] = useState("");
  const [query, setQuery] = useState("");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [libraryBooks, setLibraryBooks] = useState(books);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function openSchedule(bookId: string) {
    const next = new Date();
    next.setHours(1, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
    const local = new Date(next.getTime() - next.getTimezoneOffset() * 60_000);
    setScheduledTime(local.toISOString().slice(0, 16));
    setSchedulingBook(bookId);
    setActionError(null);
  }

  async function act(bookId: string, action: "sync" | "schedule" | "cancel") {
    setBusyBook(bookId);
    setActionError(null);
    try {
      if (action === "sync") await generateSyncMap(bookId);
      else if (action === "cancel") {
        await cancelBookSyncSchedule(bookId);
        setSchedules((entries) => entries?.filter((entry) => entry.bookId !== bookId) ?? null);
      }
      else {
        const runAt = new Date(scheduledTime).getTime();
        if (!Number.isFinite(runAt) || runAt <= Date.now()) throw new Error("Choose a future date and time.");
        const saved = await scheduleBookSync(bookId, runAt);
        setSchedules((entries) => [...(entries ?? []).filter((entry) => entry.bookId !== bookId), saved]);
      }
      setSchedulingBook(null);
      setRevision((value) => value + 1);
    } catch (err) {
      setActionError({ bookId, message: err instanceof Error ? err.message : "Could not update this book’s sync." });
    } finally {
      setBusyBook(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    async function refresh() {
      try {
        const next = await listSyncSchedules();
        if (!cancelled) { setSchedules(next); setScheduleError(null); }
      } catch (err) {
        if (!cancelled) setScheduleError(err instanceof Error ? err.message : "Could not load schedules.");
      }
      try {
        const freshBooks = await getBooks();
        if (!cancelled) { setLibraryBooks(freshBooks); setLibraryError(null); }
      } catch {
        if (!cancelled) setLibraryError("Could not refresh book sync status. Showing the last received library; retrying automatically…");
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void refresh(), 15000);
      }
    }
    void refresh();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [revision]);

  useEffect(() => setLibraryBooks(books), [books]);

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
  }, [revision]);

  const jobs = feed?.jobs ?? null;
  const running = jobs?.filter((job) => job.status === "running").length ?? 0;
  const queued = jobs?.filter((job) => job.status === "queued").length ?? 0;
  const booksById = useMemo(() => new Map(libraryBooks.map((book) => [book.id, book])), [libraryBooks]);

  const isSynced = (book: Book) => book.syncFile?.source === "generated" || book.syncFile?.source === "sidecar";
  const eligibleBooks = useMemo(() => libraryBooks.filter((book) => book.source !== "device"
    && book.readingFile?.extension === "epub" && book.tracks.length > 0)
    .sort((a, b) => a.title.localeCompare(b.title)), [libraryBooks]);
  const activeJobs = new Map(jobs?.filter((job) => job.status === "running" || job.status === "queued")
    .map((job) => [job.targetId, job]));

  const needle = query.trim().toLowerCase();
  const matches = (book: Book) => !needle
    || book.title.toLowerCase().includes(needle)
    || (book.author?.toLowerCase().includes(needle) ?? false);
  const visibleBooks = eligibleBooks.filter(matches);

  const syncedTotal = eligibleBooks.filter(isSynced).length;
  const pendingSchedules = schedules?.filter((entry) => entry.status === "scheduled" || entry.status === "dispatching").length ?? 0;
  const stats: { label: string; value: string }[] = [
    { label: "Synced", value: String(syncedTotal) },
    { label: "Ready", value: String(eligibleBooks.length - syncedTotal) },
    { label: "Running", value: jobs ? String(running) : "—" },
    { label: "Queued", value: jobs ? String(queued) : "—" },
    { label: "Scheduled", value: schedules ? String(pendingSchedules) : "—" },
  ];

  return (
    <div className="admin-sync-monitor">
      <dl className="admin-sync-summary">
        {stats.map((stat) => (
          <div className="admin-sync-stat" key={stat.label}>
            <dt>{stat.label}</dt>
            <dd>{stat.value}</dd>
          </div>
        ))}
      </dl>

      {!syncEnabled ? (
        <p className="admin-sync-notice"><AlertTriangle size={14} aria-hidden="true" />Enable Follow along above to start or schedule a sync.</p>
      ) : null}
      {scheduleError ? <p className="admin-sync-notice admin-sync-notice-warn" role="alert"><AlertTriangle size={14} aria-hidden="true" />Schedules unavailable: {scheduleError} Retrying automatically…</p> : null}
      {libraryError ? <p className="admin-sync-notice admin-sync-notice-warn" role="alert"><AlertTriangle size={14} aria-hidden="true" />{libraryError}</p> : null}
      {error ? <p className="admin-sync-notice admin-sync-notice-warn" role="alert"><AlertTriangle size={14} aria-hidden="true" />{error} {jobs ? "Showing the last received status. " : ""}Retrying automatically…</p> : null}

      <SyncSweepPanel syncEnabled={syncEnabled} revision={revision} onQueued={() => setRevision((value) => value + 1)} />

      <section className="admin-sync-panel">
        <div className="admin-sync-panel-head">
          <h4>Sync activity</h4>
          <span className="admin-sync-panel-status" role="status">
            {jobs ? (running + queued > 0 ? `${running} running · ${queued} queued` : "Idle") : error ? "Unavailable" : "Loading…"}
          </span>
        </div>
        {jobs?.length === 0 ? (
          <p className="admin-sync-empty">Nothing has been synced yet. Pick a book below, or use Improve sync in a book’s reader.</p>
        ) : null}
        {jobs?.length ? <div className="admin-sync-jobs">
          {jobs.map((job) => {
            const book = job.targetId ? booksById.get(job.targetId) : undefined;
            const title = book?.title ?? (job.targetId ? `Unavailable book (${job.targetId})` : "Unknown book");
            const percent = syncJobPercent(job);
            const elapsed = jobElapsedMinutes(job, feed?.now ?? Date.now());
            const state = jobState(job.status);
            return (
              <article className={`admin-sync-job admin-sync-job-${state.tone}`} key={job.id}>
                <div className="admin-sync-job-heading">
                  {book && onOpenBook ? <button className="admin-sync-book-link" type="button" onClick={() => onOpenBook(book.id)}>{title}<ArrowUpRight size={13} aria-hidden="true" /></button> : <strong>{title}</strong>}
                  <span className={`admin-sync-job-state admin-sync-job-state-${state.tone}`}>
                    {job.status === "running" ? <LoaderCircle size={11} className="spin-icon" aria-hidden="true" /> : null}
                    {state.label}
                  </span>
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
                      <div
                        className={percent === null ? "sync-progress-fill waiting" : "sync-progress-fill"}
                        style={percent === null ? undefined : { width: `${percent}%` }}
                      />
                    </div>
                    {elapsed !== null ? (
                      <div className="sync-progress-note">{elapsed < 1 ? "Less than a minute" : `${elapsed} min`} elapsed</div>
                    ) : null}
                  </div>
                ) : job.status === "queued" ? <p className="admin-sync-job-step">Waiting for another sync to finish.</p> : null}
                {job.status === "failed" ? (
                  <div className="admin-sync-job-failure">
                    <p className="admin-sync-job-error">{job.error ?? "Sync generation failed."}</p>
                    {book ? (
                      <button type="button" className="quiet-button" disabled={!syncEnabled || busyBook !== null || activeJobs.has(book.id)} onClick={() => void act(book.id, "sync")}>
                        {busyBook === book.id ? <LoaderCircle size={12} className="spin-icon" /> : <RefreshCw size={12} />}Try again
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {job.finishedAt && Number(job.finishedAt) > 0 ? <p className="admin-experiment-detail">Finished {new Date(Number(job.finishedAt)).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</p> : null}
              </article>
            );
          })}
        </div> : null}
      </section>

      <section className="admin-sync-panel">
        <div className="admin-sync-panel-head">
          <h4>Books</h4>
          <label className="admin-sync-search">
            <Search size={13} aria-hidden="true" />
            <input type="search" value={query} placeholder="Filter by title or author" aria-label="Filter books" onChange={(event) => setQuery(event.target.value)} />
          </label>
        </div>
        <p className="admin-experiment-detail">Sync a book now or schedule it for later. Books need audio and an EPUB companion.</p>
        <div className="admin-sync-library">
        {[{ title: "Ready to optimize", synced: false, items: visibleBooks.filter((book) => !isSynced(book)), empty: needle ? "No matches." : "Every eligible book has been synced." },
          { title: "Already synced", synced: true, items: visibleBooks.filter(isSynced), empty: needle ? "No matches." : "Synced books will appear here." }].map((group) => (
          <details key={group.title} className="admin-sync-book-group" open>
            <summary>
              {group.synced ? <Check size={16} /> : <BookOpen size={16} />}
              <span>{group.title}</span><span className="admin-sync-count">{group.items.length}</span><ChevronDown className="admin-sync-chevron" size={15} />
            </summary>
            <div className="admin-sync-book-list">
              {group.items.length === 0 ? <p className="admin-sync-empty">{group.empty}</p> : group.items.map((book) => {
                const schedule = schedules?.find((entry) => entry.bookId === book.id);
                const pending = schedule?.status === "scheduled" || schedule?.status === "dispatching";
                const job = activeJobs.get(book.id);
                const percent = job ? syncJobPercent(job) : null;
                return (
                <div className="admin-sync-book-entry" key={book.id}>
                <div className="admin-sync-book-row">
                  <div className="admin-sync-book-info">
                    {onOpenBook ? <button type="button" className="admin-sync-book-link" onClick={() => onOpenBook(book.id)}>{book.title}<ArrowUpRight size={13} aria-hidden="true" /></button> : <strong>{book.title}</strong>}
                    {book.author ? <span className="admin-sync-author">{book.author}</span> : null}
                  </div>
                  <div className="admin-sync-book-actions">
                    {job ? <span className={`admin-sync-state-active admin-sync-job-state-${job.status === "running" ? "running" : "queued"}`}>
                      {job.status === "running"
                        ? <><LoaderCircle size={11} className="spin-icon" aria-hidden="true" />{percent !== null ? `Syncing ${percent}%` : "Syncing"}</>
                        : "Queued"}
                    </span> : <>
                      <button type="button" className="quiet-button" disabled={!syncEnabled || busyBook !== null || pending} onClick={() => void act(book.id, "sync")} aria-label={`Sync ${book.title} now`}>{busyBook === book.id ? <LoaderCircle size={12} className="spin-icon" /> : <RefreshCw size={12} />}{isSynced(book) ? "Re-sync" : "Sync"}</button>
                      {!pending ? <button type="button" className="quiet-button admin-sync-schedule-button" disabled={!syncEnabled || busyBook !== null || schedules === null || !!scheduleError} onClick={() => openSchedule(book.id)} aria-label={`Schedule sync for ${book.title}`} title="Schedule sync"><Clock size={14} /></button> : null}
                    </>}
                  </div>
                </div>
                {pending ? <div className="admin-sync-scheduled">
                  <span>
                    <Clock size={12} aria-hidden="true" />
                    {schedule.status === "dispatching" ? "Submitting to queue…" : <>
                      {new Date(schedule.runAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                      <em>{relativeTime(schedule.runAt, Date.now())}</em>
                    </>}
                  </span>
                  <button type="button" className="admin-sync-book-link" disabled={busyBook !== null || schedule.status === "dispatching"} onClick={() => void act(book.id, "cancel")} aria-label={`Cancel scheduled sync for ${book.title}`}>Cancel</button>
                </div> : null}
                {actionError?.bookId === book.id ? <p role="alert" className="admin-sync-schedule-error">{actionError.message}</p> : null}
                {schedule?.error ? <p className="admin-sync-schedule-error">{schedule.error}</p> : null}
                {schedulingBook === book.id ? <form className="admin-sync-schedule-form" onSubmit={(event) => { event.preventDefault(); void act(book.id, "schedule"); }}>
                  <label htmlFor={`sync-time-${book.id}`}>Start time · {timeZone}</label>
                  <input id={`sync-time-${book.id}`} type="datetime-local" required value={scheduledTime} onChange={(event) => setScheduledTime(event.target.value)} />
                  <p>Joins the queue at this time. The server must be running; starts missed by over 15 minutes are skipped. A job may run past the night.</p>
                  <div><button type="submit" disabled={busyBook !== null || !syncEnabled}>{busyBook === book.id ? "Scheduling…" : "Schedule sync"}</button><button type="button" className="quiet-button" disabled={busyBook !== null} onClick={() => setSchedulingBook(null)}>Cancel</button></div>
                </form> : null}
                </div>
              ); })}
            </div>
          </details>
        ))}
        </div>
      </section>

      <p className="admin-experiment-detail">Jobs run one at a time and continue when you close this view. Activity history clears on server restart; saved sync maps remain.</p>
    </div>
  );
}
