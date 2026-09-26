import assert from "node:assert/strict";
import test from "node:test";
import {
  readFollowAggressiveness,
  readReaderFollowEnabled,
  writeReaderFollowEnabled,
  writeFollowAggressiveness
} from "../src/readalongPreferences.ts";

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  return {
    getItem: () => value,
    setItem: (_key: string, nextValue: string) => { value = nextValue; },
    removeItem: () => { value = null; }
  };
}

test("follow aggressiveness keeps the existing timing by default", () => {
  assert.equal(readFollowAggressiveness(memoryStorage()), 0);
  assert.equal(readFollowAggressiveness(memoryStorage("unexpected")), 0);
  assert.equal(readFollowAggressiveness(memoryStorage("3")), 0);
});

test("narration following starts off and remembers the reader's choice", () => {
  const storage = memoryStorage();
  assert.equal(readReaderFollowEnabled(storage), false);
  writeReaderFollowEnabled(true, storage);
  assert.equal(readReaderFollowEnabled(storage), true);
  writeReaderFollowEnabled(false, storage);
  assert.equal(readReaderFollowEnabled(storage), false);
});

test("a saved choice to follow remains on after upgrading", () => {
  assert.equal(readReaderFollowEnabled(memoryStorage("1")), true);
  assert.equal(readReaderFollowEnabled(memoryStorage("0")), false);
});

test("follow aggressiveness persists valid non-default levels", () => {
  const storage = memoryStorage();
  writeFollowAggressiveness(2, storage);
  assert.equal(readFollowAggressiveness(storage), 2);
  writeFollowAggressiveness(0, storage);
  assert.equal(readFollowAggressiveness(storage), 0);
});
