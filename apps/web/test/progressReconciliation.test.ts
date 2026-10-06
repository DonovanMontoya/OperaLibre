import assert from "node:assert/strict";
import test from "node:test";
import { loadHook } from "./hookHarness.ts";
import * as reliability from "../src/reliability.ts";
import * as carLibrary from "../src/carLibrary.ts";
import * as seekIntent from "../src/progressSeekIntent.ts";
import type { Progress } from "../src/types.ts";


function fixture() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
  const ref = <T>(current: T) => ({ current });
  const noop = () => {};
  const server: Progress = { bookId: "book", trackId: "track", positionSeconds: 1000,
    bookPositionSeconds: 1000, durationSeconds: 7200, updatedAt: "1790769600000" };
  const local = reliability.pendingProgress({ ...server, positionSeconds: 1060, bookPositionSeconds: 1060,
    updatedAt: "2026-09-30T11:56:00Z" }, reliability.syncedProgress(server, "2026-09-30T11:55:00Z"));
  const book = { id: "book", source: "server", tracks: [{ id: "track", durationSeconds: 7200 }], durationSeconds: 7200,
    progress: { ...server, status: "inProgress" } };
  const writes: Array<{ progress: Progress; options: any }> = [];
  const seeks: Array<{ trackId: string; positionSeconds: number }> = [];
  const canonical: Progress[] = [];
  const effects: Array<() => unknown> = [];
  const cleanups: Array<() => void> = [];
  let complete!: () => void;
  const completed = new Promise<void>(resolve => { complete = resolve; });
  const window = { localStorage: storage, setTimeout(callback: () => void, delay: number) {
    callback();
    if (delay === 0) complete();
    return 1;
  }, clearTimeout: noop };
  Object.assign(globalThis, { window, document: { visibilityState: "hidden" } });
  const dependencies = {
    react: { useEffect: (effect: () => unknown) => effects.push(effect), useCallback: (fn: unknown) => fn, useRef: ref },
    "./reliability": reliability,
    "./nativeAudio": { getNativeAudioRecovery: async () => null },
    "./appStorage": { nativeAudioRecoveryScope: () => "scope", readStoredBookId: () => null,
      withoutCachedBookGains: (books: unknown) => books },
    "./offline": { getCachedProgress: async () => null, getCachedLibrary: async () => [],
      cacheLibrary: async () => {}, cacheProgress: async () => {}, warnCacheFailure: () => noop },
    "./localLibrary": { getDeviceBooks: () => [], getDeviceProgress: () => null, saveDeviceProgress: noop,
      mergeDeviceAndServerBooks: (books: unknown) => books },
    "./api": { getServerStorageKey: () => "server", getProgress: async () => server,
      getBooks: async () => [book], getLibationBooks: async () => [], isServerNotReadyError: () => false,
      saveProgress: async (_book: string, progress: Progress, options: unknown) => {
        writes.push({ progress, options });
        return { ...server, trackId: progress.trackId, positionSeconds: progress.positionSeconds,
          bookPositionSeconds: progress.bookPositionSeconds, updatedAt: "1790769660000", accepted: true };
      } },
    "./progressSeekIntent": seekIntent,
    "./startup": { startupDestinationAfterLoad: () => ({}) },
    "./formatting": { trackOffsetSeconds: () => 0 }
  };
  const options: Record<string, any> = {
    currentUser: { id: "reader" }, playbackBook: book, playbackBookKey: "book", nativeAudio: false,
    acknowledgedServerPositionRef: ref(new Map()), explicitSessionStartBookIdRef: ref(null),
    overruledSaveRef: ref(new Map()), playCancelGenerationRef: ref(0), playWhenTrackLoads: ref(false),
    playbackActionVersionRef: ref(0), playbackTouchedRef: ref(false), progressMutationVersion: ref(0),
    restoredProgressBookId: ref(null), resumeAutoplayBookIdRef: ref(null), resumeAutoplayPendingRef: ref(false),
    resumeReconciliationBookIdRef: ref(null), startupProgressAppliedRef: ref(false), startupViewReadyRef: ref(true),
    scheduleStartupReveal: noop, setCurrentTrackId: noop, setDuration: noop, setPosition: noop,
    setRestoredPlaybackBookId: noop, setPendingSeek: (seek: any) => seeks.push(seek),
    storeCanonicalServerProgress: (_book: unknown, progress: Progress) => canonical.push(progress), updateBookProgress: noop,
    audioRef: ref({ currentTime: 0, duration: 7200, paused: true }), initialLibraryHydrated: ref(true),
    isOperaLibre: false, libraryRequestGenerationRef: ref(0), libraryRetryTimerRef: ref(null), loadBooksRef: ref(noop),
    localMode: false, native: false, nativeAudioRef: ref(false), nativePlaybackPlayingRef: ref(false),
    reconcileServerBookGains: noop, setBooks: noop, setError: noop, setIsLoading: noop, setIsOffline: noop,
    setLibationBooks: noop, setLibationBooksLoaded: noop, setNativeTab: noop, setPlaybackBookId: noop,
    setSelectedBookId: noop, setStartupViewReady: noop, startupNavigationResolved: ref(true),
    acknowledgedSeekGenerationRef: ref(new Map()), activeTrackIndex: 0, books: [book], currentTrack: book.tracks[0],
    foregroundAdoptInFlightRef: ref(false), intentionalSeekGenerationRef: ref(new Map()), intentionalSeekTargetRef: ref(new Map()),
    nativeForegroundSyncGateRef: ref({ generation: 0 }), pausePlayback: noop, pendingSeekRef: ref(null),
    playbackSessionVersion: ref(0), position: 0, progressSaveAbortController: ref(null), progressSaveDrainPromiseRef: ref(null),
    queuedProgressSaves: ref(new Map()), libraryProgressReplaysRef: ref(new Map()),
    setIsPlaying: noop, setNativePlayerSheet: noop, setNativePlayerView: noop,
    showMediaClock: noop, wantsAutoplayRef: ref(false)
  };
  function write(progress: Progress) { reliability.writeProgressCheckpoint(storage, "server", "reader", progress); }
  function checkpoint() { return reliability.readProgressCheckpoint(storage, "server", "reader", "book")!; }
  async function restore() {
    loadHook("usePlaybackRestore", dependencies)(options);
    effects.forEach(effect => {
      const cleanup = effect();
      if (typeof cleanup === "function") cleanups.push(cleanup as () => void);
    });
    await completed;
  }
  const cancelRestore = () => cleanups.forEach(cleanup => cleanup());
  return { server, local, book, writes, seeks, canonical, dependencies, options, restore, cancelRestore, write, checkpoint, storage };
}

function controlsFor(f: ReturnType<typeof fixture>) {
  f.options.setPendingSeek = (seek: any) => { f.seeks.push(seek); f.options.pendingSeekRef.current = seek; };
  return loadHook("usePlaybackControls", {
    ...f.dependencies,
    "./offlinePlayback": { playbackRestoreBookAfterAction: (_previous: unknown, id: string) => id },
    "./formatting": { durationFromTracks: () => 7200 },
    "./playbackGain": {}, "./bookVolume": {}, "./carPlay": {}, "./playbackPending": {},
    "./native": {}, "./nativeAudioStartup": {}, "./playbackSpeed": {}
  })({ ...f.options, playbackBook: null, persistProgress: () => {} });
}

