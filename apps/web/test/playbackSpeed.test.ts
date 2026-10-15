import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPlaybackSpeed,
  normalizePlaybackSpeed,
  PLAYBACK_SPEED_STORAGE_KEY,
  readPlaybackSpeed,
  writePlaybackSpeed
} from "../src/playbackSpeed.ts";
import { memoryStorage } from "./memoryStorage.ts";

test("playback speed supports exact 0.05x adjustments", () => {
  assert.equal(normalizePlaybackSpeed(1.03), 1.05);
  assert.equal(normalizePlaybackSpeed(1.17), 1.15);
  assert.equal(normalizePlaybackSpeed(1.149999999), 1.15);
});

test("playback speed stays within the supported range", () => {
  assert.equal(normalizePlaybackSpeed(0.7), 0.75);
  assert.equal(normalizePlaybackSpeed(2.05), 2);
});

test("granular playback speed is restored and written consistently", () => {
  const storage = memoryStorage(PLAYBACK_SPEED_STORAGE_KEY, "1.15");
  assert.equal(readPlaybackSpeed(storage), 1.15);

  writePlaybackSpeed(storage, 1.1);
  assert.equal(storage.getItem(PLAYBACK_SPEED_STORAGE_KEY), "1.1");
});

test("invalid stored speeds fall back to normal", () => {
  assert.equal(readPlaybackSpeed(memoryStorage(PLAYBACK_SPEED_STORAGE_KEY, "not-a-number")), 1);
  assert.equal(readPlaybackSpeed(memoryStorage(PLAYBACK_SPEED_STORAGE_KEY, "3")), 1);
  assert.equal(readPlaybackSpeed(memoryStorage(PLAYBACK_SPEED_STORAGE_KEY, null)), 1);
});

test("playback speed labels omit unnecessary trailing zeroes", () => {
  assert.equal(formatPlaybackSpeed(1), "1");
  assert.equal(formatPlaybackSpeed(1.1), "1.1");
  assert.equal(formatPlaybackSpeed(1.15), "1.15");
});
