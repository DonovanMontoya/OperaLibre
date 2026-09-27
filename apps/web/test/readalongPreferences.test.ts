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

test("legacy follow opt-in is used only when the reader has no choice", () => {
  const values = new Map([["operalibre.readalong.followSync", "true"]]);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };

  assert.equal(readReaderFollowEnabled(storage), true);
  values.set("operalibre.readalong.followSync", "false");
  assert.equal(readReaderFollowEnabled(storage), false);
  values.set("operalibre.readalong.followSync", "true");
  writeReaderFollowEnabled(false, storage);
  assert.equal(readReaderFollowEnabled(storage), false);
  writeReaderFollowEnabled(true, storage);
  assert.equal(readReaderFollowEnabled(storage), true);
});

test("follow aggressiveness persists valid non-default levels", () => {
  const storage = memoryStorage();
  writeFollowAggressiveness(2, storage);
  assert.equal(readFollowAggressiveness(storage), 2);
  writeFollowAggressiveness(0, storage);
  assert.equal(readFollowAggressiveness(storage), 0);
});
