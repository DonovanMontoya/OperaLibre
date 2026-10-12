// Browser fixture: npm run dev -w @operalibre/web, then /test/sync-monitor.html.
// Renders the admin Follow along dashboard against a stubbed API; no server.
import React from "react";
import { createRoot } from "react-dom/client";
import { SyncJobMonitor } from "../src/SyncJobMonitor";
import { renderReaderSyncMessages } from "../src/ReaderPanel";
import type { Book, JobStatus, SyncChapterReport, SyncReport } from "../src/types";
import "../src/styles.css";

const TITLES = [
  ["The Wind in the Willows", "Kenneth Grahame"],
  ["Middlemarch", "George Eliot"],
  ["A Room of One's Own", "Virginia Woolf"],
  ["The Sound and the Fury", "William Faulkner"],
  ["Piranesi", "Susanna Clarke"],
  ["Jonathan Strange & Mr Norrell", "Susanna Clarke"],
  ["The Left Hand of Darkness", "Ursula K. Le Guin"],
  ["Bleak House", "Charles Dickens"],
  ["The Master and Margarita", "Mikhail Bulgakov"],
  ["Gilead", "Marilynne Robinson"],
  ["Stoner", "John Williams"],
  ["The Secret History", "Donna Tartt"],
];

function book(index: number, synced: boolean): Book {
  const [title, author] = TITLES[index % TITLES.length];
  return {
    id: `book-${index}`, title, author, narrator: null, durationSeconds: 40_000,
    trackCount: 3, coverArtUrl: null, coverArtContentType: null, description: null,
    genres: [], tags: [], publishedDate: null, asin: null,
    readingFile: { extension: "epub" } as Book["readingFile"],
    syncFile: synced ? ({ source: "generated" } as Book["syncFile"]) : null,
    chapters: [], metadata: {} as Book["metadata"],
    tracks: [{ id: "t1" }] as unknown as Book["tracks"],
    progress: null, source: "server",
  } as Book;
}

const books = [...TITLES.map((_, i) => book(i, i % 3 === 0 || i === 10))];

books[0].syncFile!.outdated = true;
books[0].syncFile!.quality = { grade: "good", flagged: 0 };
books[3].syncFile!.quality = { grade: "failed", flagged: 5 };
books[6].syncFile!.quality = { grade: "good", flagged: 0 };
books[6].syncFile!.quality = { grade: "poor", flagged: 13 };
books[9].syncFile!.quality = { grade: "review", flagged: 1 };
books[10].syncFile!.quality = { grade: "poor", flagged: 1 };

/** Books whose narration an administrator set to another language. */
const languageOverrides = new Map<string, string | null>([["book-9", "en"]]);

const crashed = "Alignment of `Chapter 9` stopped without writing a result. The alignment runtime may have crashed.";

function report(bookId: string): SyncReport {
  const quality = books.find((entry) => entry.id === bookId)?.syncFile?.quality;
  const chapters: SyncChapterReport[] = Array.from({ length: 14 }, (_, index) => ({
    index, label: index === 0 ? "Opening Credits" : `Chapter ${index}`,
    startSeconds: index * 1500, endSeconds: index * 1500 + 1500,
    textCoverage: 0.97 + (index % 3) * 0.01, gapSeconds: index % 4, skippedText: 0,
    status: "aligned", grade: "good",
  }));
  chapters[0] = { ...chapters[0], status: "empty", textCoverage: 1, gapSeconds: 0, grade: null };
  if (quality?.grade === "failed") {
    // One chapter kept an earlier run's sentences, one has none.
    Object.assign(chapters[9], { textCoverage: 0.94, gapSeconds: 12, status: "kept-previous", grade: "failed",
      error: crashed,
      diagnosis: { cause: "runtime-crash", evidence: {}, fix: { kind: "auto", action: "retry-other-model", attempted: true } } });
    Object.assign(chapters[12], { textCoverage: 0, gapSeconds: 1500, status: "failed", grade: "failed",
      error: "Alignment of `Chapter 12` failed with status exit status: 1:",
      errorDetail: "Alignment of `Chapter 12` failed with status exit status: 1:\nTypeError: Cannot read properties of undefined (reading 'length')\n    at alignSegments (Alignment.js:212:31)",
      diagnosis: { cause: "unknown", evidence: {}, fix: { kind: "none", attempted: false } } });
    Object.assign(chapters[5], { textCoverage: 0.31, gapSeconds: 960, grade: "poor",
      diagnosis: { cause: "edition-mismatch", evidence: { recognizedWords: 3712, wordsInText: 0.08, windows: 7, unanchoredWindows: 6, recognitionRetries: 6 },
        fix: { kind: "none", attempted: false } } });
    Object.assign(chapters[2], {
      diagnosis: { cause: "chapter-mismatch", evidence: { matchingChapter: { index: 3, label: "Chapter 3" }, wordsInText: 0.84 },
        fix: { kind: "auto", action: "match-other-chapter", attempted: true, applied: true } } });
  }
  if (quality?.grade === "poor" && bookId === "book-6") {
    for (const chapter of chapters.slice(1)) {
      Object.assign(chapter, { textCoverage: 0.04, gapSeconds: 1380, grade: "poor",
        diagnosis: { cause: "language-mismatch", evidence: { heardLanguage: "en", labelledLanguage: "nl", wordsInText: 0.01, windows: 7, unanchoredWindows: 7 },
          fix: { kind: "suggested", action: "resync-language", attempted: false } } });
    }
  } else if (quality?.grade === "poor" || quality?.grade === "failed") {
    Object.assign(chapters[7], { textCoverage: 0.62, gapSeconds: 412, grade: "poor",
      diagnosis: bookId === "book-10" ? null : { cause: "noisy-audio", evidence: { recognizedWords: 1210, wordsInText: 0.57, windows: 9, unanchoredWindows: 5, recognitionRetries: 7 },
        fix: { kind: "auto", action: "larger-model", attempted: true } } });
    Object.assign(chapters[11], { textCoverage: 0.91, gapSeconds: 95, grade: "review" });
    Object.assign(chapters[4], { textCoverage: 0.86, gapSeconds: 31, grade: "review" });
  } else if (quality?.grade === "review") {
    Object.assign(chapters[5], { textCoverage: 0.88, gapSeconds: 140, grade: "review" });
  }
  return {
    mapGeneratedAt: "1791504810", mapSize: 4_937_055,
    graded: bookId === "book-10" ? "estimate" : "run",
    grade: quality?.grade ?? null, chapters,
    languageOverride: languageOverrides.get(bookId) ?? null,
  };
}

