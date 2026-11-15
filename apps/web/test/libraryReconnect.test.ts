import assert from "node:assert/strict";
import test from "node:test";
import * as reliability from "../src/reliability.ts";
import * as startup from "../src/startup.ts";
import { loadHook } from "./hookHarness.ts";

const unreachable = () => new TypeError("Load failed");

function fixture(getBooks: () => Promise<unknown[]>, deviceOnline = true) {
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const offline: boolean[] = [];
  const errors: Array<string | null> = [];
  const loading: boolean[] = [];
  const ref = <T>(current: T) => ({ current });
  const noop = () => {};
  Object.assign(globalThis, {
    window: {
      localStorage: { getItem: () => null, setItem: noop },
      setTimeout(callback: () => void, delay: number) { timers.push({ callback, delay }); return timers.length; },
      clearTimeout: noop
    }
  });
  Object.defineProperty(globalThis, "navigator", { value: { onLine: deviceOnline }, configurable: true });
  const book = { id: "book", source: "server", tracks: [{ id: "track" }], progress: null };
  const loadBooksRef = ref<() => Promise<void>>(async () => undefined);
  const generation = ref(0);
  let reachable = 0;
  const library = loadHook("useLibrary", {
    react: { useCallback: (fn: unknown) => fn, useRef: ref },
    "./localLibrary": { backfillDeviceLibraryMetadata: noop, getDeviceBooks: () => [], getDeviceProgress: () => null,
      mergeDeviceAndServerBooks: (books: unknown) => books, migrateDeviceLibraryFileExtensions: noop },
    "./reliability": reliability,
    "./appStorage": { readStoredBookId: () => null, withoutCachedBookGains: (books: unknown) => books },
    "./startup": startup,
    "./api": { getBooks, getLibationBooks: async () => [], getServerStorageKey: () => "server",
      isNetworkError: (error: unknown) => error instanceof TypeError,
      isServerBusyError: (error: unknown) => (error as { status?: number }).status === 429,
      isServerNotReadyError: () => false,
      saveProgress: async () => null },
    "./offline": { cacheLibrary: async () => {}, getCachedLibrary: async () => [book], getCachedProgress: async () => null },
    "./progressSeekIntent": { acknowledgeProgressSeekIntent: noop, progressSeekStorage: () => null,
      progressSeekOptions: () => ({}), readProgressSeekIntent: () => null }
  })({
    audioRef: ref(null), currentUser: { id: "reader" }, initialLibraryHydrated: ref(false), isOperaLibre: false,
    libraryProgressReplaysRef: ref(new Map()), libraryRequestGenerationRef: generation, libraryRetryTimerRef: ref(null),
    loadBooksRef, localMode: false, native: false, nativeAudioRef: ref(false), nativePlaybackPlayingRef: ref(false),
    onServerReachable: () => { reachable += 1; }, reconcileServerBookGains: noop, resumeReconciliationBookIdRef: ref(null), setBooks: noop,
    setError: (value: string | null) => errors.push(value), setIsLoading: (value: boolean) => loading.push(value),
    setIsOffline: (value: boolean) => offline.push(value), setLibationBooks: noop, setLibationBooksLoaded: noop,
    setNativeTab: noop, setPlaybackBookId: noop, setSelectedBookId: noop, setStartupViewReady: noop,
    startupNavigationResolved: ref(true), startupNavigationOverridden: ref(false), startupViewReadyRef: ref(true),
    storeCanonicalServerProgress: noop
  });
  loadBooksRef.current = library.loadBooks;
  async function runNextTimer() {
    const timer = timers.shift();
    assert.ok(timer, "a reconnect is scheduled");
    timer.callback();
    // The retry's own awaits settle before the next assertion.
    for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve));
    return timer.delay;
  }
  return { library, timers, offline, errors, loading, runNextTimer, generation, reachable: () => reachable };
}

test("a launch that reaches the server on a retry never shows offline", async () => {
  let attempts = 0;
  const f = fixture(async () => {
    if (++attempts < 3) throw unreachable();
    return [{ id: "book", source: "server", tracks: [{ id: "track" }], progress: null }];
  });
  await f.library.loadBooks();
  assert.equal(await f.runNextTimer(), 1_000);
  assert.equal(await f.runNextTimer(), 2_000);
  assert.equal(attempts, 3);
  assert.ok(!f.offline.includes(true));
  assert.ok(f.errors.every(error => error === null));
  assert.equal(f.timers.length, 0);
  assert.equal(f.reachable(), 1);
});

test("repeated failures go offline and keep checking back", async () => {
  let reachable = false;
  const f = fixture(async () => {
    if (!reachable) throw unreachable();
    return [];
  });
  await f.library.loadBooks();
  await f.runNextTimer();
  assert.ok(!f.offline.includes(true));
  await f.runNextTimer();
  assert.equal(f.offline.at(-1), true);
  assert.match(f.errors.at(-1) ?? "", /Offline mode/);
  reachable = true;
  assert.equal(await f.runNextTimer(), 4_000);
  assert.equal(f.offline.at(-1), false);
  assert.equal(f.errors.at(-1), null);
});

test("a device with no network is offline on the first failure", async () => {
  const f = fixture(async () => { throw unreachable(); }, false);
  await f.library.loadBooks();
  assert.equal(f.offline.at(-1), true);
  assert.equal(f.timers.length, 1);
});

test("a server busy with another listing is retried, not called unreachable", async () => {
  let attempts = 0;
  const f = fixture(async () => {
    if (++attempts === 1) throw Object.assign(new Error("A catalogue response is still in use."),
      { status: 429, retryAfterSeconds: 5 });
    return [];
  });
  await f.library.loadBooks();
  assert.ok(!f.offline.includes(true));
  assert.ok(f.errors.every(error => error === null));
  assert.equal(await f.runNextTimer(), 5_000);
  assert.equal(attempts, 2);
  assert.equal(f.timers.length, 0);
});

test("requests that wait out their timeout go offline after two attempts", async (t) => {
  let clock = 1_000_000;
  t.mock.method(Date, "now", () => clock);
  const f = fixture(async () => { clock += 8_000; throw unreachable(); });
  await f.library.loadBooks();
  assert.ok(!f.offline.includes(true));
  clock += 1_000;
  await f.runNextTimer();
  assert.equal(f.offline.at(-1), true);
});

test("a listing that fails after its session ended schedules nothing", async () => {
  let fail!: (error: unknown) => void;
  const f = fixture(() => new Promise((_resolve, reject) => { fail = reject; }));
  const loading = f.library.loadBooks();
  await new Promise(resolve => setImmediate(resolve));
  // Signing out unmounts the app, which retires every outstanding listing.
  f.generation.current += 1;
  fail(unreachable());
  await loading;
  assert.equal(f.timers.length, 0);
  assert.ok(!f.offline.includes(true));
});