for (const store of ["journal", "cache", "device"] as const) {
  for (const online of [false, true]) {
    for (const newerNative of [false, true]) {
      test(`native restore preserves ${store} legacy ordering ${online ? "online" : "offline"} with ${newerNative ? "newer" : "older"} native recovery`, async () => {
        const f = fixture();
        const legacy = { ...f.server, positionSeconds: 3600, bookPositionSeconds: 3600,
          updatedAt: "2026-09-30T12:30:00Z" };
        if (store === "journal") f.write(legacy);
        if (store === "cache") f.dependencies["./offline"].getCachedProgress = async () => legacy;
        if (store === "device") {
          Object.assign(f.book, { deviceBookId: "device-book" });
          f.dependencies["./localLibrary"].getDeviceProgress = () => ({ ...legacy, bookId: "device-book", trackId: "device-track" });
          f.dependencies["./localLibrary"].getDeviceBooks = () => [{ id: "device-book", tracks: [{ id: "device-track" }] }];
        }
        f.options.nativeAudio = true;
        f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
          trackId: "track", positionSeconds: newerNative ? 5400 : 1800, bookPositionSeconds: newerNative ? 5400 : 1800,
          durationSeconds: 7200, updatedAt: Date.parse(newerNative ? "2026-09-30T12:45:00Z" : "2026-09-30T12:00:00Z")
        });
        if (!online) f.dependencies["./api"].getProgress = async () => { throw new Error("offline"); };
        await f.restore();
        const expected = newerNative ? 5400 : 3600;
        assert.equal(f.seeks[0].positionSeconds, expected);
        if (online) {
          assert.equal(f.writes.length, 1);
          assert.equal(f.writes[0].progress.bookPositionSeconds, expected);
        } else {
          assert.deepEqual(f.writes, []);
        }
      });
    }
  }
}

for (const store of ["journal", "cache", "device"] as const) {
  test(`native recovery compares ${store} acknowledgement recording time, not the faster server clock`, async () => {
    const f = fixture();
    const acknowledged = reliability.syncedProgress({ ...f.server, updatedAt: "2026-09-30T13:00:00Z" }, "2026-09-30T11:55:00Z");
    if (store === "journal") f.write(acknowledged);
    if (store === "cache") f.dependencies["./offline"].getCachedProgress = async () => acknowledged;
    if (store === "device") {
      Object.assign(f.book, { deviceBookId: "device-book" });
      f.dependencies["./localLibrary"].getDeviceProgress = () => ({ ...acknowledged, bookId: "device-book", trackId: "device-track" });
      f.dependencies["./localLibrary"].getDeviceBooks = () => [{ id: "device-book", tracks: [{ id: "device-track" }] }];
    }
    f.options.nativeAudio = true;
    f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
      trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
      updatedAt: Date.parse("2026-09-30T12:00:00Z")
    });
    await f.restore();
    assert.equal(f.seeks[0].positionSeconds, 1800);
    assert.equal(f.writes[0].progress.baseUpdatedAt, acknowledged.updatedAt);
    assert.equal(f.writes[0].progress.bookPositionSeconds, 1800);
  });
}

for (const store of ["cache", "device"] as const) {
  for (const pending of [false, true]) {
    for (const newerNative of [false, true]) {
      test(`superseded legacy ${store} cannot hide ${newerNative ? "newer" : "older"} native recovery behind a ${pending ? "pending" : "synced"} journal`, async () => {
        const f = fixture();
        const synced = reliability.syncedProgress({ ...f.server, updatedAt: "2026-09-30T13:01:00Z" }, "2026-09-30T11:56:00Z");
        const journal = pending
          ? reliability.pendingProgress({ ...f.server, positionSeconds: 1200, bookPositionSeconds: 1200,
              updatedAt: "2026-09-30T11:58:00Z" }, synced)
          : synced;
        f.write(journal);
        const stale = { ...f.server, updatedAt: "2026-09-30T13:00:00Z" };
        if (store === "cache") f.dependencies["./offline"].getCachedProgress = async () => stale;
        if (store === "device") {
          Object.assign(f.book, { deviceBookId: "device-book" });
          f.dependencies["./localLibrary"].getDeviceProgress = () => ({ ...stale, bookId: "device-book", trackId: "device-track" });
          f.dependencies["./localLibrary"].getDeviceBooks = () => [{ id: "device-book", tracks: [{ id: "device-track" }] }];
        }
        f.dependencies["./api"].getProgress = async () => { throw new Error("offline"); };
        f.options.nativeAudio = true;
        f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
          trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
          updatedAt: Date.parse(newerNative ? "2026-09-30T12:00:00Z" : "2026-09-30T11:55:00Z")
        });
        await f.restore();
        assert.equal(f.seeks[0].positionSeconds, newerNative ? 1800 : journal.positionSeconds);
        assert.deepEqual(f.writes, []);
      });
    }
  }
}

test("a fresh chapter selection uses a newer shelf revision without requiring restore", async () => {
  const f = fixture();
  const prior = reliability.syncedProgress(f.server, "2026-09-30T12:00:00Z");
  f.write(prior);
  const refreshed = { ...f.server, positionSeconds: 2500, bookPositionSeconds: 2500, updatedAt: "1790769720000" };
  Object.assign(f.book.progress, refreshed);
  await loadHook("useLibrary", f.dependencies)(f.options).loadBooks();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.checkpoint().updatedAt, prior.updatedAt);
  controlsFor(f).seekBookPositionInBook(f.book, 1800);
  assert.equal(f.options.explicitSessionStartBookIdRef.current, "book");
  f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
    f.writes.push({ progress, options });
    return progress.baseUpdatedAt === refreshed.updatedAt
      ? { ...refreshed, ...progress, updatedAt: "1790769840000", accepted: true }
      : { ...refreshed, accepted: false };
  };
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  await sync.persistProgress();
  assert.equal(f.writes[0].progress.baseUpdatedAt, refreshed.updatedAt);
  assert.equal(f.writes[0].options.intentionalSeek, true);
  assert.equal(f.checkpoint().positionSeconds, 1800);
  assert.equal(f.checkpoint().accepted, true);
});

for (const updatedAt of ["2026-09-30T11:00:00Z", "2026-09-30T15:00:00Z"]) {
  test(`a new seek never uses a locally summarized ${updatedAt} device timestamp as its server base`, async () => {
    const f = fixture();
    const local = reliability.pendingProgress({ ...f.local, updatedAt }, reliability.syncedProgress(f.server));
    f.write(local);
    Object.assign(f.book.progress, reliability.summarizeBookProgress(f.book, local));
    controlsFor(f).seekBookPositionInBook(f.book, 1800);
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    await sync.persistProgress();
    assert.equal(f.writes[0].progress.baseUpdatedAt, f.server.updatedAt);
    assert.equal(f.writes[0].options.intentionalSeek, true);
  });
}

test("an already journaled seek cannot borrow a later shelf revision on retry", async () => {
  const f = fixture();
  f.write(reliability.syncedProgress(f.server));
  controlsFor(f).seekBookPositionInBook(f.book, 1800);
  f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
    f.writes.push({ progress, options });
    throw new Error("offline");
  };
  const refs: Array<{ current: unknown }> = [];
  let refIndex = 0;
  f.dependencies.react.useRef = (value: unknown) => refs[refIndex++] ?? (refs[refIndex - 1] = { current: value });
  const render = () => {
    refIndex = 0;
    return loadHook("useProgressSync", f.dependencies)(f.options);
  };
  let sync = render();
  await sync.persistProgress();
  const refreshed = { ...f.server, positionSeconds: 2500, bookPositionSeconds: 2500, updatedAt: "1790769720000" };
  Object.assign(f.book.progress, refreshed);
  sync = render();
  await sync.persistProgress();
  assert.equal(f.writes[1].progress.baseUpdatedAt, f.server.updatedAt);
  assert.equal(f.writes[1].options.intentionalSeek, true, "the original seek still has retry authorization");
  controlsFor(f).seekBookPositionInBook(f.book, 2000);
  await sync.persistProgress();
  assert.equal(f.writes[2].progress.baseUpdatedAt, refreshed.updatedAt);
  assert.equal(f.writes[2].progress.positionSeconds, 2000);
});

test("restore uploads a newer offline checkpoint even when the device clock is slow", async () => {
  const f = fixture();
  f.write(f.local);
  await f.restore();
  assert.equal(f.seeks[0].positionSeconds, 1060);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].progress.bookPositionSeconds, 1060);
  assert.equal(f.writes[0].progress.baseUpdatedAt, f.server.updatedAt);
  assert.equal(f.canonical[0].bookPositionSeconds, 1060);
  assert.equal(f.options.playbackTouchedRef.current, false);
});

