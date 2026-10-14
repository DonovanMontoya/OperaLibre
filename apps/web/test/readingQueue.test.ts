import assert from "node:assert/strict";
import { test } from "node:test";
import { moveQueuedBookEarlier, parseReadingQueue, queuedBooks, readingQueueKey } from "../src/readingQueue.ts";
import type { Book } from "../src/types.ts";

const book = (id: string, status?: string) => ({ id, title: id, progress: status ? { status, positionSeconds: 123 } : null }) as Book;

test("queue isolates users and servers and safely reads malformed storage", () => {
  assert.notEqual(readingQueueKey("a.b", "c"), readingQueueKey("a", "b.c"));
  assert.notEqual(readingQueueKey("server", "alice"), readingQueueKey("server", "bob"));
  assert.deepEqual(parseReadingQueue('{"bad":true}'), []);
  assert.deepEqual(parseReadingQueue('broken'), []);
  assert.deepEqual(parseReadingQueue('["a",null,"a",4,"b",""]'), ["a", "b"]);
});

test("queue preserves order and listening progress for books at any stage", () => {
  const books = [book("a"), book("b", "notStarted"), book("c", "inProgress"), book("d", "finished")];
  const before = structuredClone(books);
  assert.deepEqual(queuedBooks(["b", "missing", "c", "a", "d"], books).map(b => b.id), ["b", "c", "a", "d"]);
  assert.deepEqual(books, before);
});

test("move earlier is bounded, stable and does not mutate persisted input", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(moveQueuedBookEarlier(ids, "c"), ["a", "c", "b"]);
  assert.deepEqual(moveQueuedBookEarlier(ids, "a"), ids);
  assert.deepEqual(moveQueuedBookEarlier(ids, "missing"), ids);
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("offline ordering moves past unavailable entries without losing them", () => {
  assert.deepEqual(moveQueuedBookEarlier(["hidden", "a", "offline", "b"], "b", ["a", "b"]), ["hidden", "b", "offline", "a"]);
});
