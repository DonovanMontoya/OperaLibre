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
    queuedProgressSaves: ref(new Map()), setIsPlaying: noop, setNativePlayerSheet: noop, setNativePlayerView: noop,
    showMediaClock: noop, wantsAutoplayRef: ref(false)
  };
  function write(progress: Progress) { reliability.writeProgressCheckpoint(storage, "server", "reader", progress); }
  function checkpoint() { return reliability.readProgressCheckpoint(storage, "server", "reader", "book")!; }
  async function restore() {
    loadHook("usePlaybackRestore", dependencies)(options);
    effects.forEach(effect => effect());
    await completed;
  }
  return { server, local, book, writes, seeks, canonical, dependencies, options, restore, write, checkpoint, storage };
}

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
