import assert from "node:assert/strict";
import test from "node:test";
import { readGamesEnabled, writeGamesEnabled } from "../src/gamePreferences.ts";

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: () => value,
    setItem: (_key: string, nextValue: string) => { value = nextValue; },
    removeItem: () => { value = null; }
  };
}

test("games are enabled unless explicitly disabled", () => {
  assert.equal(readGamesEnabled(memoryStorage()), true);
  assert.equal(readGamesEnabled(memoryStorage("false")), false);
  assert.equal(readGamesEnabled(memoryStorage("yes")), true);
  assert.equal(readGamesEnabled(memoryStorage("true")), true);
  assert.equal(readGamesEnabled({
    getItem: () => { throw new Error("Storage unavailable"); },
    setItem: () => {},
    removeItem: () => {}
  }), true);
});

test("the games preference can be disabled and enabled again", () => {
  const storage = memoryStorage();
  writeGamesEnabled(false, storage);
  assert.equal(readGamesEnabled(storage), false);
  writeGamesEnabled(true, storage);
  assert.equal(readGamesEnabled(storage), true);
});
