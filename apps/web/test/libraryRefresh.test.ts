import assert from "node:assert/strict";
import test from "node:test";
import * as reliability from "../src/reliability.ts";
import * as startup from "../src/startup.ts";
import type { LibraryProgressReplay } from "../src/playbackTypes.ts";
import type { Progress } from "../src/types.ts";
import { loadHook } from "./hookHarness.ts";

const noop = () => {};
const ref = <T>(current: T) => ({ current });
const unreachable = () => new TypeError("Load failed");
const book = (id: string, progress: Progress | null = null) => ({
  id, title: id, source: "server", tracks: [{ id: `${id}-track`, durationSeconds: 1_000 }], progress
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(
  getBooks: () => Promise<ReturnType<typeof book>[]>,
  rescanLibrary: () => Promise<ReturnType<typeof book>[]>,
  options: {
    localMode?: boolean;
    isAdmin?: boolean;
    deviceOnline?: boolean;
    getCachedProgress?: () => Promise<Progress | null>;
    saveProgress?: (id: string, progress: Progress) => Promise<Progress | null>;
    storeCanonicalServerProgress?: (book: unknown, saved: Progress) => void;
  } = {}
) {
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  Object.assign(globalThis, {
    window: {
      localStorage: { getItem: () => null, setItem: noop },
      setTimeout(callback: () => void) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id: number) { timers.delete(id); }
    }
  });
  Object.defineProperty(globalThis, "navigator", { value: { onLine: options.deviceOnline ?? true }, configurable: true });
  const state: {
    books: ReturnType<typeof book>[];
    selected: string | null;
    playback: string | null;
    offline: boolean;
    error: string | null;
    loading: boolean;
  } = {
    books: [], selected: null, playback: null, offline: false, error: null, loading: false
  };
  const setter = <K extends keyof typeof state>(key: K) =>
    (value: typeof state[K] | ((previous: typeof state[K]) => typeof state[K])) => {
      state[key] = typeof value === "function" ? value(state[key]) : value;
    };
  const replays = ref(new Map<string, Promise<LibraryProgressReplay>>());
  const booksRef = ref(state.books);
  let cachedLibrary: ReturnType<typeof book>[] = [];
  const loadBooksRef = ref(async () => {});
  const dependencies = {
    react: { useCallback: (fn: unknown) => fn, useRef: ref },
    "./localLibrary": { backfillDeviceLibraryMetadata: noop, getDeviceBooks: () => [], getDeviceProgress: () => null,
      mergeDeviceAndServerBooks: (books: unknown) => books, migrateDeviceLibraryFileExtensions: noop },
    "./reliability": reliability,
    "./appStorage": { readStoredBookId: () => null, withoutCachedBookGains: (books: unknown) => books },
    "./startup": startup,
    "./api": { getBooks, rescanLibrary, getLibationBooks: async () => [], getServerStorageKey: () => "server",
      isNetworkError: (error: unknown) => error instanceof TypeError,
      isServerBusyError: () => false,
      isServerNotReadyError: (error: unknown) => error instanceof Error && "status" in error && error.status === 503,
      saveProgress: options.saveProgress ?? (async () => null) },
    "./offline": { cacheLibrary: async (_user: string, books: ReturnType<typeof book>[]) => { cachedLibrary = books; },
      getCachedLibrary: async () => cachedLibrary,
      getCachedProgress: options.getCachedProgress ?? (async () => null) },
    "./progressSeekIntent": { acknowledgeProgressSeekIntent: noop, progressSeekStorage: () => null,
      progressSeekOptions: () => ({}), readProgressSeekIntent: () => null },
    "./purchaseRefresh": { refreshPurchaseSources: noop }, "./libroDevice": { refreshLibroDevice: noop }
  };
  const common = {
    audioRef: ref({ paused: false }), booksRef, currentUser: { id: "reader", isAdmin: options.isAdmin ?? true },
    initialLibraryHydrated: ref(true), isOperaLibre: true, libraryProgressReplaysRef: replays,
    libraryRequestGenerationRef: ref(0), libraryRetryTimerRef: ref<number | null>(null), loadBooksRef,
    localMode: options.localMode ?? false, native: false, nativeAudioRef: ref(false), nativeAudio: false,
    nativePlaybackPlayingRef: ref(false), onServerReachable: noop, reconcileServerBookGains: noop,
    resumeReconciliationBookIdRef: ref(null), setBooks: (books: typeof state.books) => {
      setter("books")(books);
      booksRef.current = state.books;
    }, setError: setter("error"),
    setIsLoading: setter("loading"), setIsOffline: setter("offline"), setLibationBooks: noop,
    setLibationBooksLoaded: noop, setNativeTab: noop, setPlaybackBookId: setter("playback"),
    setSelectedBookId: setter("selected"), setStartupViewReady: noop, startupNavigationResolved: ref(true),
    startupNavigationOverridden: ref(false), startupViewReadyRef: ref(true),
    storeCanonicalServerProgress: options.storeCanonicalServerProgress ?? noop
  };
  const library = loadHook("useLibrary", dependencies)(common);
  const run = { promise: Promise.resolve() };
  loadBooksRef.current = () => (run.promise = library.loadBooks());
  const refresh = loadHook("useLibraryRefresh", dependencies)({ ...common, loadBooks: loadBooksRef.current });
  function startRetry() {
    const timer = timers.entries().next().value;
    assert.ok(timer, "a reconnect is scheduled");
    timers.delete(timer[0]);
    timer[1]();
    return run.promise;
  }
  function endSession() {
    common.libraryRequestGenerationRef.current += 1;
    replays.current.clear();
  }
  return { library, refresh, state, timers, replays, run, startRetry, endSession };
}

for (const outcome of ["success", "failure"] as const) {
  test(`a rescan supersedes an in-flight reconnect ${outcome}`, async () => {
    const old = deferred<ReturnType<typeof book>[]>();
    let attempts = 0;
    const f = fixture(() => ++attempts === 1 ? Promise.reject(unreachable()) : old.promise,
      async () => [book("fresh")]);
    await f.library.loadBooks();
    const retry = f.startRetry();
    assert.equal(attempts, 2);
    await f.refresh.refreshLibrary();
    assert.deepEqual(f.state.books.map(book => book.id), ["fresh"]);
    f.state.selected = "fresh";
    f.state.playback = "fresh";
    if (outcome === "success") old.resolve([book("old")]);
    else old.reject(unreachable());
    await retry;
    assert.deepEqual(f.state.books.map(book => book.id), ["fresh"]);
    assert.equal(f.state.selected, "fresh");
    assert.equal(f.state.playback, "fresh");
    assert.equal(f.state.offline, false);
    assert.equal(f.state.error, null);
    assert.equal(f.timers.size, 0);
  });
}

test("a successful rescan cancels a queued reconnect", async () => {
  const f = fixture(async () => { throw unreachable(); }, async () => [book("fresh")]);
  await f.library.loadBooks();
  assert.equal(f.timers.size, 1);
  await f.refresh.refreshLibrary();
  assert.equal(f.timers.size, 0);
  assert.deepEqual(f.state.books.map(book => book.id), ["fresh"]);
});

for (const outcome of ["success", "network failure", "server not ready"] as const) {
  test(`a newer load supersedes a rescan ${outcome}`, async () => {
    const scan = deferred<ReturnType<typeof book>[]>();
    let attempts = 0;
    const f = fixture(async () => { attempts++; return [book("latest")]; }, () => scan.promise);
    const refreshing = f.refresh.refreshLibrary();
    await f.library.loadBooks();
    f.state.playback = "latest";
    if (outcome === "success") scan.resolve([book("earlier")]);
    else scan.reject(outcome === "network failure" ? unreachable() : Object.assign(new Error("starting"), { status: 503 }));
    await refreshing;
    assert.deepEqual(f.state.books.map(book => book.id), ["latest"]);
    assert.equal(f.state.selected, "latest");
    assert.equal(f.state.playback, "latest");
    assert.equal(f.state.offline, false);
    assert.equal(f.state.error, null);
    assert.equal(attempts, 1);
    assert.equal(f.timers.size, 0);
  });
}

test("a superseded rescan does not hide a newer load's loading state", async () => {
  const scan = deferred<ReturnType<typeof book>[]>();
  const listing = deferred<ReturnType<typeof book>[]>();
  const f = fixture(() => listing.promise, () => scan.promise);
  const refreshing = f.refresh.refreshLibrary();
  const loading = f.library.loadBooks();
  scan.resolve([book("earlier")]);
  await refreshing;
  assert.equal(f.state.loading, true);
  listing.resolve([book("latest")]);
  await loading;
  assert.equal(f.state.loading, false);
});

test("a local-only refresh delegates to device loading", async () => {
  const f = fixture(async () => { throw new Error("must not list server"); },
    async () => { throw new Error("must not rescan"); }, { localMode: true });
  await f.refresh.refreshLibrary();
  assert.deepEqual(f.state.books, []);
  assert.equal(f.state.offline, false);
  assert.equal(f.state.loading, false);
  assert.equal(f.state.error, null);
});

test("a server-not-ready rescan hands recovery to loadBooks", async () => {
  const f = fixture(async () => [book("recovered")],
    async () => { throw Object.assign(new Error("starting"), { status: 503 }); });
  await f.refresh.refreshLibrary();
  await f.run.promise;
  assert.deepEqual(f.state.books.map(book => book.id), ["recovered"]);
  assert.equal(f.state.offline, false);
  assert.equal(f.state.loading, false);
});

test("a reader refresh lists books without rescanning", async () => {
  const f = fixture(async () => [book("fresh")],
    async () => { throw new Error("readers must not rescan"); }, { isAdmin: false });
  await f.refresh.refreshLibrary();
  assert.deepEqual(f.state.books.map(book => book.id), ["fresh"]);
  assert.equal(f.state.error, null);
});

const serverProgress: Progress = {
  bookId: "book", trackId: "book-track", positionSeconds: 100, bookPositionSeconds: 100,
  durationSeconds: 1_000, updatedAt: "1790769600000"
};
const localProgress = reliability.pendingProgress({
  ...serverProgress, positionSeconds: 160, bookPositionSeconds: 160, updatedAt: "2026-09-30T12:01:00Z"
}, reliability.syncedProgress(serverProgress, "2026-09-30T12:00:00Z"));
const progressBook = book("book", serverProgress);

test("a rescan preserves the receipt for a progress replay already in flight", async () => {
  const started = deferred<void>();
  const saved = deferred<Progress>();
  const receipts: Progress[] = [];
  const f = fixture(async () => [progressBook], async () => [progressBook], {
    getCachedProgress: async () => localProgress,
    saveProgress: async () => { started.resolve(); return saved.promise; },
    storeCanonicalServerProgress: (_book, receipt) => receipts.push(receipt)
  });
  await f.library.loadBooks();
  await started.promise;
  const replay = f.replays.current.get("book");
  assert.ok(replay);
  await f.refresh.refreshLibrary();
  const receipt = { ...localProgress, accepted: true, updatedAt: "1790769660000" };
  saved.resolve(receipt);
  assert.equal((await replay)?.saved, receipt);
  assert.deepEqual(receipts, [receipt]);
  assert.equal(receipts[0].bookPositionSeconds, 160);
});

test("a successful rescan preserves an unsent replay without another library load", async () => {
  const started = deferred<void>();
  const cached = deferred<Progress>();
  const writes: Progress[] = [];
  let listings = 0;
  const receipts: Progress[] = [];
  const f = fixture(async () => { listings++; return [progressBook]; }, async () => [progressBook], {
    getCachedProgress: () => { started.resolve(); return cached.promise; },
    saveProgress: async (_id, progress) => {
      writes.push(progress);
      return { ...progress, accepted: true, updatedAt: "1790769660000" };
    },
    storeCanonicalServerProgress: (_book, receipt) => receipts.push(receipt)
  });
  await f.library.loadBooks();
  await started.promise;
  const replay = f.replays.current.get("book");
  assert.ok(replay);
  await f.refresh.refreshLibrary();
  cached.resolve(localProgress);
  await replay;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].bookPositionSeconds, 160);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].accepted, true);
  assert.equal(receipts[0].bookPositionSeconds, 160);
  assert.equal(listings, 1);
  assert.equal(f.state.playback, null, "the unopened book's progress is replayed");
  assert.equal(f.timers.size, 0);
});

