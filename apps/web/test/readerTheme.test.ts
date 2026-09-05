import assert from "node:assert/strict";
import test from "node:test";
import {
  READER_THEME_COLORS,
  READER_THEME_STORAGE_KEY,
  applyReaderThemeColors,
  appPrefersDark,
  readReaderThemeChoice,
  resolveReaderTheme,
  writeReaderThemeChoice
} from "../src/readerTheme.ts";

function memoryStorage(initialValue: string | null = null) {
  const values = new Map<string, string>();
  if (initialValue !== null) values.set(READER_THEME_STORAGE_KEY, initialValue);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
}

function root(...classes: string[]) {
  const set = new Set(classes);
  return { classList: { contains: (name: string) => set.has(name) } };
}

test("an install that never picked a look follows the app", () => {
  assert.equal(readReaderThemeChoice(memoryStorage()), "auto");
  assert.equal(readReaderThemeChoice(memoryStorage("garbage")), "auto");
  assert.equal(readReaderThemeChoice(memoryStorage("auto")), "auto");
});

test("a fixed look stays fixed", () => {
  for (const choice of ["paper", "sepia", "night"] as const) {
    const storage = memoryStorage();
    writeReaderThemeChoice(choice, storage);
    assert.equal(readReaderThemeChoice(storage), choice);
    assert.equal(resolveReaderTheme(choice, true), choice);
    assert.equal(resolveReaderTheme(choice, false), choice);
  }
});

test("auto reads night in the dark and paper in the light", () => {
  assert.equal(resolveReaderTheme("auto", true), "night");
  assert.equal(resolveReaderTheme("auto", false), "paper");
});

test("on iOS the reader follows the app's resolved appearance, not the system", () => {
  // Settings set to light while the phone is dark: the app is light.
  assert.equal(appPrefersDark(root("native-app", "platform-ios"), true), false);
  assert.equal(appPrefersDark(root("native-app", "platform-ios", "dark-mode"), false), true);
});

test("elsewhere the reader follows the system preference", () => {
  assert.equal(appPrefersDark(root(), true), true);
  assert.equal(appPrefersDark(root(), false), false);
});

test("a storage that throws still yields a usable choice", () => {
  const broken = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); }
  };
  assert.equal(readReaderThemeChoice(broken), "auto");
  assert.doesNotThrow(() => writeReaderThemeChoice("night", broken));
});

test("each look sets the page, ink, and link colours as overrides", () => {
  for (const theme of ["paper", "sepia", "night"] as const) {
    const set: Record<string, string> = {};
    applyReaderThemeColors({ override: (name, value) => { set[name] = value; } }, theme);
    assert.deepEqual(set, {
      "--reader-page": READER_THEME_COLORS[theme].page,
      "--reader-ink": READER_THEME_COLORS[theme].ink,
      "--reader-link": READER_THEME_COLORS[theme].link
    });
  }
});
