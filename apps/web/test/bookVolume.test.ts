import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOK_GAIN_DEFAULT,
  BOOK_GAIN_MAX,
  BOOK_GAIN_MIN,
  bookVolumeStorageKey,
  bookGainFromDb,
  bookGainToDb,
  formatBookGainDb,
  normalizeBookGain,
  normalizeBookGainDb,
  readBookGains,
  writeBookGains
} from "../src/bookVolume.ts";

const KEY = bookVolumeStorageKey("books.local", "reader");

function memoryStorage(initialValue: string | null = null) {
  const values = new Map<string, string>();
  if (initialValue !== null) values.set(KEY, initialValue);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); }
  };
}

test("a decibel slider position maps to the gain the engine is given", () => {
  assert.equal(bookGainFromDb(0), 1);
  assert.ok(Math.abs(bookGainFromDb(6) - 1.995) < 0.001);
  assert.ok(Math.abs(bookGainFromDb(12) - 3.981) < 0.001);
  assert.ok(Math.abs(bookGainFromDb(24) - 15.849) < 0.001);
  assert.ok(Math.abs(bookGainFromDb(-6) - 0.501) < 0.001);
});

/**
 * The top of the range has to survive the trip through a linear gain and back,
 * or the slider would snap away from the position the listener just chose.
 */
test("a gain round-trips back to the decibel position that produced it", () => {
  for (const db of [-6, -3, 0, 3, 6, 9, 12, 18, 23, 24]) {
    assert.equal(bookGainToDb(bookGainFromDb(db)), db);
  }
});

test("out-of-range and nonsense values fall back instead of silencing a book", () => {
  assert.equal(normalizeBookGainDb(80), 24);
  assert.equal(normalizeBookGainDb(-40), -6);
  assert.equal(normalizeBookGainDb(Number.NaN), 0);
  assert.equal(normalizeBookGainDb(2.4), 2);
  assert.equal(normalizeBookGain(99), BOOK_GAIN_MAX);
  assert.equal(normalizeBookGain(0), BOOK_GAIN_DEFAULT);
  assert.equal(normalizeBookGain(-1), BOOK_GAIN_DEFAULT);
  assert.equal(normalizeBookGain(0.01), BOOK_GAIN_MIN);
});

test("the original level is named rather than shown as a signed zero", () => {
  assert.equal(formatBookGainDb(0), "Original");
  assert.equal(formatBookGainDb(6), "+6 dB");
  assert.equal(formatBookGainDb(-3), "−3 dB");
});

test("stored gains survive a round-trip and drop books left at the original level", () => {
  const storage = memoryStorage();
  writeBookGains(storage, KEY, { quiet: 2, loud: 0.5, untouched: 1 });

  assert.deepEqual(readBookGains(storage, KEY), { quiet: 2, loud: 0.5 });
});

test("a corrupt or hand-edited record never leaks a bad gain into playback", () => {
  assert.deepEqual(readBookGains(memoryStorage("not json"), KEY), {});
  assert.deepEqual(readBookGains(memoryStorage("[1,2,3]"), KEY), {});
  assert.deepEqual(readBookGains(memoryStorage(null), KEY), {});
  assert.deepEqual(
    readBookGains(memoryStorage('{"a":900,"b":"loud","c":1,"d":2}'), KEY),
    { a: BOOK_GAIN_MAX, d: 2 }
  );
});

/**
 * The local record is the only copy on backends that never send volumeGain, so
 * a shared browser must not hand the next listener the previous one's boosts.
 */
test("gains are scoped to both the server and the listener", () => {
  const storage = memoryStorage();
  const otherReader = bookVolumeStorageKey("books.local", "other");
  const otherServer = bookVolumeStorageKey("elsewhere.local", "reader");

  writeBookGains(storage, KEY, { quiet: 2 });

  assert.notEqual(KEY, otherReader);
  assert.notEqual(KEY, otherServer);
  assert.deepEqual(readBookGains(storage, otherReader), {});
  assert.deepEqual(readBookGains(storage, otherServer), {});
  assert.deepEqual(readBookGains(storage, KEY), { quiet: 2 });
});
