import assert from "node:assert/strict";
import test from "node:test";
import { readContinueReadingAutoplay, writeContinueReadingAutoplay } from "../src/playbackPreferences.ts";

test("Continue Reading opens paused unless autoplay is explicitly enabled", () => {
  for (const value of [null, "false", "invalid", "true"]) {
    assert.equal(readContinueReadingAutoplay({ getItem: () => value, setItem: () => {} }), value === "true");
  }
});

test("Continue Reading autoplay can be enabled and disabled on this device", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
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
