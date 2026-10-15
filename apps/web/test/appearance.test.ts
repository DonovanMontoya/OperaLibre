import assert from "node:assert/strict";
import test from "node:test";
import {
  APPEARANCE_STORAGE_KEY,
  readAppearanceMode,
  resolveDarkMode,
  writeAppearanceMode
} from "../src/appearance.ts";
import { memoryStorage } from "./memoryStorage.ts";

test("an untouched install follows the system theme", () => {
  assert.equal(readAppearanceMode(memoryStorage()), "system");
  assert.equal(readAppearanceMode(memoryStorage(APPEARANCE_STORAGE_KEY, "garbage")), "system");
});

test("the boolean values written by the old switch stay explicit choices", () => {
  assert.equal(readAppearanceMode(memoryStorage(APPEARANCE_STORAGE_KEY, "true")), "dark");
  assert.equal(readAppearanceMode(memoryStorage(APPEARANCE_STORAGE_KEY, "false")), "light");
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
