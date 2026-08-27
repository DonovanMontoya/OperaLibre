import assert from "node:assert/strict";
import test from "node:test";
import {
  APPEARANCE_STORAGE_KEY,
  readAppearanceMode,
  resolveDarkMode,
  writeAppearanceMode
} from "../src/appearance.ts";

function memoryStorage(initialValue: string | null = null) {
  const values = new Map<string, string>();
  if (initialValue !== null) values.set(APPEARANCE_STORAGE_KEY, initialValue);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
}

test("an untouched install follows the system theme", () => {
  assert.equal(readAppearanceMode(memoryStorage()), "system");
  assert.equal(readAppearanceMode(memoryStorage("garbage")), "system");
});

test("the boolean values written by the old switch stay explicit choices", () => {
  assert.equal(readAppearanceMode(memoryStorage("true")), "dark");
  assert.equal(readAppearanceMode(memoryStorage("false")), "light");
});

test("each mode round-trips through storage", () => {
  for (const mode of ["light", "dark", "system"] as const) {
    const storage = memoryStorage();
    writeAppearanceMode(storage, mode);
    assert.equal(storage.getItem(APPEARANCE_STORAGE_KEY), mode);
    assert.equal(readAppearanceMode(storage), mode);
  }
});

test("system mode is the only one that listens to the device theme", () => {
  assert.equal(resolveDarkMode("dark", false), true);
  assert.equal(resolveDarkMode("dark", true), true);
  assert.equal(resolveDarkMode("light", false), false);
  assert.equal(resolveDarkMode("light", true), false);
  assert.equal(resolveDarkMode("system", false), false);
  assert.equal(resolveDarkMode("system", true), true);
});
