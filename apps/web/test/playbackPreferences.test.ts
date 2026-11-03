import assert from "node:assert/strict";
import test from "node:test";
import {
  readBookPreviewsEnabled,
  readContinueReadingAutoplay,
  readPlayerVisualizer,
  writeBookPreviewsEnabled,
  writeContinueReadingAutoplay,
  writePlayerVisualizer
} from "../src/playbackPreferences.ts";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
}

test("Continue Reading opens paused unless autoplay is explicitly enabled", () => {
  for (const value of [null, "false", "invalid", "true"]) {
    assert.equal(readContinueReadingAutoplay({ getItem: () => value, setItem: () => {} }), value === "true");
  }
});

test("Continue Reading autoplay can be enabled and disabled on this device", () => {
  const storage = memoryStorage();
  writeContinueReadingAutoplay(true, storage);
  assert.equal(readContinueReadingAutoplay(storage), true);
  writeContinueReadingAutoplay(false, storage);
  assert.equal(readContinueReadingAutoplay(storage), false);
});

test("blocked storage falls back to paused opening and does not prevent toggling", () => {
  const storage = {
    getItem: () => { throw new Error("Storage unavailable"); },
    setItem: () => { throw new Error("Storage unavailable"); }
  };
  assert.equal(readContinueReadingAutoplay(storage), false);
  assert.doesNotThrow(() => writeContinueReadingAutoplay(true, storage));
});

test("audio previews stay on unless this device turned them off", () => {
  for (const value of [null, "true", "invalid", "false"]) {
    assert.equal(readBookPreviewsEnabled({ getItem: () => value, setItem: () => {} }), value !== "false");
  }
  const blocked = {
    getItem: () => { throw new Error("Storage unavailable"); },
    setItem: () => { throw new Error("Storage unavailable"); }
  };
  assert.equal(readBookPreviewsEnabled(blocked), true);
  assert.doesNotThrow(() => writeBookPreviewsEnabled(false, blocked));
});

test("audio previews can be turned off and back on", () => {
  const storage = memoryStorage();
  writeBookPreviewsEnabled(false, storage);
  assert.equal(readBookPreviewsEnabled(storage), false);
  writeBookPreviewsEnabled(true, storage);
  assert.equal(readBookPreviewsEnabled(storage), true);
});

test("the player visualizer is off unless a known style was chosen on this device", () => {
  const storage = memoryStorage();
  assert.equal(readPlayerVisualizer(storage), "off");
  writePlayerVisualizer("halo", storage);
  assert.equal(readPlayerVisualizer(storage), "halo");
  storage.values.set("operalibre.player.visualizer", "lasers");
  assert.equal(readPlayerVisualizer(storage), "off");
  const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readPlayerVisualizer(blocked), "off");
  assert.doesNotThrow(() => writePlayerVisualizer("blocks", blocked));
});
