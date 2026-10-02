import assert from "node:assert/strict";
import test from "node:test";
import { loadHook } from "./hookHarness.ts";
import { library } from "./performance/fixtures.ts";
import * as carLibrary from "../src/carLibrary.ts";
import type { Book } from "../src/types.ts";

test("paused artwork replacement and removal publish new CarPlay snapshots without per-second progress writes", async () => {
  const slots: any[] = [];
  const effects: Array<() => void> = [];
  let index = 0;
  const useState = (initial: any) => {
    const slot = index++;
    if (!(slot in slots)) slots[slot] = initial;
    return [slots[slot], () => {}];
  };
  const useMemo = (compute: () => any) => { index++; return compute(); };
  const useEffect = (effect: () => (() => void) | void, deps: unknown[]) => {
    const slot = index++;
    const previous = slots[slot];
    if (!previous || deps.some((dep, i) => dep !== previous.deps[i])) {
      effects.push(() => { previous?.cleanup?.(); slots[slot] = {deps, cleanup:effect()}; });
    }
  };
  const timers = new Map<number, () => void>();
  let timerId = 0;
  Object.assign(globalThis, {
    window: {setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => timers.delete(id)},
    document: {addEventListener() {}, removeEventListener() {}}
  });
  const snapshots: carLibrary.CarLibrarySnapshot[] = [];
  let received!: () => void;
  const hook = loadHook("useCarPlay", {
    react: {useState, useRef: (value: unknown) => useState({current:value})[0], useMemo, useEffect},
    "./carPlay": {supportsCarPlay: () => true, beginCarLibrarySession() {},
      addCarPlayListener: async () => null, getCarPlayState: async () => null,
      syncCarLibrary: async (snapshot: carLibrary.CarLibrarySnapshot) => { snapshots.push(snapshot); received(); }},
    "./api": {getServerStorageKey: () => "server", mediaUrl: (url: string) => url},
    "./bookVolume": {BOOK_GAIN_DEFAULT:1}, "./carLibrary.ts": carLibrary,
    "./offline": {getOfflineCoverUrl: async () => null, getOfflineTrackUrl: async () => null},
    "./reliability": {}, "./progressSeekIntent": {}
  });
  let books: Book[] = [{...library(1)[0], coverArtUrl:"/cover?v=old", hasCoverOverride:true}];
  const booksRef = {current:books};
  const props = {booksRef, bookGains:{}, bookIdsKey:books[0].id, currentUser:{id:"owner"},
    downloadedBookIds:new Set<string>(), speed:1};
  const render = () => {
    index = 0; booksRef.current = books;
    hook({...props, books});
    effects.splice(0).forEach(effect => effect());
  };
  const flushSnapshot = async () => {
    const done = new Promise<void>(resolve => { received = resolve; });
    const callbacks = [...timers.values()]; timers.clear();
    assert.equal(callbacks.length, 1, "one debounced snapshot is scheduled");
    callbacks.forEach(callback => callback());
    await done;
  };
  render(); await flushSnapshot();
  books = [{...books[0], coverArtUrl:"/cover?v=new"}];
  render(); await flushSnapshot();
  assert.equal(snapshots.at(-1)!.books[0].artworkUrl, "/cover?v=new");
  books = [{...books[0], coverArtUrl:null, hasCoverOverride:false}];
  render(); await flushSnapshot();
  assert.equal(snapshots.at(-1)!.books[0].artworkUrl, undefined);
  books = [{...books[0], progress:{...books[0].progress!, bookPositionSeconds:1}}];
  render();
  assert.equal(timers.size, 0, "ordinary playback still uses minute buckets");
  assert.equal(snapshots.length, 3);
});
