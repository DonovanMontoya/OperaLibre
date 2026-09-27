import assert from "node:assert/strict";
import test from "node:test";
import { applyNativePlaybackSettings, hasPlaybackSource, nativeLoadShouldAutoplay, nativeReattachPosition, nativeStartupPosition, startAfterListeners } from "../src/nativeAudioStartup.ts";

test("a restored seek wins over the uninitialized web clock", () => {
  assert.equal(nativeStartupPosition(3600, 0), 3600);
  assert.equal(nativeStartupPosition(0, 3600), 0);
  assert.equal(nativeStartupPosition(undefined, 120), 120);
  assert.equal(nativeStartupPosition(undefined, NaN), 0);
});

test("a queue rebuild after restore reloads where the previous attachment stopped", () => {
  // The restore's seek was consumed by the first load; the bare element reads 0.
  const detached = { bookId: "book", trackId: "track-1", positionSeconds: 9_812.4 };
  const startup = (pending: number | undefined) =>
    nativeStartupPosition(pending ?? nativeReattachPosition(detached, "book", "track-1"), 0);
  assert.equal(startup(undefined), 9_812.4);
  // A seek queued meanwhile still wins.
  assert.equal(startup(1_200), 1_200);
  // Another track or book starts from its own pending seek, not this clock.
  assert.equal(nativeReattachPosition(detached, "book", "track-2"), undefined);
  assert.equal(nativeReattachPosition(detached, "other", "track-1"), undefined);
  assert.equal(nativeReattachPosition(null, "book", "track-1"), undefined);
  assert.equal(nativeReattachPosition({ ...detached, positionSeconds: NaN }, "book", "track-1"), undefined);
});

test("native play and pause remain available with a source-free web clock", () => {
  const audio = { getAttribute: (_name: string) => null };
  // Both the shelf Play and the playing/paused transport gate use this check.
  assert.equal(hasPlaybackSource(audio, true, "https://server/track"), true);
  assert.equal(hasPlaybackSource(audio, false, "https://server/track"), false);
});

test("a replacement native load preserves a queued play request", () => {
  assert.equal(nativeLoadShouldAutoplay(false, true), true);
  assert.equal(nativeLoadShouldAutoplay(true, false), true);
  assert.equal(nativeLoadShouldAutoplay(false, false), false);
});

test("unresolved sources wait, and web fallback requires its real media source", () => {
  const empty = { getAttribute: (_name: string) => null };
  const loaded = { getAttribute: (_name: string) => "https://server/track" };
  assert.equal(hasPlaybackSource(null, true, "https://server/track"), false);
  assert.equal(hasPlaybackSource(empty, true, ""), false);
  assert.equal(hasPlaybackSource(loaded, false, "https://server/track"), true);
});


test("switching books initializes speed and volume before the first native load", () => {
  const settings = { rate: 1.75, volume: 0.4 };
  for (let book = 0; book < 3; book++) {
    const freshElement = { defaultPlaybackRate: 1, playbackRate: 1, volume: 1 };
    applyNativePlaybackSettings(freshElement, settings);
    assert.deepEqual(freshElement, { defaultPlaybackRate: 1.75, playbackRate: 1.75, volume: 0.4 });
  }
});

test("queue rebuilds use the latest selected speed even after the element resets", () => {
  const audio = { defaultPlaybackRate: 1.75, playbackRate: 1, volume: 1 };
  applyNativePlaybackSettings(audio, { rate: 1.25, volume: 0.3 });
  assert.deepEqual(audio, { defaultPlaybackRate: 1.25, playbackRate: 1.25, volume: 0.3 });
});

test("native loading waits for every listener, including a failed registration", async () => {
  const events: string[] = [];
  let resolveState!: () => void;
  let rejectError!: (error: Error) => void;
  const started = startAfterListeners([
    new Promise<void>((resolve) => { resolveState = resolve; }).then(() => { events.push("state listener"); }),
    new Promise<void>((_, reject) => { rejectError = reject; })
  ], () => true, () => events.push("load"));
  await Promise.resolve();
  assert.deepEqual(events, []);
  resolveState();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["state listener"]);
  rejectError(new Error("registration failed"));
  await started;
  assert.deepEqual(events, ["state listener", "load"]);
});

test("a detached attachment never starts loading", async () => {
  let loads = 0;
  await startAfterListeners([Promise.resolve()], () => false, () => { loads += 1; });
  assert.equal(loads, 0);
});
