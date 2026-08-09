import test from "node:test";
import assert from "node:assert/strict";
import {
  readerStatusLabel,
  summarizeSharedProgress
} from "../src/sharedProgress.ts";
import type { SharedProgress } from "../src/types.ts";

function reader(
  username: string,
  status: SharedProgress["status"],
  percentComplete: number | null
): SharedProgress {
  return { userId: username, username, status, percentComplete, updatedAt: "1" };
}

test("no readers means no badge at all", () => {
  assert.equal(summarizeSharedProgress(undefined), null);
  assert.equal(summarizeSharedProgress([]), null);
  assert.equal(summarizeSharedProgress([reader("Ada", "notStarted", 0)]), null);
});

test("the row label names the first two readers and counts the rest", () => {
  const summary = summarizeSharedProgress([
    reader("Ada", "finished", 100),
    reader("Bo", "inProgress", 42),
    reader("Cy", "inProgress", 9)
  ]);

  assert.ok(summary);
  assert.equal(summary.finished, 1);
  assert.equal(summary.reading, 2);
  assert.equal(summary.label, "Ada, Bo +1");
  assert.equal(
    summary.detail,
    "1 finished · 2 reading: Ada (finished), Bo (42%), Cy (9%)"
  );
});

test("two readers are both named without a counter", () => {
  const summary = summarizeSharedProgress([
    reader("Ada", "finished", 100),
    reader("Bo", "inProgress", 42)
  ]);

  assert.ok(summary);
  assert.equal(summary.label, "Ada, Bo");
});

test("a percentage never rounds away the fact that someone is mid-book", () => {
  // 0% would read as untouched and 100% as finished; neither is true here.
  assert.equal(readerStatusLabel(reader("Ada", "inProgress", 0.2)), "1%");
  assert.equal(readerStatusLabel(reader("Bo", "inProgress", 99.8)), "99%");
  assert.equal(readerStatusLabel(reader("Cy", "inProgress", 50)), "50%");
});

test("a reader with an unknown position still reads as reading", () => {
  assert.equal(readerStatusLabel(reader("Ada", "inProgress", null)), "reading");
  assert.equal(readerStatusLabel(reader("Bo", "finished", null)), "finished");
});
