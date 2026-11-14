import assert from "node:assert/strict";
import test from "node:test";
import {
  COLOR_VISION_OPTIONS, COLOR_VISION_STORAGE_KEY, VISUAL_CUES_STORAGE_KEY,
  applyColorVision, applyStrongerVisualCues, readColorVision, readStrongerVisualCues,
  writeColorVision, writeStrongerVisualCues
} from "../src/colorVision.ts";
import { READER_THEME_COLORS, applyReaderThemeColors, readerAccent, sentenceHighlightStyle } from "../src/readerTheme.ts";
import { memoryStorage } from "./memoryStorage.ts";

test("existing, invalid, and storage-blocked installs retain default colors", () => {
  assert.equal(readColorVision(memoryStorage()), "default");
  assert.equal(readColorVision(memoryStorage(COLOR_VISION_STORAGE_KEY, "invalid")), "default");
  const blocked = {
    getItem(): never { throw new Error("blocked"); },
    setItem(): never { throw new Error("blocked"); }
  };
  assert.equal(readColorVision(blocked), "default");
  assert.equal(readStrongerVisualCues(blocked), false);
  assert.doesNotThrow(() => writeColorVision("red-green", blocked));
  assert.doesNotThrow(() => writeStrongerVisualCues(true, blocked));
});

test("palettes and visual cues persist independently and can be turned off", () => {
  const storage = memoryStorage();
  for (const { id } of COLOR_VISION_OPTIONS) {
    writeColorVision(id, storage);
    writeStrongerVisualCues(true, storage);
    assert.equal(readColorVision(storage), id);
    assert.equal(readStrongerVisualCues(storage), true);
    writeStrongerVisualCues(false, storage);
    assert.equal(readStrongerVisualCues(storage), false);
    assert.equal(readColorVision(storage), id);
  }
  assert.equal(readStrongerVisualCues(memoryStorage(VISUAL_CUES_STORAGE_KEY, "invalid")), false);
});

test("returning to default removes palette overrides while retaining independent cues", () => {
  const attributes = new Map<string, string>();
  const root = {
    setAttribute: (key: string, value: string) => { attributes.set(key, value); },
    removeAttribute: (key: string) => { attributes.delete(key); },
    toggleAttribute: (key: string, enabled: boolean) => {
      if (enabled) attributes.set(key, "");
      else attributes.delete(key);
      return enabled;
    }
  };
  // The DOM boundary only needs attribute operations.
  applyColorVision("blue-yellow", root);
  applyStrongerVisualCues(true, root);
  assert.equal(attributes.get("data-color-vision"), "blue-yellow");
  applyColorVision("default", root);
  assert.equal(attributes.has("data-color-vision"), false);
  assert.equal(attributes.has("data-stronger-cues"), true);
  applyStrongerVisualCues(false, root);
  assert.equal(attributes.size, 0);
});

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

test("every reader palette preserves the page and text and keeps links readable", () => {
  for (const theme of ["paper", "sepia", "night"] as const) {
    for (const { id } of COLOR_VISION_OPTIONS) {
      const values: Record<string, string> = {};
      applyReaderThemeColors({ override: (key, value) => { values[key] = value; } }, theme, id);
      assert.equal(values["--reader-page"], READER_THEME_COLORS[theme].page);
      assert.equal(values["--reader-ink"], READER_THEME_COLORS[theme].ink);
      const page = luminance(values["--reader-page"]);
      const link = luminance(values["--reader-link"]);
      assert.ok((Math.max(page, link) + 0.05) / (Math.min(page, link) + 0.05) >= 4.5, `${theme}: ${id}`);
      if (id !== "default") {
        const marker = sentenceHighlightStyle(theme, id, false);
        assert.equal(marker.stroke, readerAccent(theme, id));
      }
      assert.ok(sentenceHighlightStyle(theme, id, true).stroke);
    }
  }
});
