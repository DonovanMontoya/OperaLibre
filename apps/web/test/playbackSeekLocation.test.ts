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
    clipPreviewBookIdRef: ref(null),
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

for (const checkpointOnly of [true, false]) {
  test(checkpointOnly ? "pause save failure leaves the native transport selected" :
    "a generic native pause failure still falls back without autoplay", async () => {
    const messages: string[] = [];
    const fallbacks: boolean[] = [];
    const playing: boolean[] = [];
    const nativePlaybackPlayingRef = { current: true };
    const playWhenTrackLoads = { current: true };
    const audio = { muted: true };
    const controls = loadHook("usePlaybackControls", {
      "./carPlay": { carPlaybackOwnsEngine: () => false },
      "./nativeAudio": { pauseNativeAudio: async () => {
        throw Object.assign(new Error("pause error"), { code: checkpointOnly ? "CHECKPOINT_WRITE_FAILED" : "OTHER" });
      } },
      "./formatting": { errorMessage: (error: Error) => error.message },
      "./reliability": {}, "./progressSeekIntent": {}, "./api": {}, "./offlinePlayback": {},
      "./playbackGain": {}, "./bookVolume": {}, "./playbackPending": {}, "./native": {},
      "./nativeAudioStartup": {}, "./playbackSpeed": {}, "./appStorage": {}
    })({
      nativeAudio: true, nativePlaybackPlayingRef, playWhenTrackLoads,
      setPlayPending: () => {}, setIsPlaying: (value: boolean) => playing.push(value),
      setNativeAudioFailed: (value: boolean) => fallbacks.push(value),
      setPlaybackError: (message: string) => messages.push(message)
    });
    controls.pausePlayback(audio);
    await Promise.resolve();
    assert.equal(nativePlaybackPlayingRef.current, false);
    assert.deepEqual(playing, [false]);
    assert.deepEqual(messages, ["pause error"]);
    assert.deepEqual(fallbacks, checkpointOnly ? [] : [true]);
    assert.equal(audio.muted, checkpointOnly);
    assert.equal(playWhenTrackLoads.current, checkpointOnly);
  });
}