test("a newer library load replaces an unsent replay without duplicating the save", async () => {
  const started = deferred<void>();
  const cached = deferred<Progress>();
  const writes: Progress[] = [];
  const f = fixture(async () => [progressBook], async () => [progressBook], {
    getCachedProgress: () => { started.resolve(); return cached.promise; },
    saveProgress: async (_id, progress) => { writes.push(progress); return { ...progress, accepted: true }; }
  });
  await f.library.loadBooks();
  await started.promise;
  const previousReplay = f.replays.current.get("book");
  await f.library.loadBooks();
  const replay = f.replays.current.get("book");
  assert.ok(replay);
  assert.notEqual(replay, previousReplay);
  cached.resolve(localProgress);
  assert.equal(await previousReplay, null);
  await replay;
  assert.equal(writes.length, 1);
  assert.equal(writes[0].bookPositionSeconds, 160);
});

for (const saving of [false, true]) {
  test(`session teardown cancels a replay ${saving ? "receipt" : "waiting for cached progress"}`, async () => {
    const started = deferred<void>();
    const cached = deferred<Progress>();
    const saved = deferred<Progress>();
    const writes: Progress[] = [];
    const receipts: Progress[] = [];
    const f = fixture(async () => [progressBook], async () => [progressBook], {
      getCachedProgress: () => {
        if (!saving) started.resolve();
        return saving ? Promise.resolve(localProgress) : cached.promise;
      },
      saveProgress: async (_id, progress) => {
        writes.push(progress);
        started.resolve();
        return saved.promise;
      },
      storeCanonicalServerProgress: (_book, receipt) => receipts.push(receipt)
    });
    await f.library.loadBooks();
    await started.promise;
    const replay = f.replays.current.get("book");
    assert.ok(replay);
    f.endSession();
    cached.resolve(localProgress);
    saved.resolve({ ...localProgress, accepted: true });
    await replay;
    assert.equal(writes.length, saving ? 1 : 0);
    assert.deepEqual(receipts, []);
    assert.equal(f.replays.current.size, 0);
  });
}

