import assert from "node:assert/strict";
import test from "node:test";
import { applyNativePlaybackSettings, hasPlaybackSource, nativeStartupPosition } from "../src/nativeAudioStartup.ts";

test("a restored seek wins over the uninitialized web clock", () => {
  assert.equal(nativeStartupPosition(3600, 0), 3600);
  assert.equal(nativeStartupPosition(0, 3600), 0);
  assert.equal(nativeStartupPosition(undefined, 120), 120);
  assert.equal(nativeStartupPosition(undefined, NaN), 0);
});


test("native play and pause remain available with a source-free web clock", () => {
  const audio = { getAttribute: (_name: string) => null };
  // Both the shelf Play and the playing/paused transport gate use this check.
  assert.equal(hasPlaybackSource(audio, true, "https://server/track"), true);
  assert.equal(hasPlaybackSource(audio, false, "https://server/track"), false);
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
