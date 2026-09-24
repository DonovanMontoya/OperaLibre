import assert from "node:assert/strict";
import test from "node:test";
import { existingMetadataNames, matchingMetadataNames } from "../src/metadataSuggestions.ts";
import type { Book } from "../src/types.ts";

const books = [
  { metadata: { series: " Harry Potter " }, tags: [{ name: "Cosmere", position: null }] },
  { metadata: { series: "harry potter" }, tags: [{ name: " cosmere ", position: null }] },
  { metadata: { series: "The Witcher" }, tags: [{ name: "Hogwarts", position: null }] },
  { metadata: { series: null }, tags: [] }
] as Book[];

test("existing names are trimmed, distinct, and kept in their own fields", () => {
  assert.deepEqual(existingMetadataNames(books, "series"), ["Harry Potter", "The Witcher"]);
  assert.deepEqual(existingMetadataNames(books, "tag"), ["Cosmere", "Hogwarts"]);
});

test("suggestions match without case and prioritize names that start with the input", () => {
  const names = ["The Harry Potter World", "Harry Potter", "Harry Dresden"];
  assert.deepEqual(matchingMetadataNames(names, "hArRy"), [
    "Harry Dresden", "Harry Potter", "The Harry Potter World"
  ]);
  assert.deepEqual(matchingMetadataNames(names, "Harry Potter"), ["The Harry Potter World"]);
  assert.deepEqual(matchingMetadataNames(names, "  "), []);
});