const now = Date.now();
const jobs: JobStatus[] = [
  { id: "j1", kind: "sync-generate", targetId: "book-1", status: "running", startedAt: String(now - 22 * 60_000),
    runningAt: String(now - 22 * 60_000), finishedAt: null, exitCode: null, output: "", error: null,
    progress: { fraction: 0.42, step: "Aligning the narration to the text" } as JobStatus["progress"] },
  { id: "j2", kind: "sync-generate", targetId: "book-2", status: "queued", startedAt: String(now - 5 * 60_000),
    finishedAt: null, exitCode: null, output: "", error: null },
  { id: "j3", kind: "sync-generate", targetId: "book-3", status: "completed", startedAt: String(now - 200 * 60_000),
    finishedAt: String(now - 120 * 60_000), exitCode: 0, output: "", error: null,
    failedChapters: [{ index: 9, label: "Chapter 9", cause: "runtime-crash" }, { index: 12, label: "Chapter 12", cause: "unknown" }] },
  { id: "j4", kind: "sync-generate", targetId: "book-4", status: "failed", startedAt: String(now - 400 * 60_000),
    finishedAt: String(now - 380 * 60_000), exitCode: 1, output: "",
    error: "Recognition model download failed: connection reset by peer", cause: "unknown" },
  { id: "j8", kind: "sync-generate", targetId: "book-8", status: "failed", startedAt: String(now - 500 * 60_000),
    finishedAt: String(now - 460 * 60_000), exitCode: 1, output: "",
    error: "Alignment produced no usable sentence fragments.", cause: "language-mismatch", heardLanguage: "en" },
  { id: "j9", kind: "sync-generate", targetId: "book-7", status: "failed", startedAt: String(now - 600 * 60_000),
    finishedAt: String(now - 590 * 60_000), exitCode: 1, output: "",
    error: "No such file or directory (os error 2)", cause: "runtime-crash" },
];

jobs.push(
  { id: "j5", kind: "sync-generate", targetId: "book-5", status: "queued", startedAt: String(now - 4 * 60_000), finishedAt: null, exitCode: null, output: "", error: null },
  { id: "j7", kind: "sync-generate", targetId: "book-9", status: "queued", startedAt: String(now - 2 * 60_000), finishedAt: null, exitCode: null, output: "", error: null,
    chapters: [{ index: 5, label: "Chapter 5" }] },
  { id: "j6", kind: "sync-generate", targetId: "book-11", status: "paused", startedAt: String(now - 3 * 60_000), finishedAt: null, exitCode: null, output: "", error: null, pauseRequested: true, progress: { fraction: 0.3, step: "Paused" } as JobStatus["progress"] },
);

const schedules = [
  { bookId: "book-5", runAt: now + 7 * 3_600_000, status: "scheduled", jobId: null, error: null },
  { bookId: "book-7", runAt: now - 600 * 60_000, status: "failed", jobId: "j9", error: "Scheduled sync failed. See sync activity, then retry." },
  { bookId: "book-10", runAt: now - 60_000, status: "failed", jobId: null, error: "Follow along was disabled before the scheduled start." },
  { bookId: "book-11", runAt: now + 30 * 3_600_000, status: "scheduled", jobId: null, error: null },
];

let jobsEnabled = true;

