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
    native?: boolean;
    deviceBooks?: ReturnType<typeof book>[];
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
  const deviceBooks = options.deviceBooks ?? [];
  const dependencies = {
    react: { useCallback: (fn: unknown) => fn, useRef: ref },
    "./localLibrary": { backfillDeviceLibraryMetadata: noop, getDeviceBooks: () => deviceBooks, getDeviceProgress: () => null,
      removeDeviceBook: async (id: string) => { deviceBooks.splice(deviceBooks.findIndex(book => book.id === id), 1); },
      mergeDeviceAndServerBooks: (books: ReturnType<typeof book>[], local: ReturnType<typeof book>[]) => [...books, ...local],
      migrateDeviceLibraryFileExtensions: noop },
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
    localMode: options.localMode ?? false, native: options.native ?? false, nativeAudioRef: ref(false), nativeAudio: false,
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
  return { library, refresh, state, timers, replays, run, startRetry, common, dependencies,
    setCachedLibrary: (books: ReturnType<typeof book>[]) => { cachedLibrary = books; } };
}

for (const outcome of ["success", "failure"] as const) {
  test(`a rescan supersedes an in-flight reconnect ${outcome}`, async () => {
    const old = deferred<ReturnType<typeof book>[]>();
    let attempts = 0;
    const f = fixture(() => {
      attempts++;
      if (attempts === 1) return Promise.reject(unreachable());
      return attempts === 2 ? old.promise : Promise.resolve([book("fresh")]);
    }, async () => [book("fresh")]);
    await f.library.loadBooks();
    const retry = f.startRetry();
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
    });
    await f.library.loadBooks();
    const olderCache = serverBooks;
    serverBooks = [...serverBooks, book("new")];
    await f.refresh.refreshLibrary();
    f.setCachedLibrary(olderCache);
    f.state.selected = "new";
    f.state.playback = "new";
    reachable = false;
    await f.refresh.refreshLibrary();
    assert.deepEqual(f.state.books, serverBooks);
    assert.equal(f.state.selected, "new");
    assert.equal(f.state.playback, "new");
    assert.equal(f.state.offline, true);
    assert.equal(f.state.error, "Library rescan failed.");
    assert.equal(f.state.loading, false);
    assert.equal(f.timers.size, 0);
  });
}

test("a network-failed rescan leaves the existing reconnect scheduled", async () => {
  let reachable = false;
  const f = fixture(async () => {
    if (!reachable) throw unreachable();
    return [book("recovered")];
  }, async () => { throw unreachable(); });
  await f.library.loadBooks();
  const previousTimers = [...f.timers.keys()];
  assert.equal(previousTimers.length, 1);
  await f.refresh.refreshLibrary();
  assert.deepEqual([...f.timers.keys()], previousTimers);
  reachable = true;
  await f.startRetry();
  assert.deepEqual(f.state.books.map(book => book.id), ["recovered"]);
  assert.equal(f.state.offline, false);
  assert.equal(f.state.error, null);
  assert.equal(f.timers.size, 0);
});

const serverProgress: Progress = {
  bookId: "book", trackId: "book-track", positionSeconds: 100, bookPositionSeconds: 100,
  durationSeconds: 1_000, updatedAt: "1790769600000"
};
const localProgress = reliability.pendingProgress({
  ...serverProgress, positionSeconds: 160, bookPositionSeconds: 160, updatedAt: "2026-09-30T12:01:00Z"
}, reliability.syncedProgress(serverProgress, "2026-09-30T12:00:00Z"));
const progressBook = book("book", serverProgress);

