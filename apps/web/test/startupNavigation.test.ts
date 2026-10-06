import assert from "node:assert/strict";
import test from "node:test";
import { loadHook } from "./hookHarness.ts";
import * as startup from "../src/startup.ts";
import * as reliability from "../src/reliability.ts";
import * as nativeTabs from "../src/nativeTabs.ts";

const ref = <T>(current: T) => ({ current });
const noop = () => {};
const react = {
  useCallback: (fn: unknown) => fn,
  useRef: ref,
  useEffect: noop,
  useState: (initial: unknown) => [initial, noop]
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(saved: string | null = "playing", selected = "browsed") {
  const cache = deferred<any[]>();
  const live = deferred<any[]>();
  const cachedApplied = deferred<void>();
  let tab = "shelf";
  let selection: string | null = selected;
  let playback = saved;
  let bridgeReady = false;
  let ready = false;
  const visible: string[] = [];
  const navigation = loadHook("useStartupNavigation", { react: {
    ...react, useState: (initial: string) => [initial, (next: any) => {
      tab = typeof next === "function" ? next(tab) : next;
    }]
  } })({});
  const chrome = loadHook("useNativeChrome", {
    react, "./nativeTabs": nativeTabs,
    "./useNativeTabs": { useNativeTabs: (state: any) => {
      if (bridgeReady && state.visible) visible.push(state.selected);
      return { ready: bridgeReady, shown: bridgeReady && state.visible };
    } }
  });
  const paint = () => chrome({ startupViewReady: ready, native: true, nativeTab: tab,
    capabilities: {}, currentUser: {}, brokenLibationAccounts: [], shellRef: ref(null),
    miniPlayerRef: ref(null), readalongOpen: false, readerClosing: false });
  const options = {
    audioRef: ref(null), currentUser: { id: "fixture" }, initialLibraryHydrated: ref(false),
    isOperaLibre: false, libraryRequestGenerationRef: ref(0), libraryRetryTimerRef: ref(null),
    loadBooksRef: ref(noop), localMode: false, native: true, nativeAudioRef: ref(true),
    nativePlaybackPlayingRef: ref(false), reconcileServerBookGains: noop,
    setBooks: noop, setError: noop, setIsLoading: (loading: boolean) => { if (!loading) cachedApplied.resolve(); },
    setIsOffline: noop, setLibationBooks: noop, setLibationBooksLoaded: noop,
    setNativeTab: navigation.setStartupTab, startupNavigationOverridden: navigation.startupNavigationOverridden,
    setPlaybackBookId: (update: any) => { playback = update(playback); },
    setSelectedBookId: (update: any) => { selection = typeof update === "function" ? update(selection) : update; },
    setStartupViewReady: (value: boolean) => { ready = value; },
    startupNavigationResolved: ref(false), startupViewReadyRef: ref(false), storeCanonicalServerProgress: noop,
    libraryProgressReplaysRef: ref(new Map()), resumeReconciliationBookIdRef: ref(null)
  };
  const load = loadHook("useLibrary", {
    react, "./startup": startup, "./reliability": reliability, "./progressSeekIntent": {},
    "./appStorage": { readStoredBookId: (_user: string, field: string) => field === "playbackBookId" ? saved : selected,
      withoutCachedBookGains: (books: unknown) => books },
    "./localLibrary": { migrateDeviceLibraryFileExtensions: async () => {}, backfillDeviceLibraryMetadata: async () => {},
      getDeviceBooks: () => [], mergeDeviceAndServerBooks: (books: unknown) => books },
    "./offline": { getCachedLibrary: () => cache.promise, cacheLibrary: async () => {} },
    "./api": { getBooks: () => live.promise, isServerNotReadyError: () => false }
  })(options).loadBooks;
  return { options, load, cache, live, cachedApplied, paint, visible,
    connect: () => { bridgeReady = true; paint(); },
    restore: () => { ready = true; options.startupViewReadyRef.current = true; paint(); },
    tap: (next: string) => { navigation.setNativeTab(next); paint(); },
    state: () => ({ tab, selection, playback }) };
}
const playing = { id: "playing", tracks: [{ id: "track", durationSeconds: 600 }], progress: { status: "inProgress" } };
const browsed = { id: "browsed", tracks: [] };

for (const connectAt of ["before-cache", "during-restore", "after-restore"]) {
  for (const saved of ["playing", null]) {
    test(`first visible tab is final: bridge ${connectAt}, saved playback ${saved}`, async () => {
      const f = fixture(saved);
      if (connectAt === "before-cache") f.connect();
      const loading = f.load();
      f.cache.resolve([playing, browsed]);
      await f.cachedApplied.promise;
      f.paint();
      if (connectAt === "during-restore") f.connect();
      if (saved) {
        assert.deepEqual(f.visible, []);
        assert.equal(f.state().selection, "playing");
      }
      f.restore();
      if (connectAt === "after-restore") f.connect();
      f.live.resolve([playing, browsed]);
      await loading;
      f.paint();
      assert.ok(f.visible.length > 0);
      assert.ok(f.visible.every(tab => tab === (saved ? "reading" : "shelf")), JSON.stringify(f.visible));
    });
  }
}

test("cached Reading removed before restore never becomes a visible tab", async () => {
  const f = fixture();
  f.connect();
  const loading = f.load();
  f.cache.resolve([playing, browsed]);
  await f.cachedApplied.promise;
  f.paint();
  assert.deepEqual(f.visible, []);
  f.live.resolve([browsed]);
  await loading;
  f.paint();
  assert.deepEqual(f.visible, ["shelf"]);
});

for (const tapAt of ["before-cache", "during-restore"]) {
  for (const tab of ["shelf", "settings", "reading"]) {
    test(`${tab} navigation ${tapAt} survives restoration and book disappearance`, async () => {
      const f = fixture();
      const loading = f.load();
      if (tapAt === "before-cache") f.tap(tab);
      f.cache.resolve([playing, browsed]);
      await f.cachedApplied.promise;
      if (tapAt === "during-restore") f.tap(tab);
      assert.equal(f.state().tab, tab);
      if (tapAt === "before-cache") assert.equal(f.state().selection, "browsed");
      f.live.resolve([browsed]);
      await loading;
      f.restore();
      f.connect();
      assert.deepEqual(f.visible, [tab]);
    });
  }
}

test("empty definitive launch opens Shelf without waiting for playback", async () => {
  const f = fixture("missing");
  f.connect();
  const loading = f.load();
  f.cache.resolve([]);
  f.live.resolve([]);
  await loading;
  f.paint();
  assert.deepEqual(f.visible, ["shelf"]);
});

test("active native playback survives a finished library summary and resume", async () => {
  const f = fixture();
  f.options.nativePlaybackPlayingRef.current = true;
  const loading = f.load();
  f.cache.resolve([playing]);
  await f.cachedApplied.promise;
  f.restore();
  f.tap("settings");
  f.live.resolve([{ ...playing, progress: { status: "finished" } }]);
  await loading;
  f.connect();
  assert.equal(f.state().playback, "playing");
  assert.deepEqual(f.visible, ["settings"]);
});
