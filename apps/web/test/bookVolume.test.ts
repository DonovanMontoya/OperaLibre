import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOK_GAIN_DEFAULT,
  BOOK_GAIN_MAX,
  BOOK_GAIN_MIN,
  bookVolumeStorageKey,
  bookGainFromDb,
  bookGainToDb,
  createBookGainSync,
  formatBookGainDb,
  mergeServerBookGains,
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

/**
 * The revert this guards against: a library request already in flight when the
 * slider moves answers with the level the book had before, and the merge would
 * hand that stale value straight back to the listener.
 */
test("a library payload older than this device's write does not undo it", () => {
  const pending = new Map([["book-1", bookGainFromDb(12)]]);
  const local = { "book-1": bookGainFromDb(12) };

  assert.equal(
    mergeServerBookGains(local, [{ id: "book-1", volumeGain: 1 }], pending),
    null
  );
  assert.equal(pending.size, 1);
});

test("a payload carrying this device's write hands the book back to the server", () => {
  const written = bookGainFromDb(12);
  const pending = new Map([["book-1", written]]);
  const local = { "book-1": written };

  assert.equal(
    mergeServerBookGains(local, [{ id: "book-1", volumeGain: written }], pending),
    null
  );
  assert.equal(pending.size, 0);

  // With the write confirmed, a later change from another device applies.
  assert.deepEqual(
    mergeServerBookGains(local, [{ id: "book-1", volumeGain: 2 }], pending),
    { "book-1": 2 }
  );
});

/** f64 through JSON can come back a hair off; that is still our own value. */
test("a confirming payload is matched with tolerance", () => {
  const written = bookGainFromDb(6);
  const pending = new Map([["book-1", written]]);
  mergeServerBookGains({ "book-1": written }, [
    { id: "book-1", volumeGain: written * (1 + 1e-12) }
  ], pending);
  assert.equal(pending.size, 0);
});

test("a reset to original is held until the server repeats it back", () => {
  const pending = new Map([["book-1", BOOK_GAIN_DEFAULT]]);

  assert.equal(
    mergeServerBookGains({}, [{ id: "book-1", volumeGain: 4 }], pending),
    null
  );

  assert.equal(
    mergeServerBookGains({}, [{ id: "book-1", volumeGain: 1 }], pending),
    null
  );
  assert.equal(pending.size, 0);
});

test("the server's copy leads for books this device has not touched", () => {
  const pending = new Map<string, number>();
  assert.deepEqual(
    mergeServerBookGains({ "book-2": 4 }, [
      { id: "book-1", volumeGain: 2 },
      { id: "book-2", volumeGain: 1 },
      { id: "book-3" }
    ], pending),
    { "book-1": 2 }
  );
});

/**
 * A deferred `setBookVolume` stand-in: every call is recorded and left open so
 * the test decides the order and outcome of the responses.
 */
function deferredWriter() {
  const calls: { bookId: string; gain: number; settle: (stored: boolean) => void; fail: () => void }[] = [];
  const write = (bookId: string, gain: number) =>
    new Promise<boolean>((resolve, reject) => {
      calls.push({ bookId, gain, settle: resolve, fail: () => reject(new Error("offline")) });
    });
  return { calls, write };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a drag's writes are sent one at a time, ending on the value released at", async () => {
  // Concurrent writes can land out of order, leaving the server on whichever
  // step it processed last rather than where the listener let go.
  const { calls, write } = deferredWriter();
  const pending = new Map<string, number>();
  const sync = createBookGainSync(write, pending);

  sync.write("book-1", 1.5);
  sync.write("book-1", 2);
  sync.write("book-1", 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].gain, 1.5);

  calls[0].settle(true);
  await flush();

  // The intermediate step collapsed; only the value released at follows.
  assert.equal(calls.length, 2);
  assert.equal(calls[1].gain, 3);
  assert.equal(pending.get("book-1"), 3);

  calls[1].settle(true);
  await flush();
  assert.equal(calls.length, 2);
  // Accepted by the server, so the book stays guarded until a payload echoes it.
  assert.equal(pending.get("book-1"), 3);
});

test("writes to different books still run concurrently", async () => {
  const { calls, write } = deferredWriter();
  const sync = createBookGainSync(write, new Map());

  sync.write("book-1", 2);
  sync.write("book-2", 4);
  assert.deepEqual(calls.map((call) => call.bookId), ["book-1", "book-2"]);
});

/**
 * The guard exists to stop a stale payload undoing a write. A write that never
 * reached the server has nothing to protect, and holding the guard anyway would
 * shut the book out of reconciliation for the rest of the session.
 */
test("a failed write releases the guard so the server leads again", async () => {
  const { calls, write } = deferredWriter();
  const pending = new Map<string, number>();
  const sync = createBookGainSync(write, pending);

  sync.write("book-1", 2);
  assert.equal(pending.get("book-1"), 2);
  calls[0].fail();
  await flush();
  assert.equal(pending.has("book-1"), false);
});

test("a backend with nowhere to store gains releases the guard", async () => {
  const { calls, write } = deferredWriter();
  const pending = new Map<string, number>();
  const sync = createBookGainSync(write, pending);

  sync.write("book-1", 2);
  calls[0].settle(false);
  await flush();
  assert.equal(pending.has("book-1"), false);
});

test("only the last write of a drag decides whether the guard is held", async () => {
  // An early step failing says nothing about the value the listener settled on.
  const { calls, write } = deferredWriter();
  const pending = new Map<string, number>();
  const sync = createBookGainSync(write, pending);

  sync.write("book-1", 1.5);
  sync.write("book-1", 3);
  calls[0].fail();
  await flush();

  // The queued write took over, so the guard is still the newer value's to hold.
  assert.equal(pending.get("book-1"), 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].gain, 3);

  calls[1].settle(true);
  await flush();
  assert.equal(pending.get("book-1"), 3);
});

test("a guard released by a failure lets the next payload correct the mirror", async () => {
  const { calls, write } = deferredWriter();
  const pending = new Map<string, number>();
  const sync = createBookGainSync(write, pending);

  sync.write("book-1", 4);
  calls[0].fail();
  await flush();

  // With the guard gone the merge accepts the server's copy, which is what the
  // failed write means the server still holds.
  assert.deepEqual(
    mergeServerBookGains({ "book-1": 4 }, [{ id: "book-1", volumeGain: 2 }], pending),
    { "book-1": 2 }
  );
});
