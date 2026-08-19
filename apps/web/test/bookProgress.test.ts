import assert from "node:assert/strict";
import test from "node:test";
import {
  compareReadingStatus,
  readingStatus,
  readingStatusLabel,
  readingStatusRank
} from "../src/bookProgress.ts";
import type { Book, BookProgress } from "../src/types.ts";

type ShelfEntry = Pick<Book, "progress">;

function withStatus(status: BookProgress["status"], overrides: Partial<BookProgress> = {}): ShelfEntry {
  return {
    progress: {
      status,
      bookPositionSeconds: 0,
      durationSeconds: 3600,
      remainingSeconds: 3600,
      percentComplete: 0,
      updatedAt: "2026-08-19T00:00:00Z",
      ...overrides
    }
  };
}

test("each of the three states is recognised as itself", () => {
  assert.equal(readingStatus(withStatus("inProgress")), "inProgress");
  assert.equal(readingStatus(withStatus("notStarted")), "notStarted");
  assert.equal(readingStatus(withStatus("finished")), "finished");
});

test("a book the backend reports no progress for counts as not started", () => {
  assert.equal(readingStatus({ progress: null }), "notStarted");
  assert.equal(readingStatus({} as ShelfEntry), "notStarted");
});

test("an unrecognised status falls into not started rather than a fourth group", () => {
  // A newer server, or a backend that grows a state this build has never heard of,
  // must not strand rows under a heading the shelf cannot name.
  const odd = { progress: { status: "archived" } } as unknown as ShelfEntry;
  assert.equal(readingStatus(odd), "notStarted");
});

test("the shelf leads with what is being read and buries what is done", () => {
  assert.ok(readingStatusRank("inProgress") < readingStatusRank("notStarted"));
  assert.ok(readingStatusRank("notStarted") < readingStatusRank("finished"));
});

test("every group carries a heading a reader would recognise", () => {
  assert.equal(readingStatusLabel("inProgress"), "Reading");
  assert.equal(readingStatusLabel("notStarted"), "Not started");
  assert.equal(readingStatusLabel("finished"), "Finished");
});

test("sorting a mixed shelf collects each state into one run", () => {
  const shelf = [
    withStatus("finished"),
    withStatus("notStarted"),
    withStatus("inProgress"),
    withStatus("finished"),
    { progress: null },
    withStatus("inProgress")
  ];

  const order = [...shelf]
    .sort(compareReadingStatus)
    .map((entry) => readingStatus(entry));

  assert.deepEqual(order, [
    "inProgress",
    "inProgress",
    "notStarted",
    "notStarted",
    "finished",
    "finished"
  ]);
});

test("books sharing a state are left tied so the caller can break it by title", () => {
  // Every other sort mode in the shelf falls back to title; the comparator must
  // report a tie rather than imposing an order of its own.
  assert.equal(compareReadingStatus(withStatus("finished"), withStatus("finished")), 0);
  assert.equal(compareReadingStatus({ progress: null }, withStatus("notStarted")), 0);
});

test("a book marked finished early still sorts as finished", () => {
  // The server folds an explicit "mark finished" into the status it reports, so a
  // book stopped at the halfway point must not drift back among the in-progress rows.
  const marked = withStatus("finished", {
    bookPositionSeconds: 1800,
    remainingSeconds: 1800,
    percentComplete: 50
  });
  assert.equal(readingStatus(marked), "finished");
  assert.ok(compareReadingStatus(marked, withStatus("inProgress")) > 0);
});