const sweep = {
  enabled: true,
  booksPerNight: 2,
  localTime: "01:00",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  nextRunAt: (() => { const d = new Date(); d.setHours(1, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); })(),
  lastRunAt: now - 26 * 3_600_000,
  lastQueued: 3,
  lastError: null as string | null,
  pendingCount: 9,
  eligibleCount: 12,
};

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.includes("/api/sync-sweep/run")) return json({ queued: sweep.pendingCount, skipped: 1, error: null });
  if (url.includes("/api/sync-sweep")) {
    if (init?.method === "PUT") Object.assign(sweep, JSON.parse(String(init.body)));
    return json(sweep);
  }
  if (url.includes("/api/sync-jobs/")) {
    const id = url.split("/").pop();
    const index = jobs.findIndex((job) => job.id === id);
    if (index < 0) return new Response("Not found", { status: 404 });
    if (init?.method === "DELETE") { jobs.splice(index, 1); return new Response(null, { status: 204 }); }
    const job = jobs[index];
    const { action } = JSON.parse(String(init?.body));
    if (action === "up" || action === "down") {
      const queue = jobs.filter((job) => job.status === "queued").sort((a, b) => (a.queuePosition ?? Number(a.startedAt)) - (b.queuePosition ?? Number(b.startedAt)));
      const current = queue.indexOf(job);
      const other = current + (action === "up" ? -1 : 1);
      if (other >= 0 && other < queue.length) [queue[current], queue[other]] = [queue[other], queue[current]];
      queue.forEach((entry, rank) => { entry.queuePosition = rank; });
    } else if (action === "pause") { job.pauseRequested = true; if (job.status === "queued") job.status = "paused"; }
    else if (action === "resume") { job.status = "queued"; job.pauseRequested = false; job.queuePosition = Math.max(...jobs.map((entry) => entry.queuePosition ?? Number(entry.startedAt))) + 1; }
    return json(job);
  }
  if (url.includes("/api/jobs")) return json(jobsEnabled ? jobs : []);
  if (url.includes("/api/sync-schedules")) {
    if (init?.method === "DELETE") {
      const bookId = decodeURIComponent(url.split("/").pop()!);
      const index = schedules.findIndex((entry) => entry.bookId === bookId);
      if (index >= 0) schedules.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return json(schedules);
  }
  const generateFor = url.match(/\/api\/books\/([^/]+)\/sync\/generate/);
  if (generateFor) {
    const bookId = decodeURIComponent(generateFor[1]);
    const chapters: number[] | undefined = init?.body ? JSON.parse(String(init.body)).chapters : undefined;
    // Stoner's estimate no longer matches its chapters, as after a re-tagged audiobook.
    if (chapters && bookId === "book-10") {
      return new Response(JSON.stringify({ message: "This book changed since its last full sync. Re-sync the whole book." }), { status: 409, headers: { "Content-Type": "application/json" } });
    }
    const id = `j${jobs.length + 10}`;
    jobs.push({ id, kind: "sync-generate", targetId: bookId, status: "queued", startedAt: String(Date.now()), finishedAt: null, exitCode: null, output: "", error: null,
      chapters: chapters?.map((index) => ({ index, label: `Chapter ${index}` })) });
    return json({ jobId: id });
  }
  const languageFor = url.match(/\/api\/books\/([^/]+)\/sync\/language/);
  if (languageFor) {
    const { language } = JSON.parse(String(init?.body));
    languageOverrides.set(decodeURIComponent(languageFor[1]), language);
    return json({ languageOverride: language });
  }
  const reportFor = url.match(/\/api\/books\/([^/]+)\/sync\/report/);
  if (reportFor) return json(report(decodeURIComponent(reportFor[1])));
  if (url.includes("/api/books")) return json(books);
  return realFetch(input as RequestInfo, init);
};

function Fixture() {
  const [enabled, setEnabled] = React.useState(true);
  const [hasJobs, setHasJobs] = React.useState(true);
  const [dark, setDark] = React.useState(false);
  jobsEnabled = hasJobs;
  React.useEffect(() => {
    document.documentElement.className = dark ? "native-app platform-ios dark-mode" : "";
  }, [dark]);
  return (
    <div className="admin-content" style={{ padding: 24, maxWidth: 980, margin: "0 auto" }}>
      <p style={{ display: "flex", gap: 16, fontSize: 13, marginBottom: 16 }}>
        <label><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Follow along enabled</label>
        <label><input type="checkbox" checked={hasJobs} onChange={(e) => setHasJobs(e.target.checked)} /> Job history</label>
        <label><input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} /> Dark</label>
      </p>
      <section className="admin-card">
        <div className="admin-experiment-list">
          <article>
            <SyncJobMonitor books={books} syncEnabled={enabled} onOpenBook={() => {}} />
          </article>
        </div>
      </section>
      {/* The reader's own account of the same failed job. */}
      <section className="admin-card" id="reader-sync-message" style={{ marginTop: 16, padding: 16 }}>
        {renderReaderSyncMessages({
          readalong: { activeCompanionIsBook: false, canGenerateSync: false, selectedSyncPrecise: false, syncJobError: null, syncNotice: null } as unknown as Parameters<typeof renderReaderSyncMessages>[0]["readalong"],
          syncJobForBook: jobs.find((job) => job.id === "j9") ?? null,
          syncJobRunning: false,
          syncProgressNote: "",
          syncProgressPercent: null,
        })}
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
