import assert from "node:assert/strict";
import test from "node:test";
import { readPageTurnAnimation, writePageTurnAnimation } from "../src/readerPageTurn.ts";

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: () => value,
    setItem: (_key: string, nextValue: string) => { value = nextValue; }
  };
}

test("the page turn animation is on until the reader turns it off", () => {
  const storage = memoryStorage();
  assert.equal(readPageTurnAnimation(storage), true);
  writePageTurnAnimation(false, storage);
  assert.equal(readPageTurnAnimation(storage), false);
  writePageTurnAnimation(true, storage);
  assert.equal(readPageTurnAnimation(storage), true);
});

test("the page turn animation stays on when device storage is unavailable", () => {
  const broken = {
    getItem: () => { throw new Error("storage disabled"); },
    setItem: () => { throw new Error("storage disabled"); }
  };
  assert.equal(readPageTurnAnimation(broken), true);
  assert.doesNotThrow(() => writePageTurnAnimation(false, broken));
});
