import assert from "node:assert/strict";
import { test } from "node:test";
import { loadHook } from "./hookHarness.ts";
import { library } from "./performance/fixtures.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(offline: Record<string, unknown>, options: Record<string, unknown> = {}) {
  const effects: Array<() => void | (() => void)> = [];
  const states: unknown[] = [];
  let cursor = 0;
  const hook = loadHook("useOfflineDownloads", {
    react: {
      useRef: (current: unknown) => ({ current }),
      useEffect: (run: () => void | (() => void)) => effects.push(run),
      useMemo: (run: () => unknown) => run(),
      useState: (initial: unknown) => {
        const index = cursor++;
        if (!(index in states)) states[index] = initial;
        return [states[index], (value: unknown) => { states[index] = value; }];
      }
    },
    "./offline": offline,
    "./api": { getServerStorageKey: () => "fixture" },
    "./offlineReadiness": {}, "./formatting": {}, "./localLibrary": {}
  });
  const render = () => {
    cursor = 0;
    return hook({ books: [], booksRef: {current: []}, ...options });
  };
  return { render, effects, states };
}

test("catalogue readiness skips optional files without audio and scans books sequentially", async () => {
  const books = library(120);
  const firstAudioChecked = deferred();
  const continueScan = deferred();
  const completed = deferred();
  const audioChecks: string[] = [];
  const detailedChecks: string[] = [];
  const state = { audio: true, ebook: "missing", sentenceSync: "missing", missingFiles: ["sync"] };
  let downloaded: Set<string> | undefined;
  const harness = fixture({
    isBookDownloaded: async (book: {id: string}) => {
      audioChecks.push(book.id);
      if (book.id === books[0].id) {
        firstAudioChecked.resolve();
        await continueScan.promise;
      }
      return book.id === books[119].id;
    },
    getBookOfflineReadiness: async (book: {id: string}) => { detailedChecks.push(book.id); return state; }
  }, { books, booksRef: {current: books}, setDownloadedBookIds: (ids: Set<string>) => { downloaded = ids; completed.resolve(); } });
  harness.render();
  harness.effects[1]();
  await firstAudioChecked.promise;
  assert.deepEqual(audioChecks, [books[0].id], "the next book must wait for the current audio check");
  continueScan.resolve();
  await completed.promise;
  assert.equal(audioChecks.length, 120);
  assert.deepEqual(detailedChecks, [books[119].id], "undownloaded books must not scan companions or sync maps");
  assert.deepEqual(downloaded, new Set([books[119].id]));
  assert.deepEqual(harness.states[0], {[books[119].id]: state});
});

test("offline download controls react to reconnection and remove subscriptions on unmount", (t) => {
  let online = false;
  t.mock.getter(globalThis, "navigator", () => ({onLine: online}) as Navigator);
  const target = new EventTarget();
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {configurable: true, value: target});
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const harness = fixture({});
  assert.equal(harness.render().online, false);
  const cleanup = harness.effects[0]() as () => void;
  online = true;
  target.dispatchEvent(new Event("online"));
  assert.equal(harness.render().online, true, "retry should become usable without navigation or another update");
  online = false;
  target.dispatchEvent(new Event("offline"));
  assert.equal(harness.render().online, false);
  cleanup();
  online = true;
  target.dispatchEvent(new Event("online"));
  assert.equal(harness.render().online, false, "unmounted controls must stop receiving events");
});