test("restore retries failed reads and opening an acknowledged position sends nothing", async () => {
  const f = fixture();
  f.write(reliability.syncedProgress(f.server, "2026-09-30T11:55:00Z"));
  let reads = 0;
  f.dependencies["./api"].getProgress = async () => {
    reads += 1;
    if (reads < 3) throw new Error("offline");
    return f.server;
  };
  await f.restore();
  assert.equal(reads, 3);
  assert.equal(f.seeks[0].positionSeconds, 1000);
  assert.deepEqual(f.writes, []);
});

test("an offline near-zero seek keeps its intent through slow-clock restoration", async () => {
  const f = fixture();
  f.write({ ...f.local, positionSeconds: 20, bookPositionSeconds: 20 });
  seekIntent.recordProgressSeekIntent(f.storage, "server", "reader", "book", 20,
    reliability.progressTimestamp(f.local.updatedAt));
  await f.restore();
  assert.equal(f.seeks[0].positionSeconds, 20);
  assert.equal(f.writes[0].options.intentionalSeek, true);
  assert.equal(f.writes[0].options.intentionalRegression, true);
});

test("library reconnect uploads dirty slow-clock progress without opening that book", async () => {
  const f = fixture();
  f.write(f.local);
  await loadHook("useLibrary", f.dependencies)(f.options).loadBooks();
  // Finish the cache-read/save microtasks started by the library's independent reconciliation.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].progress.bookPositionSeconds, 1060);
  assert.equal(f.writes[0].progress.baseUpdatedAt, f.server.updatedAt);
});

test("untouched playback writes nothing and a pending seek persists its target", async () => {
  const f = fixture();
  f.options.restoredProgressBookId.current = "book";
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  await sync.persistProgress();
  assert.equal(f.checkpoint(), null);
  assert.deepEqual(f.writes, []);
  f.options.playbackTouchedRef.current = true;
  f.options.pendingSeekRef.current = { trackId: "track", positionSeconds: 1800 };
  await sync.persistProgress();
  assert.equal(f.writes[0].progress.positionSeconds, 1800);
  assert.equal(f.checkpoint().positionSeconds, 1800);
  assert.equal(f.checkpoint().syncStatus, "synced");
});

test("an acknowledged in-flight save rebases the queued edit without replacing its target", async () => {
  const f = fixture();
  f.options.restoredProgressBookId.current = "book";
  f.options.playbackTouchedRef.current = true;
  let respond!: (value: Progress) => void;
  const firstResponse = new Promise<Progress>(resolve => { respond = resolve; });
  f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
    f.writes.push({ progress, options });
    if (f.writes.length === 1) return firstResponse;
    return { ...f.server, ...progress, updatedAt: "1790769660001" };
  };
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  f.options.pendingSeekRef.current = { trackId: "track", positionSeconds: 1060 };
  const drain = sync.persistProgress();
  f.options.pendingSeekRef.current = { trackId: "track", positionSeconds: 1090 };
  void sync.persistProgress();
  assert.equal(f.checkpoint().positionSeconds, 1090);
  respond({ ...f.server, positionSeconds: 1060, bookPositionSeconds: 1060, updatedAt: "1790769660000", accepted: true });
  await drain;
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].progress.baseUpdatedAt, "1790769660000");
  assert.equal(f.writes[1].progress.positionSeconds, 1090);
  assert.equal(f.checkpoint().positionSeconds, 1090);
  assert.equal(f.checkpoint().syncStatus, "synced");
});

for (const durations of [[3600], [1800, 1800]]) {
  test(`the playback controls seek to the exact end across ${durations.length} tracks`, () => {
    const f = fixture();
    const noop = () => {};
    const book = { ...f.book, durationSeconds: 3600,
      tracks: durations.map((durationSeconds, index) => ({ id: `track-${index}`, durationSeconds })) };
    const controls = loadHook("usePlaybackControls", {
      ...f.dependencies,
      "./offlinePlayback": { playbackRestoreBookAfterAction: (_previous: unknown, id: string) => id },
      "./formatting": { durationFromTracks: () => 3600 },
      "./playbackGain": {}, "./bookVolume": {}, "./carPlay": {}, "./playbackPending": {},
      "./native": {}, "./nativeAudioStartup": {}, "./playbackSpeed": {}
    })({ ...f.options, playbackBook: null, persistProgress: noop });
    controls.seekBookPositionInBook(book, 3600);
    assert.deepEqual(f.seeks[0], { trackId: `track-${durations.length - 1}`, positionSeconds: durations[durations.length - 1] });
    assert.equal(f.options.intentionalSeekTargetRef.current.get("book"), 3600);
    assert.equal(f.options.explicitSessionStartBookIdRef.current, "book");
  });
}

test("a failed save leaves a durable dirty checkpoint with its original causal base", async () => {
  const f = fixture();
  f.options.restoredProgressBookId.current = "book";
  f.options.playbackTouchedRef.current = true;
  f.options.pendingSeekRef.current = { trackId: "track", positionSeconds: 1060 };
  f.dependencies["./api"].saveProgress = async () => { throw new Error("offline"); };
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  await sync.persistProgress();
  assert.equal(f.checkpoint().syncStatus, "pending");
  assert.equal(f.checkpoint().baseUpdatedAt, f.server.updatedAt);
  assert.equal(f.checkpoint().positionSeconds, 1060);
  f.options.pendingSeekRef.current = { trackId: "track", positionSeconds: 1090 };
  await sync.persistProgress();
  assert.equal(f.checkpoint().baseUpdatedAt, f.server.updatedAt);
  assert.equal(f.checkpoint().positionSeconds, 1090);
});

test("a restore response cannot overwrite listening recorded while its read was in flight", () => {
  const f = fixture();
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  f.write(f.local);
  sync.storeCanonicalServerProgress(f.book, f.server, null);
  assert.equal(f.checkpoint().syncStatus, "pending");
  assert.equal(f.checkpoint().positionSeconds, 1060);
  assert.equal(f.checkpoint().baseUpdatedAt, f.server.updatedAt);
});

test("a rejected same-position response never rebases a newer queued checkpoint", async () => {
  const f = fixture();
  f.options.restoredProgressBookId.current = "book";
  f.options.playbackTouchedRef.current = true;
  let respond!: (value: Progress) => void;
  const firstResponse = new Promise<Progress>(resolve => { respond = resolve; });
  f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
    f.writes.push({ progress, options });
    if (f.writes.length === 1) return firstResponse;
    return { ...f.server, positionSeconds: 1060, bookPositionSeconds: 1060, updatedAt: "1790769660000", accepted: false };
  };
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  f.options.pendingSeekRef.current = { trackId: "track", positionSeconds: 1060 };
  const drain = sync.persistProgress();
  f.options.pendingSeekRef.current = { trackId: "track", positionSeconds: 1090 };
  void sync.persistProgress();
  respond({ ...f.server, positionSeconds: 1060, bookPositionSeconds: 1060, updatedAt: "1790769660000", accepted: false });
  await drain;
  assert.equal(f.writes[1].progress.baseUpdatedAt, f.server.updatedAt);
  assert.equal(f.checkpoint().positionSeconds, 1060);
});

