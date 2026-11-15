import assert from "node:assert/strict";
import { test } from "node:test";
import { COVER_RETRY_DELAYS_MS, coverRetryDelay, createCoverRetrySignal } from "../src/coverRetry.ts";

class FakeTarget extends EventTarget {
  hidden = false;
  listenerCount = 0;
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    this.listenerCount += 1;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
    this.listenerCount -= 1;
    super.removeEventListener(...args);
  }
}

test("a failed cover is retried a bounded number of times, waiting longer each time", () => {
  assert.equal(coverRetryDelay(0), null);
  const delays = COVER_RETRY_DELAYS_MS.map((_, index) => coverRetryDelay(index + 1));
  assert.deepEqual(delays, [...COVER_RETRY_DELAYS_MS]);
  assert.ok(delays.every((delay, index) => index === 0 || delay! > delays[index - 1]!));
  assert.equal(coverRetryDelay(COVER_RETRY_DELAYS_MS.length + 1), null);
});

test("the network returning or the app foregrounding wakes every subscribed cover", () => {
  const win = new FakeTarget();
  const doc = new FakeTarget();
  const signal = createCoverRetrySignal(win, doc);
  let wakes = 0;
  const unsubscribeA = signal.subscribe(() => { wakes += 1; });
  const unsubscribeB = signal.subscribe(() => { wakes += 1; });
  assert.equal(win.listenerCount + doc.listenerCount, 2, "listeners are shared, not per cover");

  win.dispatchEvent(new Event("online"));
  assert.equal(signal.generation(), 1);
  assert.equal(wakes, 2);

  doc.hidden = true;
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(signal.generation(), 1, "going to the background does not retry");

  doc.hidden = false;
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(signal.generation(), 2);
  assert.equal(wakes, 4);

  unsubscribeA();
  unsubscribeB();
  assert.equal(win.listenerCount + doc.listenerCount, 0);
  win.dispatchEvent(new Event("online"));
  assert.equal(wakes, 4);
});
