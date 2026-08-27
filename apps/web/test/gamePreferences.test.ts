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

test("games are hidden until explicitly enabled", () => {
  assert.equal(readGamesEnabled(memoryStorage()), false);
  assert.equal(readGamesEnabled(memoryStorage("false")), false);
  assert.equal(readGamesEnabled(memoryStorage("yes")), false);
  assert.equal(readGamesEnabled(memoryStorage("true")), true);
});

test("the games preference can be enabled and returned to its default", () => {
  const storage = memoryStorage();
  writeGamesEnabled(true, storage);
  assert.equal(readGamesEnabled(storage), true);
  writeGamesEnabled(false, storage);
  assert.equal(readGamesEnabled(storage), false);
});