for (const nativeAudio of [false, true]) {
  test(`a rejected ${nativeAudio ? 'native' : 'web'} playhead never borrows the canonical base on the next tick`, async () => {
    const f = fixture();
    f.options.nativeAudio = nativeAudio;
    f.options.restoredProgressBookId.current = "book";
    f.options.playbackTouchedRef.current = true;
    f.options.audioRef.current.paused = false;
    f.options.nativePlaybackPlayingRef.current = true;
    f.options.audioRef.current.currentTime = 3600;
    f.write(reliability.syncedProgress(f.server));
    const rejected = { ...f.server, positionSeconds: 1800, bookPositionSeconds: 1800,
      updatedAt: "1790769660000", accepted: false };
    f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
      f.writes.push({ progress, options });
      return rejected;
    };
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    await sync.persistProgress();
    assert.equal(f.checkpoint().positionSeconds, 1800);
    assert.equal(f.checkpoint().baseUpdatedAt, f.server.updatedAt);
    assert.equal(f.checkpoint().acknowledgedUpdatedAt, rejected.updatedAt);
    f.options.audioRef.current.currentTime = 3610;
    await sync.persistProgress();
    assert.equal(f.writes[1].progress.baseUpdatedAt, f.server.updatedAt);
    assert.equal(f.writes[1].progress.positionSeconds, 3610);
    // A resumed optimistic player journals while its server read is pending,
    // and must retain the same rejected base even before it can send again.
    f.options.resumeReconciliationBookIdRef.current = "book";
    f.options.audioRef.current.currentTime = 3620;
    await sync.persistProgress();
    assert.equal(f.checkpoint().syncStatus, "pending");
    assert.equal(f.checkpoint().positionSeconds, 3620);
    assert.equal(f.checkpoint().baseUpdatedAt, f.server.updatedAt);
    f.options.resumeReconciliationBookIdRef.current = null;
    // A genuinely new deliberate seek is allowed to use the observed reply.
    f.options.intentionalSeekGenerationRef.current.set("book", 1);
    f.options.intentionalSeekTargetRef.current.set("book", 2400);
    f.options.pendingSeekRef.current = { trackId: "track", positionSeconds: 2400 };
    await sync.persistProgress();
    assert.equal(f.writes[2].progress.positionSeconds, 2400);
    assert.equal(f.writes[2].progress.baseUpdatedAt, rejected.updatedAt);
    assert.equal(f.writes[2].options.intentionalSeek, true);
  });
}

// The library's reconnect replay and the restore both send the offline
// checkpoint. Whichever answer lands first heals the journal; the second
// response must still move the player to the server's position.
for (const competingEdit of [false, true]) {
  test(`restore ${competingEdit ? "keeps a pending edit made" : "adopts the server after the journal was healed"} while its replay was rejected`, async () => {
    const f = fixture();
    f.write(f.local);
    const rejected = { ...f.server, positionSeconds: 1800, bookPositionSeconds: 1800,
      updatedAt: "1790769660000", accepted: false };
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
    f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
      f.writes.push({ progress, options });
      if (competingEdit) {
        f.write(reliability.pendingProgress({ ...f.server, positionSeconds: 1090, bookPositionSeconds: 1090,
          updatedAt: "2026-09-30T11:58:00Z" }, f.checkpoint()));
      } else {
        sync.storeCanonicalServerProgress(f.book, rejected, f.local);
      }
      return rejected;
    };
    await f.restore();
    assert.equal(f.writes.length, 1);
    if (competingEdit) {
      assert.equal(f.seeks[f.seeks.length - 1].positionSeconds, 1060);
      assert.equal(f.checkpoint().syncStatus, "pending");
      assert.equal(f.checkpoint().bookPositionSeconds, 1090);
    } else {
      assert.equal(f.seeks[f.seeks.length - 1].positionSeconds, 1800);
      assert.equal(f.checkpoint().syncStatus, "synced");
      assert.equal(f.checkpoint().bookPositionSeconds, 1800);
      // The first replay records the refusal; adopting its position consumes it.
      assert.equal(f.options.overruledSaveRef.current.has("book"), false);
    }
  });
}

// The usual reconnect: the library replay is accepted and heals the journal
// to the new revision at the same position, then the restore's duplicate
// replay is refused for its stale base. Nothing was overruled, so no marker
// may be left behind to make a later foreground return adopt the server.
test("a duplicate replay refused after an accepted one leaves no overruled marker", async () => {
  const f = fixture();
  f.write(f.local);
  const accepted = { ...f.server, positionSeconds: 1060, bookPositionSeconds: 1060, updatedAt: "1790769660000" };
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
  f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
    f.writes.push({ progress, options });
    f.write(reliability.syncedProgress(accepted, f.local.localUpdatedAt));
    return { ...accepted, accepted: false };
  };
  await f.restore();
  assert.equal(f.writes.length, 1);
  assert.equal(f.checkpoint().syncStatus, "synced");
  assert.equal(f.checkpoint().bookPositionSeconds, 1060);
  assert.equal(f.seeks[f.seeks.length - 1].positionSeconds, 1060);
  assert.equal(f.options.overruledSaveRef.current.has("book"), false);
});

for (const nativeAudio of [false, true]) {
  test(`a healed ${nativeAudio ? "native" : "web"} restore preserves subsequent offline listening on foreground return`, async () => {
    const f = fixture();
    f.options.nativeAudio = nativeAudio;
    f.options.nativeForegroundSyncGateRef.current.shouldDeferServerAdoption = () => false;
    f.write(f.local);
    const rejected = { ...f.server, positionSeconds: 1800, bookPositionSeconds: 1800,
      updatedAt: "1790769660000", accepted: false };
    let offline = false;
    f.dependencies["./api"].saveProgress = async () => {
      if (offline) throw new Error("offline");
      sync.storeCanonicalServerProgress(f.book, rejected, f.local);
      return rejected;
    };
    Object.assign(f.dependencies["./api"], { getFreshProgress: async () => ({ ...rejected, accepted: undefined }) });
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
    f.options.setPendingSeek = (seek: any) => { f.seeks.push(seek); f.options.pendingSeekRef.current = seek; };
    await f.restore();
    assert.equal(f.options.pendingSeekRef.current.positionSeconds, 1800);

    // The engine applies the restore, then listens further without a new seek.
    f.options.pendingSeekRef.current = null;
    f.options.playbackTouchedRef.current = true;
    f.options.audioRef.current.currentTime = 2000;
    offline = true;
    await sync.persistProgress();
    assert.equal(f.checkpoint().bookPositionSeconds, 2000);
    assert.equal(f.checkpoint().syncStatus, "pending");
    assert.equal(f.options.queuedProgressSaves.current.size, 0);
    const seeksBeforeForeground = f.seeks.length;
    offline = false;
    Object.assign(globalThis, { document: { visibilityState: "visible" } });
    await sync.foregroundProgressActionsRef.current.adoptNewerServerProgress();
    assert.equal(f.seeks.length, seeksBeforeForeground);
    assert.equal(f.checkpoint().bookPositionSeconds, 2000);
    assert.equal(f.checkpoint().syncStatus, "pending");
  });
}

for (const interruption of ["cancel", "action", "listening"] as const) {
  test(`a healed restore interrupted by ${interruption} retains conflict protection`, async () => {
    const f = fixture();
    f.write(f.local);
    const rejected = { ...f.server, positionSeconds: 1800, bookPositionSeconds: 1800,
      updatedAt: "1790769660000", accepted: false };
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
    f.dependencies["./api"].saveProgress = async () => {
      sync.storeCanonicalServerProgress(f.book, rejected, f.local);
      if (interruption === "cancel") f.cancelRestore();
      if (interruption === "action") f.options.playbackActionVersionRef.current += 1;
      if (interruption === "listening") f.options.progressMutationVersion.current += 1;
      return rejected;
    };
    await f.restore();
    assert.equal(f.seeks.at(-1)?.positionSeconds, 1060);
    assert.equal(f.checkpoint().baseUpdatedAt, f.server.updatedAt);
    assert.equal(f.options.overruledSaveRef.current.has("book"), true);
  });
}

test("cancelling restore before a position is staged preserves an earlier refusal", async () => {
  const f = fixture();
  f.write(f.local);
  f.options.overruledSaveRef.current.set("book", f.local);
  f.dependencies["./offline"].getCachedProgress = async () => {
    await Promise.resolve();
    f.cancelRestore();
    return null;
  };
  await f.restore();
  assert.equal(f.seeks.length, 0);
  assert.equal(f.options.overruledSaveRef.current.get("book"), f.local);
});

