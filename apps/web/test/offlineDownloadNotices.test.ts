import assert from "node:assert/strict";
import { test } from "node:test";
import { loadHook } from "./hookHarness.ts";
import { offlineDownloadMessage } from "../src/offlineReadiness.ts";
import { library } from "./performance/fixtures.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(transfer: (signal: AbortSignal, retry: boolean) => Promise<void>, cancel = async () => {}) {
  const book = library(1)[0];
  const readiness = { audio: true, ebook: "missing", sentenceSync: "missing", missingFiles: ["companion:ebook", "sync"] };
  let downloaded = new Set([book.id]);
  let activity: Record<string, unknown> = {};
  const notices: Array<{message: string} | null> = [];
  let progressSaves = 0;
  const hook = loadHook("useOfflineDownloads", {
    react: { useRef: (current: unknown) => ({ current }), useEffect: () => {}, useMemo: (run: () => unknown) => run(), useState: (value: unknown) => [value, () => {}] },
    "./offline": { cacheLibrary: async () => {}, getBookOfflineReadiness: async () => readiness,
      downloadBookForOffline: async (_book: unknown, _url: unknown, _progress: unknown, signal: AbortSignal, retry: boolean) => transfer(signal, retry),
      cancelBookOfflineDownload: cancel },
    "./api": { getServerStorageKey: () => "fixture", mediaUrl: (url: string) => url },
    "./offlineReadiness": { offlineDownloadMessage },
    "./formatting": { errorMessage: (error: Error) => error.message }, "./localLibrary": {}
  })({ books: [book], booksRef: {current: [book]}, currentUser: {id: "reader"}, capabilities: {downloads: true}, playbackBook: book,
    persistProgress: () => { progressSaves++; },
    setDownloadStatus: (notice: {message: string} | null) => notices.push(notice),
    setActiveDownloads: (update: (current: Record<string, unknown>) => Record<string, unknown>) => { activity = update(activity); },
    setDownloadedBookIds: (update: (current: Set<string>) => Set<string>) => { downloaded = update(downloaded); }
  });
  return {book, hook, notices, downloaded: () => downloaded, activity: () => activity, progressSaves: () => progressSaves};
}

test("completion tells the listener which reading files are missing", async () => {
  const state = fixture(async () => {});
  await state.hook.retryMissingFiles(state.book);
  assert.match(state.notices.at(-1)!.message, /Audio: ready.*Ebook: missing.*Sentence sync: missing/);
  assert.ok(state.downloaded().has(state.book.id));
  assert.equal(state.progressSaves(), 0, "retry must not write or stage playback progress");
});

test("retry cancellation waits for native cleanup before another attempt can start", async () => {
  const started = deferred();
  const cleanedUp = deferred();
  let transfers = 0;
  const state = fixture(async (signal, retry) => {
    assert.equal(retry, true);
    transfers++;
    started.resolve();
    await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once: true}));
  }, () => cleanedUp.promise);
  const first = state.hook.retryMissingFiles(state.book);
  await started.promise;
  const cancellation = state.hook.cancelOfflineDownload(state.book);
  await state.hook.retryMissingFiles(state.book);
  assert.equal(transfers, 1, "pending cleanup must keep the book locked");
  assert.ok(state.downloaded().has(state.book.id));
  cleanedUp.resolve();
  await Promise.all([first, cancellation]);
  assert.deepEqual(state.activity(), {});
  assert.ok(state.downloaded().has(state.book.id));
  assert.equal(state.progressSaves(), 0);
  assert.match(state.notices.at(-1)!.message, /cancelled/);
});
