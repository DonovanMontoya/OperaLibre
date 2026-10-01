import assert from "node:assert/strict";
import test from "node:test";
import { loadHook } from "./hookHarness.ts";
import * as reliability from "../src/reliability.ts";
import * as seekIntent from "../src/progressSeekIntent.ts";

type TrackFixture = { id: string; durationSeconds: number | null };
function controlsFor(tracks: TrackFixture[]) {
  const values = new Map<string, string>();
  Object.assign(globalThis, { window: { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  } } });
  const ref = <T>(current: T) => ({ current });
  const noop = () => {};
  const book = { id: "book", durationSeconds: null, tracks };
  const seeks: Array<{ trackId: string; positionSeconds: number }> = [];
  const controls = loadHook("usePlaybackControls", {
    "./reliability": reliability,
    "./progressSeekIntent": seekIntent,
    "./api": { getServerStorageKey: () => "server" },
    "./offlinePlayback": { playbackRestoreBookAfterAction: (_prior: unknown, id: string) => id },
    "./formatting": {
      durationFromTracks: () => null,
      trackOffsetSeconds: (_book: unknown, index: number) => tracks.slice(0, index)
        .reduce((sum, track) => sum + (track.durationSeconds ?? 0), 0)
    },
    "./playbackGain": {}, "./bookVolume": {}, "./carPlay": {}, "./playbackPending": {},
    "./nativeAudio": {}, "./native": {}, "./nativeAudioStartup": {}, "./playbackSpeed": {}, "./appStorage": {}
  })({
    selectedBook: book, playbackBook: null, currentTrack: null, audioRef: ref(null),
    currentUser: { id: "reader" }, playbackTouchedRef: ref(false),
    playbackActionVersionRef: ref(0), resumeAutoplayPendingRef: ref(false),
    resumeReconciliationBookIdRef: ref(null), restoredProgressBookId: ref(null),
    setRestoredPlaybackBookId: noop, intentionalSeekGenerationRef: ref(new Map()),
    intentionalSeekTargetRef: ref(new Map()), explicitSessionStartBookIdRef: ref(null),
    setPlaybackBookId: noop, setCurrentTrackId: noop, setPendingSeek: (seek: typeof seeks[number]) => seeks.push(seek),
    setPosition: noop, playWhenTrackLoads: ref(false), wantsAutoplayRef: ref(false),
    persistProgress: async () => {}, setNativePlayerView: noop, native: false
  });
  return { book, controls, seeks };
}

for (const duration of [null, 0]) {
  test(`whole-book start keeps the first track with duration ${duration}`, () => {
    const f = controlsFor([{ id: "first", durationSeconds: duration }, { id: "second", durationSeconds: 1200 }]);
    f.controls.seekBookPositionInBook(f.book, 0);
    assert.deepEqual(f.seeks, [{ trackId: "first", positionSeconds: 0 }]);
  });

  test(`an unknown middle track keeps its exact start boundary (${duration})`, () => {
    const f = controlsFor([{ id: "first", durationSeconds: 1200 },
      { id: "second", durationSeconds: duration }, { id: "third", durationSeconds: 1200 }]);
    f.controls.seekBookPositionInBook(f.book, 1200);
    assert.deepEqual(f.seeks, [{ trackId: "second", positionSeconds: 0 }]);
    // An explicit track checkpoint must still honor its ID rather than
    // remap an approximate whole-book offset across the missing duration.
    assert.deepEqual(reliability.resolveProgressLocation(f.book.tracks, {
      trackId: "third", positionSeconds: 30, bookPositionSeconds: 1230
    }), { trackId: "third", positionSeconds: 30 });
    assert.deepEqual(reliability.resolveProgressLocation(f.book.tracks, {
      trackId: "second", positionSeconds: 30, bookPositionSeconds: 1230
    }), { trackId: "second", positionSeconds: 30 });
  });
}

test("known exact-end seeks still retain the final track's full duration", () => {
  const f = controlsFor([{ id: "first", durationSeconds: 1800 }, { id: "second", durationSeconds: 1800 }]);
  f.controls.seekBookPositionInBook(f.book, 3600);
  assert.deepEqual(f.seeks, [{ trackId: "second", positionSeconds: 1800 }]);
});