test("newer native recovery retains the rejected base until canonical restore is staged", async () => {
  const f = fixture();
  const rejected = reliability.syncedProgress({ ...f.server, positionSeconds: 1800, bookPositionSeconds: 1800,
    updatedAt: "1790769660000", accepted: false }, "2026-09-30T12:01:00Z");
  rejected.baseUpdatedAt = f.server.updatedAt;
  f.write(rejected);
  f.options.nativeAudio = true;
  f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
    trackId: "track", positionSeconds: 3610, bookPositionSeconds: 3610, durationSeconds: 7200,
    updatedAt: Date.parse("2026-09-30T12:02:00Z")
  });
  f.dependencies["./api"].getProgress = async () => rejected;
  f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
    f.writes.push({ progress, options });
    return rejected;
  };
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
  await f.restore();
  assert.equal(f.writes[0].progress.baseUpdatedAt, f.server.updatedAt);
  assert.equal(f.seeks[f.seeks.length - 1].positionSeconds, 1800);
  assert.equal(f.checkpoint().baseUpdatedAt, rejected.updatedAt);
});

for (const scenario of ["automatic", "replayed seek", "new seek"] as const) {
  test(`CarPlay ${scenario} preserves conflict ownership`, async () => {
    const f = fixture();
    const rejected = reliability.syncedProgress({ ...f.server, positionSeconds: 1800, bookPositionSeconds: 1800,
      updatedAt: "1790769660000", accepted: false }, "2026-09-30T12:01:00Z");
    rejected.baseUpdatedAt = f.server.updatedAt;
    f.write(rejected);
    const session = { bookId: "book", trackId: "track", positionSeconds: 3600, bookPositionSeconds: 3600,
      durationSeconds: 7200, finished: false, intentionalRegression: scenario !== "automatic",
      updatedAt: Date.parse(scenario === "replayed seek" ? "2026-09-30T12:00:00Z" : "2026-09-30T12:02:00Z") };
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    const car = loadHook("useCarPlay", {
      ...f.dependencies,
      react: { ...f.dependencies.react, useMemo: (fn: () => unknown) => fn(), useState: (value: unknown) => [value, () => {}] },
      "./carLibrary.ts": carLibrary, "./bookVolume": { BOOK_GAIN_DEFAULT: 1 },
      "./carPlay": { supportsCarPlay: () => true, setCarPlaybackOwner: () => {},
        getCarPlayState: async () => ({ sessions: [session] }), acknowledgeCarSessions: async () => {} }
    })({ ...f.options, booksRef: { current: [f.book] }, downloadedBookIds: new Set(), bookGains: {},
      flushProgressSaveQueue: sync.flushProgressSaveQueue });
    await car.adoptCarPlaybackState();
    assert.equal(f.writes.length, 1);
    assert.equal(f.writes[0].progress.baseUpdatedAt,
      scenario === "new seek" ? rejected.updatedAt : f.server.updatedAt);
    assert.equal(f.writes[0].options.intentionalSeek, scenario === "new seek");
  });
}

test("idle conflict adoption stages canonical position before advancing the playback base", async () => {
  const f = fixture();
  const rejected = { ...f.server, positionSeconds: 1800, bookPositionSeconds: 1800,
    updatedAt: "1790769660000", accepted: false };
  f.options.restoredProgressBookId.current = "book";
  f.options.playbackTouchedRef.current = true;
  f.options.audioRef.current.currentTime = 3600;
  f.write(reliability.syncedProgress(f.server));
  f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
    f.writes.push({ progress, options });
    return rejected;
  };
  Object.assign(f.dependencies["./api"], { getFreshProgress: async () => ({ ...rejected, accepted: undefined }) });
  f.options.setPendingSeek = (seek: any) => { f.seeks.push(seek); f.options.pendingSeekRef.current = seek; };
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  await sync.persistProgress();
  Object.assign(globalThis, { document: { visibilityState: "visible" } });
  await sync.foregroundProgressActionsRef.current.adoptNewerServerProgress();
  assert.equal(f.options.pendingSeekRef.current.positionSeconds, 1800);
  assert.equal(f.checkpoint().baseUpdatedAt, rejected.updatedAt);
  await sync.persistProgress();
  assert.equal(f.writes[1].progress.positionSeconds, 1800);
  assert.equal(f.writes[1].progress.baseUpdatedAt, rejected.updatedAt);
});

test("legacy unmarked local recovery is never mistaken for a server revision", async () => {
  const f = fixture();
  const legacy = { ...f.server, positionSeconds: 1060, bookPositionSeconds: 1060,
    updatedAt: "2026-09-30T12:02:00Z" };
  f.write(legacy);
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
  f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
    assert.equal(f.checkpoint().syncStatus, undefined);
    assert.equal(f.checkpoint().baseUpdatedAt, undefined);
    f.writes.push({ progress, options });
    return { ...f.server, positionSeconds: 1060, bookPositionSeconds: 1060,
      updatedAt: "1790769660000", accepted: true };
  };
  await f.restore();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].progress.baseUpdatedAt, undefined);
  assert.equal(f.checkpoint().syncStatus, "synced");
  assert.equal(f.checkpoint().baseUpdatedAt, "1790769660000");
});

for (const laterTrack of [false, true]) {
  for (const legacy of [false, true]) {
    for (const replayFails of [false, true]) {
      test(`a ${replayFails ? "failed" : "successful"} ${legacy ? "legacy" : "pending"} library replay cannot rewind newer native recovery ${laterTrack ? "across a track boundary" : "within a track"}`, async () => {
        const f = fixture();
        f.write(legacy ? { ...f.server, positionSeconds: 1060, bookPositionSeconds: 1060,
          updatedAt: "2026-09-30T12:01:00Z" } : f.local);
        if (laterTrack) f.book.tracks.push({ id: "next-track", durationSeconds: 7200 });
        const trackId = laterTrack ? "next-track" : "track";
        const bookPositionSeconds = laterTrack ? 9000 : 1800;
        f.options.nativeAudio = true;
        f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
          trackId, positionSeconds: 1800, bookPositionSeconds, durationSeconds: 7200,
          updatedAt: Date.parse("2026-09-30T12:05:00Z")
        });
        const sync = loadHook("useProgressSync", f.dependencies)(f.options);
        f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
        let server = f.server;
        let releaseOlder!: () => void;
        const olderReleased = new Promise<void>(resolve => { releaseOlder = resolve; });
        let olderStarted!: () => void;
        const replayStarted = new Promise<void>(resolve => { olderStarted = resolve; });
        f.dependencies["./api"].getProgress = async () => server;
        f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
          f.writes.push({ progress, options });
          if (f.writes.length === 1) {
            olderStarted();
            await olderReleased;
            if (replayFails) throw new Error("offline");
          } else {
            // Let the library store its acknowledgement before recovery answers.
            await new Promise(resolve => setImmediate(resolve));
          }
          if ((progress.baseUpdatedAt !== undefined && progress.baseUpdatedAt !== server.updatedAt)
            || (progress.baseUpdatedAt === undefined
              && reliability.progressTimestamp(progress.updatedAt) + 300_000 < reliability.progressTimestamp(server.updatedAt))) {
            return { ...server, accepted: false };
          }
          server = { ...server, ...progress, updatedAt: String(Math.max(Date.parse("2026-09-30T13:00:00Z"), Number(server.updatedAt) + 1)), accepted: true };
          return server;
        };
        await loadHook("useLibrary", f.dependencies)(f.options).loadBooks();
        await replayStarted;
        const restoring = f.restore();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.seeks[0], { trackId, positionSeconds: 1800 }, "local recovery must not wait for the save");
        releaseOlder();
        await restoring;
        assert.deepEqual(f.seeks.at(-1), { trackId, positionSeconds: 1800 });
        assert.equal(f.checkpoint().bookPositionSeconds, bookPositionSeconds);
        assert.equal(server.bookPositionSeconds, bookPositionSeconds);
        assert.equal(f.options.libraryProgressReplaysRef.current.size, 0);
      });
    }
  }
}

test("a library refresh during native restore leaves its newer checkpoint to restore", async () => {
  const f = fixture();
  f.write(f.local);
  f.options.nativeAudio = true;
  f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
    trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
    updatedAt: Date.parse("2026-09-30T12:05:00Z")
  });
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
  let releaseRead!: (progress: Progress) => void;
  const reading = new Promise<Progress>(resolve => { releaseRead = resolve; });
  let readStarted!: () => void;
  const started = new Promise<void>(resolve => { readStarted = resolve; });
  f.dependencies["./api"].getProgress = () => { readStarted(); return reading; };
  const restoring = f.restore();
  await started;
  await loadHook("useLibrary", f.dependencies)(f.options).loadBooks();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.writes, []);
  releaseRead(f.server);
  await restoring;
  assert.equal(f.writes.length, 1);
  assert.equal(f.checkpoint().bookPositionSeconds, 1800);
  assert.equal(f.options.libraryProgressReplaysRef.current.size, 0);
});

