import test from "node:test";
import assert from "node:assert/strict";
import { createStagedGiftTracker } from "../src/giftStagedCleanup.ts";

function fixture() {
  const values = new Map<string, string>(), cleaned: string[] = [];
  let time = 1_000_000, failing = false, importing: string | null = null;
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key) };
  const tracker = createStagedGiftTracker(() => storage, async id => { if (failing) throw new Error("locked"); cleaned.push(id); }, id => id === importing, () => time);
  return { tracker, cleaned, values, advance(minutes: number) { time += minutes * 60_000; }, fail(value: boolean) { failing = value; }, importing(id: string | null) { importing = id; } };
}

test("a gift that can still be resumed keeps its staged download", async () => {
  const f = fixture();
  f.tracker.note("gift-a__________");
  f.advance(24 * 60);
  await f.tracker.sweep();
  assert.deepEqual(f.cleaned, []);
});

test("a download left behind by a gift that has expired is removed at the next sweep", async () => {
  const f = fixture();
  f.tracker.note("gift-a__________");
  f.advance(10);
  f.tracker.note("gift-b__________");
  f.advance(24 * 60 - 9);
  await f.tracker.sweep();
  assert.deepEqual(f.cleaned, ["gift-a__________"]);
  f.advance(10);
  await f.tracker.sweep();
  assert.deepEqual(f.cleaned, ["gift-a__________", "gift-b__________"]);
  assert.equal(f.values.size, 0);
});

test("a cleanup that fails is tried again later, and finishing a gift clears it at once", async () => {
  const f = fixture();
  f.tracker.note("gift-a__________");
  f.fail(true);
  await f.tracker.finish("gift-a__________");
  assert.equal(f.values.size, 1);
  f.fail(false);
  f.advance(24 * 60 + 2);
  await f.tracker.sweep();
  assert.deepEqual(f.cleaned, ["gift-a__________"]);
  f.tracker.note("gift-b__________");
  await f.tracker.finish("gift-b__________");
  assert.deepEqual(f.cleaned, ["gift-a__________", "gift-b__________"]);
  assert.equal(f.values.size, 0);
});

test("an import interrupted mid-extraction keeps its archive until it has been recovered", async () => {
  const f = fixture();
  f.tracker.note("gift-a__________");
  f.importing("gift-a__________");
  f.advance(24 * 60 + 2);
  await f.tracker.sweep();
  // Closing the gift screen after a failed extraction must not remove it either.
  await f.tracker.finish("gift-a__________");
  assert.deepEqual(f.cleaned, []);
  f.importing(null);
  await f.tracker.sweep();
  assert.deepEqual(f.cleaned, ["gift-a__________"]);
});
