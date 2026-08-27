import assert from "node:assert/strict";
import test from "node:test";
import { DARK_MODE_STORAGE_KEY, readDarkMode, writeDarkMode } from "../src/appearance.ts";

function memoryStorage(initialValue: string | null = null) {
  const values = new Map<string, string>();
  if (initialValue !== null) values.set(DARK_MODE_STORAGE_KEY, initialValue);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
}

test("dark mode is off unless explicitly enabled", () => {
  assert.equal(readDarkMode(memoryStorage()), false);
  assert.equal(readDarkMode(memoryStorage("false")), false);
  assert.equal(readDarkMode(memoryStorage("true")), true);
});

test("dark mode choice is persisted", () => {
  const storage = memoryStorage();
  writeDarkMode(storage, true);
  assert.equal(storage.getItem(DARK_MODE_STORAGE_KEY), "true");
  writeDarkMode(storage, false);
  assert.equal(storage.getItem(DARK_MODE_STORAGE_KEY), "false");
});
