import assert from "node:assert/strict";
import test from "node:test";
import { shelfCoverEvictions, SHELF_COVER_MAX_BYTES, SHELF_COVER_MAX_FILES } from "../src/shelfCoverBudget.ts";

test("cover budget evicts oldest files across servers to fit incoming bytes", () => {
  const files = [
    { path: "server-b/new", size: SHELF_COVER_MAX_BYTES / 2, mtime: 2 },
    { path: "server-a/old", size: SHELF_COVER_MAX_BYTES / 2, mtime: 1 }
  ];
  assert.deepEqual(shelfCoverEvictions(files, 1), ["server-a/old"]);
  assert.deepEqual(shelfCoverEvictions(files.slice(0, 1), 1), []);
});

test("cover budget limits tiny orphaned files and rejects unknown sizes", () => {
  const files = Array.from({ length: SHELF_COVER_MAX_FILES }, (_, i) => ({ path: String(i), size: 1, mtime: i }));
  assert.deepEqual(shelfCoverEvictions(files, 1), ["0"]);
  assert.throws(() => shelfCoverEvictions([{ path: "unknown", size: NaN, mtime: 0 }], 1));
});

test("simultaneous covers are all kept, deduplicated, and serialized after failures", async () => {
  const { createShelfCoverQueue } = await import("../src/shelfCoverBudget.ts");
  const queue = createShelfCoverQueue();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = queue("first", async () => {
    events.push("first");
    await gate;
    throw new Error("failed fetch");
  });
  const failure = assert.rejects(first, /failed fetch/);
  assert.equal(queue("first", async () => { events.push("duplicate"); }), first);
  const second = queue("second", async () => { events.push("second"); });
  const third = queue("third", async () => { events.push("third"); });
  await Promise.resolve();
  assert.deepEqual(events, ["first"]);
  release();
  await Promise.all([failure, second, third]);
  assert.deepEqual(events, ["first", "second", "third"]);
  await queue("first", async () => { events.push("retry"); });
  assert.equal(events.at(-1), "retry");
});