for (const store of ["legacy journal", "cache"] as const) {
  test(`an older ${store} replay acknowledged before restore cannot hide native listening`, async () => {
    const f = fixture();
    const local = store === "legacy journal"
      ? { ...f.server, positionSeconds: 1060, bookPositionSeconds: 1060, updatedAt: "2026-09-30T12:01:00Z" }
      : f.local;
    if (store === "legacy journal") f.write(local);
    else f.dependencies["./offline"].getCachedProgress = async () => local;
    f.options.nativeAudio = true;
    f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
      trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
      updatedAt: Date.parse("2026-09-30T12:05:00Z")
    });
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
    await loadHook("useLibrary", f.dependencies)(f.options).loadBooks();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.checkpoint().localUpdatedAt, local.localUpdatedAt ?? local.updatedAt);
    assert.equal(f.options.libraryProgressReplaysRef.current.size, 0);
    Object.assign(f.book.progress, f.checkpoint());
    await f.restore();
    assert.equal(f.seeks[0].positionSeconds, 1800);
    assert.equal(f.checkpoint().bookPositionSeconds, 1800);
  });
}

test("a rejected library replay cannot authorize native recovery over another revision", async () => {
  const f = fixture();
  f.write(f.local);
  f.options.nativeAudio = true;
  f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
    trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
    updatedAt: Date.parse("2026-09-30T12:05:00Z")
  });
  const remote = { ...f.server, positionSeconds: 1200, bookPositionSeconds: 1200,
    updatedAt: "1790769900000", accepted: false };
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
  let releaseReplay!: () => void;
  const pending = new Promise<void>(resolve => { releaseReplay = resolve; });
  let replayStarted!: () => void;
  const started = new Promise<void>(resolve => { replayStarted = resolve; });
  f.dependencies["./api"].getProgress = async () => remote;
  f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
    f.writes.push({ progress, options });
    if (f.writes.length === 1) { replayStarted(); await pending; }
    return remote;
  };
  await loadHook("useLibrary", f.dependencies)(f.options).loadBooks();
  await started;
  const restoring = f.restore();
  await new Promise(resolve => setImmediate(resolve));
  releaseReplay();
  await restoring;
  assert.equal(f.writes[1].progress.baseUpdatedAt, f.server.updatedAt);
  assert.equal(f.seeks.at(-1)!.positionSeconds, 1200);
  assert.equal(f.checkpoint().bookPositionSeconds, 1200);
});

test("cancelling recovery during a library replay preserves a subsequent local edit", async () => {
  const f = fixture();
  f.write(f.local);
  f.options.nativeAudio = true;
  f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
    trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
    updatedAt: Date.parse("2026-09-30T12:05:00Z")
  });
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
  let releaseReplay!: () => void;
  const pending = new Promise<void>(resolve => { releaseReplay = resolve; });
  let replayStarted!: () => void;
  const started = new Promise<void>(resolve => { replayStarted = resolve; });
  f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
    f.writes.push({ progress, options });
    replayStarted();
    await pending;
    return { ...progress, updatedAt: "1790769900000", accepted: true };
  };
  await loadHook("useLibrary", f.dependencies)(f.options).loadBooks();
  await started;
  const restoring = f.restore();
  await new Promise(resolve => setImmediate(resolve));
  f.cancelRestore();
  f.write(reliability.pendingProgress({ ...f.local, positionSeconds: 2200, bookPositionSeconds: 2200,
    updatedAt: "2026-09-30T12:06:00Z" }, f.checkpoint()));
  releaseReplay();
  await restoring;
  assert.equal(f.writes.length, 1);
  assert.equal(f.seeks.length, 1);
  assert.equal(f.checkpoint().bookPositionSeconds, 2200);
  assert.equal(f.checkpoint().baseUpdatedAt, "1790769900000");
  assert.equal(f.options.libraryProgressReplaysRef.current.size, 0);
});

for (const laterTrack of [false, true]) {
  test(`cache replay with a different synced journal preserves native recovery ${laterTrack ? "across tracks" : "within a track"}`, async () => {
    const f = fixture();
    const journal = reliability.syncedProgress(f.server, "2026-09-30T11:55:00Z");
    f.write(journal);
    f.dependencies["./offline"].getCachedProgress = async () => f.local;
    if (laterTrack) f.book.tracks.push({ id: "next-track", durationSeconds: 7200 });
    const trackId = laterTrack ? "next-track" : "track";
    const bookPositionSeconds = laterTrack ? 9000 : 1800;
    f.options.nativeAudio = true;
    f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
      trackId, positionSeconds: 1800, bookPositionSeconds, durationSeconds: 7200,
      updatedAt: Date.parse("2026-09-30T12:05:00Z")
    });
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
    let server = f.server;
    let releaseReplay!: () => void;
    const pending = new Promise<void>(resolve => { releaseReplay = resolve; });
    let replayStarted!: () => void;
    const started = new Promise<void>(resolve => { replayStarted = resolve; });
    f.dependencies["./api"].getProgress = async () => server;
    f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
      f.writes.push({ progress, options });
      if (f.writes.length === 1) { replayStarted(); await pending; }
      if (progress.baseUpdatedAt !== server.updatedAt) return { ...server, accepted: false };
      server = { ...server, ...progress, updatedAt: String(Number(server.updatedAt) + 1), accepted: true };
      return server;
    };
    await loadHook("useLibrary", f.dependencies)(f.options).loadBooks();
    await started;
    const restoring = f.restore();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.seeks[0], { trackId, positionSeconds: 1800 });
    releaseReplay();
    await restoring;
    assert.deepEqual(f.seeks.at(-1), { trackId, positionSeconds: 1800 });
    assert.equal(server.bookPositionSeconds, bookPositionSeconds);
    assert.equal(f.checkpoint().bookPositionSeconds, bookPositionSeconds);
  });
}

test("a failed earlier replay does not prevent the next library replay", async () => {
  const f = fixture();
  f.write(f.local);
  f.options.libraryProgressReplaysRef.current.set("book", Promise.reject(new Error("cache unavailable")));
  await loadHook("useLibrary", f.dependencies)(f.options).loadBooks();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].progress.positionSeconds, 1060);
  assert.equal(f.options.libraryProgressReplaysRef.current.size, 0);
});

for (const restoreFirst of [false, true]) {
  test(`a superseding library load preserves the earlier save acknowledgement with restore ${restoreFirst ? "before" : "after"} refresh`, async () => {
    const f = fixture();
    f.write(f.local);
    f.options.nativeAudio = true;
    f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
      trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
      updatedAt: Date.parse("2026-09-30T12:05:00Z")
    });
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
    let server = f.server;
    let releaseReplay!: () => void;
    const pending = new Promise<void>(resolve => { releaseReplay = resolve; });
    let replayStarted!: () => void;
    const started = new Promise<void>(resolve => { replayStarted = resolve; });
    f.dependencies["./api"].getProgress = async () => server;
    f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
      f.writes.push({ progress, options });
      if (f.writes.length === 1) { replayStarted(); await pending; }
      if (progress.baseUpdatedAt !== server.updatedAt) return { ...server, accepted: false };
      server = { ...server, ...progress, updatedAt: String(Number(server.updatedAt) + 1), accepted: true };
      return server;
    };
    const library = loadHook("useLibrary", f.dependencies)(f.options);
    await library.loadBooks();
    await started;
    let restoring: Promise<void>;
    if (restoreFirst) {
      restoring = f.restore();
      await new Promise(resolve => setImmediate(resolve));
      await library.loadBooks();
    } else {
      await library.loadBooks();
      restoring = f.restore();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(f.seeks[0].positionSeconds, 1800);
    releaseReplay();
    await restoring;
    assert.equal(f.seeks.at(-1)!.positionSeconds, 1800);
    assert.equal(server.bookPositionSeconds, 1800);
    assert.equal(f.writes.length, 2);
  });
}

