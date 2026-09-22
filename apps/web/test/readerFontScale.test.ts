import assert from "node:assert/strict";
import test from "node:test";
import { readerFontScaleBucket, readStoredFontScale } from "../src/readerFontScale.ts";

test("keeps portrait and landscape text sizes separate on the same screen", () => {
  assert.equal(readerFontScaleBucket("unknown", "portrait"), "open.portrait");
  assert.equal(readerFontScaleBucket("unknown", "landscape"), "open.landscape");
  assert.equal(readerFontScaleBucket("closed", "portrait"), "closed.portrait");
  assert.equal(readerFontScaleBucket("closed", "landscape"), "closed.landscape");
});

test("uses an orientation-specific size before the former per-screen size", () => {
  const values = new Map([
    ["operalibre.readerFontScale.open.landscape", "135"],
    ["operalibre.readerFontScale.open", "110"],
    ["operalibre.readerFontScale", "95"]
  ]);
  assert.equal(readStoredFontScale("open.landscape", (key) => values.get(key) ?? null), 135);
  assert.equal(readStoredFontScale("open.portrait", (key) => values.get(key) ?? null), 110);
});

test("migrates the original preference only to the ordinary or open screen", () => {
  const readValue = (key: string) => key === "operalibre.readerFontScale" ? "125" : null;
  assert.equal(readStoredFontScale("open.portrait", readValue), 125);
  assert.equal(readStoredFontScale("closed.portrait", readValue), 100);
});

test("rejects invalid stored text sizes", () => {
  assert.equal(readStoredFontScale("open.portrait", () => "not-a-number"), 100);
  assert.equal(readStoredFontScale("open.portrait", () => "301"), 100);
});