for (const registered of [false, true]) {
  test(`a rescan sends pending progress once ${registered ? "while a replay awaits cached progress" : "before the listing registers a replay"}`, async () => {
    const listing = deferred<ReturnType<typeof book>[]>();
    const readingCache = deferred<void>();
    const cached = deferred<Progress>();
    const writes: Progress[] = [];
    const receipts: Progress[] = [];
    let attempts = 0;
    const f = fixture(() => {
      attempts++;
      return !registered && attempts === 1 ? listing.promise : Promise.resolve([progressBook]);
    }, async () => [progressBook], {
      getCachedProgress: () => {
        readingCache.resolve();
        return registered ? cached.promise : Promise.resolve(localProgress);
      },
      saveProgress: async (_id, progress) => {
        writes.push(progress);
        return { ...progress, accepted: true, updatedAt: "1790769660000" };
      },
      storeCanonicalServerProgress: (_book, receipt) => receipts.push(receipt)
    });
    const loading = f.library.loadBooks();
    if (registered) {
      await loading;
      await readingCache.promise;
      assert.equal(f.replays.current.size, 1);
    } else {
      assert.equal(f.replays.current.size, 0);
    }
    await f.refresh.refreshLibrary();
    cached.resolve(localProgress);
    listing.resolve([progressBook]);
    await loading;
    await Promise.all(f.replays.current.values());
    assert.equal(writes.length, 1);
    assert.equal(writes[0].bookPositionSeconds, 160);
    assert.equal(receipts.at(-1)?.bookPositionSeconds, 160);
    assert.equal(f.state.playback, null, "the unopened book's progress is replayed");
  });
}

test("a rescan preserves an in-flight replay receipt and orders a later offline update after it", async () => {
  const started = deferred<void>();
  const saved = deferred<Progress>();
  const writes: Progress[] = [];
  let cached = localProgress;
  const f = fixture(async () => [progressBook], async () => [progressBook], {
    getCachedProgress: async () => cached,
    saveProgress: async (_id, progress) => {
      writes.push(progress);
      if (writes.length === 1) { started.resolve(); return saved.promise; }
      return { ...progress, accepted: true, updatedAt: "1790769720000" };
    }
  });
  await f.library.loadBooks();
  await started.promise;
  cached = reliability.pendingProgress({
    ...localProgress, positionSeconds: 220, bookPositionSeconds: 220, updatedAt: "2026-09-30T12:02:00Z"
  }, reliability.syncedProgress(serverProgress, "2026-09-30T12:00:00Z"));
  await f.refresh.refreshLibrary();
  await f.library.loadBooks();
  assert.equal(writes.length, 1, "a successor waits for the in-flight save");
  const receipt = { ...writes[0], accepted: true, updatedAt: "1790769660000" };
  saved.resolve(receipt);
  await Promise.all(f.replays.current.values());
  assert.deepEqual(writes.map(progress => progress.bookPositionSeconds), [160, 220]);
  assert.equal(writes[1].baseUpdatedAt, receipt.updatedAt);
});

test("removing a device book while its server is offline removes its shelf row", async () => {
  let reachable = true;
  const local = { ...book("picked"), source: "device", deviceBookId: "picked" };
  const deviceBooks = [local];
  const f = fixture(async () => {
    if (!reachable) throw unreachable();
    return [book("remote")];
  }, async () => [], { native: true, deviceOnline: false, deviceBooks });
  await f.library.loadBooks();
  assert.deepEqual(f.state.books.map(book => book.id), ["remote", "picked"]);
  reachable = false;
  Object.assign(window, { confirm: () => true });
  const downloads = loadHook("useOfflineDownloads", {
    ...f.dependencies,
    react: { ...f.dependencies.react, useMemo: (fn: () => unknown) => fn(),
      useState: (value: unknown) => [value, noop], useEffect: noop },
    "./offlineReadiness": {},
    "./formatting": { errorMessage: (_error: unknown, message: string) => message }
  })({ ...f.common, books: f.state.books, loadBooks: f.library.loadBooks,
    capabilities: { downloads: true }, playbackBook: null, downloadStatus: null,
    setDownloadStatus: noop, setDownloadedBookIds: noop });
  await downloads.deleteDeviceBook(local);
  assert.equal(deviceBooks.length, 0);
  assert.deepEqual(f.state.books.map(book => book.id), ["remote"]);
  assert.equal(f.state.offline, true);
});

test("a local-only refresh loads the device shelf without contacting a server", async () => {
  const local = { ...book("picked"), source: "device" };
  const f = fixture(async () => { throw new Error("must not list server"); },
    async () => { throw new Error("must not rescan"); }, { localMode: true, native: true, deviceBooks: [local] });
  await f.refresh.refreshLibrary();
  assert.deepEqual(f.state.books, [local]);
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