for (const refresh of ["slow", "failed", "cancelled restore"] as const) {
  test(`an accepted replay keeps its revision through a ${refresh} refresh without a successor replay`, async () => {
    const f = fixture();
    f.write(f.local);
    f.options.nativeAudio = refresh !== "cancelled restore";
    f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
      trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
      updatedAt: Date.parse("2026-09-30T12:05:00Z")
    });
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
    let server = f.server;
    let releaseReplay!: () => void;
    const pending = new Promise<void>(resolve => { releaseReplay = resolve; });
    let replayStarted!: () => void;
    const started = new Promise<void>(resolve => { replayStarted = resolve; });
    let releaseShelf!: () => void;
    const pendingShelf = new Promise<void>(resolve => { releaseShelf = resolve; });
    let shelfStarted!: () => void;
    const fetchingShelf = new Promise<void>(resolve => { shelfStarted = resolve; });
    let loads = 0;
    f.dependencies["./api"].getBooks = async () => {
      if (++loads === 2) {
        shelfStarted();
        if (refresh === "failed") throw new Error("offline");
        if (refresh === "slow") await pendingShelf;
      }
      return [{ ...f.book, progress: { ...server, status: "inProgress" } }];
    };
    f.dependencies["./api"].getProgress = async () => server;
    f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
      f.writes.push({ progress, options });
      if (f.writes.length === 1) { replayStarted(); await pending; }
      if (progress.baseUpdatedAt !== server.updatedAt) return { ...server, accepted: false };
      server = { ...server, ...progress, updatedAt: String(Number(server.updatedAt) + 1), accepted: true };
      return server;
    };
    const library = loadHook("useLibrary", f.dependencies)(f.options);
    await library.loadBooks();
    await started;
    const replay = f.options.libraryProgressReplaysRef.current.get("book");
    const restoring = refresh === "cancelled restore" ? f.restore() : null;
    const refreshed = library.loadBooks();
    await fetchingShelf;
    if (refresh !== "slow") await refreshed;
    if (restoring) f.options.playbackActionVersionRef.current += 1;
    releaseReplay();
    await replay;
    await restoring;
    assert.equal(f.checkpoint().baseUpdatedAt, server.updatedAt);
    assert.equal(f.checkpoint().syncStatus, "synced");
    assert.equal(f.options.libraryProgressReplaysRef.current.size, 0);
    releaseShelf();
    await refreshed;
    if (restoring) {
      f.write(reliability.pendingProgress({ ...f.local, positionSeconds: 1500,
        bookPositionSeconds: 1500, updatedAt: "2026-09-30T12:10:00Z" }, f.checkpoint()));
      await library.loadBooks();
      await new Promise(resolve => setImmediate(resolve));
      await f.options.libraryProgressReplaysRef.current.get("book");
    } else {
      await f.restore();
      assert.equal(f.seeks.at(-1)!.positionSeconds, 1800);
    }
    assert.equal(server.bookPositionSeconds, restoring ? 1500 : 1800);
    assert.equal(f.writes.length, 2, "the accepted older checkpoint must not be replayed again");
  });
}

for (const cacheReplay of [false, true]) {
  for (const editDuringReplay of [false, true]) {
    test(`settled library replays retain their accepted baseline from ${cacheReplay ? "cache" : "journal"} ${editDuringReplay ? "with a later local edit" : "before opening the book"}`, async () => {
      const f = fixture();
      if (cacheReplay) {
        f.write(reliability.syncedProgress(f.server, "2026-09-30T11:55:00Z"));
        f.dependencies["./offline"].getCachedProgress = async () => f.local;
      } else f.write(f.local);
      f.options.nativeAudio = true;
      f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
        trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
        updatedAt: Date.parse("2026-09-30T12:05:00Z")
      });
      const sync = loadHook("useProgressSync", f.dependencies)(f.options);
      f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
      let server = f.server;
      let releaseReplay!: () => void;
      const pending = new Promise<void>(resolve => { releaseReplay = resolve; });
      let replayStarted!: () => void;
      const started = new Promise<void>(resolve => { replayStarted = resolve; });
      f.dependencies["./api"].getProgress = async () => server;
      f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
        f.writes.push({ progress, options });
        if (f.writes.length === 1) { replayStarted(); await pending; }
        if (progress.baseUpdatedAt !== server.updatedAt) return { ...server, accepted: false };
        server = { ...server, ...progress, updatedAt: String(Number(server.updatedAt) + 1), accepted: true };
        return server;
      };
      const library = loadHook("useLibrary", f.dependencies)(f.options);
      await library.loadBooks();
      await started;
      if (editDuringReplay) f.write(reliability.pendingProgress({ ...f.local, positionSeconds: 1200,
        bookPositionSeconds: 1200, updatedAt: "2026-09-30T12:00:00Z" }, f.local));
      await library.loadBooks();
      const replay = f.options.libraryProgressReplaysRef.current.get("book");
      releaseReplay();
      await replay;
      if (editDuringReplay) {
        assert.equal(f.writes[1].progress.baseUpdatedAt, String(Number(f.server.updatedAt) + 1));
      } else {
        assert.equal(f.writes.length, 1, "an acknowledged checkpoint must not be sent twice");
      }
      assert.equal(f.checkpoint().syncStatus, "synced");
      assert.equal(f.checkpoint().positionSeconds, editDuringReplay ? 1200 : 1060);
      await f.restore();
      assert.equal(f.seeks.at(-1)!.positionSeconds, 1800);
      assert.equal(server.bookPositionSeconds, 1800);
    });
  }

}

for (const store of ["none", "legacy"] as const) {
  test(`native recovery with ${store} journal keeps timestamp protection for an unobserved revision`, async () => {
    const f = fixture();
    if (store === "legacy") f.write({ ...f.local, syncStatus: undefined, baseUpdatedAt: undefined,
      acknowledgedUpdatedAt: undefined, localUpdatedAt: undefined });
    const remote = { ...f.server, positionSeconds: 1200, bookPositionSeconds: 1200,
      updatedAt: String(Date.parse("2026-09-30T13:00:00Z")) };
    Object.assign(f.book.progress, remote);
    f.options.nativeAudio = true;
    f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
      trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
      updatedAt: Date.parse("2026-09-30T12:05:00Z")
    });
    f.dependencies["./api"].getProgress = async () => remote;
    f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
      f.writes.push({ progress, options });
      const rejected = progress.baseUpdatedAt !== undefined
        ? progress.baseUpdatedAt !== remote.updatedAt
        : reliability.progressTimestamp(progress.updatedAt) + 300_000 < reliability.progressTimestamp(remote.updatedAt);
      return rejected ? { ...remote, accepted: false }
        : { ...remote, ...progress, updatedAt: String(Number(remote.updatedAt) + 1), accepted: true };
    };
    await f.restore();
    assert.equal(f.writes[0].progress.baseUpdatedAt, undefined);
    assert.equal(f.seeks.at(-1)!.positionSeconds, 1200);
  });
}

test("acknowledged native recovery is not uploaded again on the next cold start", async () => {
  const f = fixture();
  f.write(f.local);
  const recovery = { trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800,
    durationSeconds: 7200, updatedAt: Date.parse("2026-09-30T12:05:00Z") };
  f.options.nativeAudio = true;
  f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => recovery;
  const sync = loadHook("useProgressSync", f.dependencies)(f.options);
  f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
  await f.restore();
  const next = fixture();
  next.write(f.checkpoint());
  Object.assign(next.book.progress, f.checkpoint());
  next.options.nativeAudio = true;
  next.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => recovery;
  next.dependencies["./api"].getProgress = async () => f.checkpoint();
  await next.restore();
  assert.equal(next.seeks[0].positionSeconds, 1800);
  assert.deepEqual(next.writes, []);
});

