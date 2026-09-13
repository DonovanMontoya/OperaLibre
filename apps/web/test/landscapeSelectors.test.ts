import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The iOS app still deploys to iOS 15.0, whose WebKit drops any rule using
// :has() (added in 15.4). Landscape layouts that depend on which game is open
// or whether a book is under way must key off classes the app sets instead.
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

test("landscape games dock by an explicit game class, not :has()", () => {
  assert.doesNotMatch(styles, /:has\(\s*>?\s*\.word-game\s*\)/);
  assert.match(styles, /\.native-shell\.tab-games\.games-words \.mini-player/);
  assert.match(styles, /\.games-shell\.games-words/);
});

test("the landscape book wall hides runtime by row state, not :has()", () => {
  assert.doesNotMatch(styles, /:has\(\s*\.book-progress/);
  assert.match(styles, /\.book-row\.in-progress \.book-runtime-tag/);
});
