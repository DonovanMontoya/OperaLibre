import assert from "node:assert/strict";
import test from "node:test";
import {
  readFollowAggressiveness,
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

test("follow aggressiveness persists valid non-default levels", () => {
  const storage = memoryStorage();
  writeFollowAggressiveness(2, storage);
  assert.equal(readFollowAggressiveness(storage), 2);
  writeFollowAggressiveness(0, storage);
  assert.equal(readFollowAggressiveness(storage), 0);
});