for (const cacheReplay of [false, true]) {
  for (const crossTrack of [false, true]) {
    for (const rejected of [false, true]) {
      test(`restore joins ${rejected ? "a rejected" : "an accepted"} rebased later edit from ${cacheReplay ? "cache" : "journal"} ${crossTrack ? "across tracks" : "within a track"}`, async () => {
        const f = fixture();
        let cached = f.local;
        if (cacheReplay) {
          f.write(reliability.syncedProgress(f.server, "2026-09-30T11:55:00Z"));
          f.dependencies["./offline"].getCachedProgress = async () => cached;
        } else f.write(f.local);
        if (crossTrack) f.book.tracks.push({ id: "next-track", durationSeconds: 7200 });
        const trackId = crossTrack ? "next-track" : "track";
        const bookPositionSeconds = crossTrack ? 9000 : 1800;
        f.options.nativeAudio = true;
        f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
          trackId, positionSeconds: 1800, bookPositionSeconds, durationSeconds: 7200,
          updatedAt: Date.parse("2026-09-30T12:05:00Z")
        });
        const sync = loadHook("useProgressSync", f.dependencies)(f.options);
        f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
        let server = f.server;
        const releases: Array<() => void> = [];
        const starts: Array<() => void> = [];
        const started = [0, 1].map(i => new Promise<void>(resolve => { starts[i] = resolve; }));
        const pending = [0, 1].map(i => new Promise<void>(resolve => { releases[i] = resolve; }));
        f.dependencies["./api"].getProgress = async () => server;
        f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
          const i = f.writes.length;
          f.writes.push({ progress, options });
          if (i < 2) { starts[i](); await pending[i]; }
          if (i === 1 && rejected) {
            server = { ...server, positionSeconds: 1400, bookPositionSeconds: 1400,
              updatedAt: String(Number(server.updatedAt) + 1) };
            return { ...server, accepted: false };
          }
          if (progress.baseUpdatedAt !== server.updatedAt) return { ...server, accepted: false };
          server = { ...server, ...progress, updatedAt: String(Number(server.updatedAt) + 1), accepted: true };
          return server;
        };
        const library = loadHook("useLibrary", f.dependencies)(f.options);
        await library.loadBooks();
        await started[0];
        const edited = reliability.pendingProgress({ ...f.local, positionSeconds: 1200,
          bookPositionSeconds: 1200, updatedAt: "2026-09-30T12:00:00Z" }, f.local);
        if (cacheReplay) cached = edited;
        else f.write(edited);
        await library.loadBooks();
        releases[0]();
        await started[1];
        assert.equal(f.writes[1].progress.baseUpdatedAt, server.updatedAt);
        const restoring = f.restore();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(f.seeks[0], { trackId, positionSeconds: 1800 });
        releases[1]();
        await restoring;
        assert.deepEqual(f.seeks.at(-1), rejected
          ? { trackId: "track", positionSeconds: 1400 } : { trackId, positionSeconds: 1800 });
        assert.equal(server.bookPositionSeconds, rejected ? 1400 : bookPositionSeconds);
        if (rejected) assert.equal(f.writes[2].progress.baseUpdatedAt, String(Number(f.server.updatedAt) + 1));
      });
    }
  }
}

for (const cacheReplay of [false, true]) {
  test(`a superseding load acknowledges an unchanged legacy ${cacheReplay ? "cache" : "journal"} before checking the newer shelf`, async () => {
    const f = fixture();
    const legacy = { ...f.server, positionSeconds: 1060, bookPositionSeconds: 1060,
      updatedAt: "2026-09-30T12:01:00Z" };
    if (cacheReplay) {
      f.dependencies["./offline"].getCachedProgress = async () => legacy;
    } else f.write(legacy);
    f.options.nativeAudio = true;
    f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
      trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
      updatedAt: Date.parse("2026-09-30T12:05:00Z")
    });
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
    let server = f.server;
    let releaseReplay!: () => void;
    const pending = new Promise<void>(resolve => { releaseReplay = resolve; });
    let replayStarted!: () => void;
    const started = new Promise<void>(resolve => { replayStarted = resolve; });
    f.dependencies["./api"].getBooks = async () => [{ ...f.book, progress: { ...server, status: "inProgress" } }];
    f.dependencies["./api"].getProgress = async () => server;
    f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
      f.writes.push({ progress, options });
      if (progress.baseUpdatedAt !== undefined && progress.baseUpdatedAt !== server.updatedAt) {
        return { ...server, accepted: false };
      }
      server = { ...server, ...progress, updatedAt: String(Math.max(
        Date.parse("2026-09-30T13:00:00Z"), Number(server.updatedAt) + 1)), accepted: true };
      if (f.writes.length === 1) { replayStarted(); await pending; }
      return server;
    };
    const library = loadHook("useLibrary", f.dependencies)(f.options);
    await library.loadBooks();
    await started;
    await library.loadBooks();
    const replay = f.options.libraryProgressReplaysRef.current.get("book");
    releaseReplay();
    await replay;
    assert.equal(f.writes.length, 1);
    assert.equal(f.checkpoint().syncStatus, "synced");
    assert.equal(f.checkpoint().localUpdatedAt, legacy.updatedAt);
    await f.restore();
    assert.equal(f.seeks.at(-1)!.positionSeconds, 1800);
    assert.equal(server.bookPositionSeconds, 1800);
  });
}

for (const settled of [false, true]) {
  test(`a later unmarked checkpoint follows its own accepted replay with restore ${settled ? "after" : "during"} the later save`, async () => {
    const f = fixture();
    const legacy = { ...f.server, positionSeconds: 1060, bookPositionSeconds: 1060,
      updatedAt: "2026-09-30T12:01:00Z" };
    f.write(legacy);
    f.options.nativeAudio = true;
    f.dependencies["./nativeAudio"].getNativeAudioRecovery = async () => ({
      trackId: "track", positionSeconds: 1800, bookPositionSeconds: 1800, durationSeconds: 7200,
      updatedAt: Date.parse("2026-09-30T12:05:00Z")
    });
    const sync = loadHook("useProgressSync", f.dependencies)(f.options);
    f.options.storeCanonicalServerProgress = sync.storeCanonicalServerProgress;
    let server = f.server;
    const releases: Array<() => void> = [];
    const starts: Array<() => void> = [];
    const started = [0, 1].map(i => new Promise<void>(resolve => { starts[i] = resolve; }));
    const pending = [0, 1].map(i => new Promise<void>(resolve => { releases[i] = resolve; }));
    f.dependencies["./api"].getProgress = async () => server;
    f.dependencies["./api"].saveProgress = async (_book: string, progress: Progress, options: unknown) => {
      const i = f.writes.length;
      f.writes.push({ progress, options });
      if (i < 2) { starts[i](); await pending[i]; }
      const rejected = progress.baseUpdatedAt !== undefined
        ? progress.baseUpdatedAt !== server.updatedAt
        : reliability.progressTimestamp(progress.updatedAt) + 300_000 < reliability.progressTimestamp(server.updatedAt);
      if (rejected) return { ...server, accepted: false };
      server = { ...server, ...progress, updatedAt: String(Math.max(Date.parse("2026-09-30T13:00:00Z"),
        Number(server.updatedAt) + 1)), accepted: true };
      return server;
    };
    const library = loadHook("useLibrary", f.dependencies)(f.options);
    await library.loadBooks();
    await started[0];
    f.write({ ...legacy, positionSeconds: 1200, bookPositionSeconds: 1200, updatedAt: "2026-09-30T12:02:00Z" });
    await library.loadBooks();
    releases[0]();
    await started[1];
    const replay = f.options.libraryProgressReplaysRef.current.get("book");
    let restoring: Promise<void>;
    if (settled) {
      releases[1]();
      await replay;
      restoring = f.restore();
    } else {
      restoring = f.restore();
      await new Promise(resolve => setImmediate(resolve));
      releases[1]();
    }
    await restoring;
    assert.equal(f.seeks.at(-1)!.positionSeconds, 1800);
    assert.equal(f.checkpoint().positionSeconds, 1800);
    assert.equal(server.bookPositionSeconds, 1800);
  });
}
