// Browser fixture: npm run dev -w @operalibre/web, then /test/sync-monitor.html.
// Renders the admin Follow along dashboard against a stubbed API; no server.
import React from "react";
import { createRoot } from "react-dom/client";
import { SyncJobMonitor } from "../src/SyncJobMonitor";
import type { Book, JobStatus } from "../src/types";
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

const books = [...TITLES.map((_, i) => book(i, i % 3 === 0))];

const now = Date.now();
const jobs: JobStatus[] = [
  { id: "j1", kind: "sync-generate", targetId: "book-1", status: "running", startedAt: String(now - 22 * 60_000),
    runningAt: String(now - 22 * 60_000), finishedAt: null, exitCode: null, output: "", error: null,
    progress: { fraction: 0.42, step: "Aligning the narration to the text" } as JobStatus["progress"] },
  { id: "j2", kind: "sync-generate", targetId: "book-2", status: "queued", startedAt: String(now - 5 * 60_000),
    finishedAt: null, exitCode: null, output: "", error: null },
  { id: "j3", kind: "sync-generate", targetId: "book-3", status: "completed", startedAt: String(now - 200 * 60_000),
    finishedAt: String(now - 120 * 60_000), exitCode: 0, output: "", error: null },
  { id: "j4", kind: "sync-generate", targetId: "book-4", status: "failed", startedAt: String(now - 400 * 60_000),
    finishedAt: String(now - 380 * 60_000), exitCode: 1, output: "",
    error: "Recognition model download failed: connection reset by peer" },
];

const schedules = [
  { bookId: "book-5", runAt: now + 7 * 3_600_000, status: "scheduled", jobId: null, error: null },
  { bookId: "book-7", runAt: now + 30 * 3_600_000, status: "scheduled", jobId: null, error: null },
];

let jobsEnabled = true;

const sweep = {
  enabled: true,
  localTime: "01:00",
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  nextRunAt: (() => { const d = new Date(); d.setHours(1, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); })(),
  lastRunAt: now - 26 * 3_600_000,
  lastQueued: 3,
  lastError: null as string | null,
  pendingCount: 8,
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
  if (url.includes("/api/jobs")) return json(jobsEnabled ? jobs : []);
  if (url.includes("/api/sync-schedules")) return json(init?.method === "DELETE" ? [] : schedules);
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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><Fixture /></React.StrictMode>);