for (const cachedShelf of [false, true]) {
  test(`a network-failed rescan keeps the playing book with ${cachedShelf ? "an older" : "an empty"} cache`, async () => {
    let reachable = true;
    let serverBooks = cachedShelf ? [book("cached")] : [];
    const f = fixture(async () => {
      if (!reachable) throw unreachable();
      return serverBooks;
    }, async () => {
      if (!reachable) throw unreachable();
      return serverBooks;
    }, { deviceOnline: false });
    await f.library.loadBooks();
    serverBooks = [...serverBooks, book("new")];
    await f.refresh.refreshLibrary();
    f.state.selected = "new";
    f.state.playback = "new";
    reachable = false;
    await f.refresh.refreshLibrary();
    await f.run.promise;
    assert.deepEqual(f.state.books, serverBooks);
    assert.equal(f.state.selected, "new");
    assert.equal(f.state.playback, "new");
    assert.equal(f.state.offline, true);
    assert.equal(f.state.loading, false);
    assert.equal(f.timers.size, 1);
    await f.startRetry();
    assert.deepEqual(f.state.books, serverBooks);
    assert.equal(f.state.playback, "new");
    reachable = true;
    await f.startRetry();
    assert.equal(f.state.playback, "new");
    assert.equal(f.state.offline, false);
    assert.equal(f.state.error, null);
    assert.equal(f.timers.size, 0);
  });
}

test("a network-failed rescan replaces the retry and eventually reconnects", async () => {
  let reachable = false;
  const f = fixture(async () => {
    if (!reachable) throw unreachable();
    return [book("recovered")];
  }, async () => { throw unreachable(); });
  await f.library.loadBooks();
  assert.equal(f.timers.size, 1);
  const previousTimer = [...f.timers.keys()][0];
  await f.refresh.refreshLibrary();
  await f.run.promise;
  assert.equal(f.timers.has(previousTimer), false);
  assert.equal(f.timers.size, 1);
  reachable = true;
  await f.startRetry();
  assert.deepEqual(f.state.books.map(book => book.id), ["recovered"]);
  assert.equal(f.state.offline, false);
  assert.equal(f.state.error, null);
  assert.equal(f.state.loading, false);
  assert.equal(f.timers.size, 0);
});
