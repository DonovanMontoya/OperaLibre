import assert from "node:assert/strict";
import test from "node:test";
import { createForegroundProgressSync } from "../src/foregroundProgressSync.ts";
import { NativeForegroundSyncGate } from "../src/nativeAudioState.ts";

function fixture(nativeAudio = true) {
  let now = 0;
  let visibilityState: DocumentVisibilityState = "visible";
  const documentEvents = new EventTarget();
  const windowEvents = new EventTarget();
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 0;
  let saves = 0;
  const adoptions: string[] = [];
  const actionsFor = (book: string) => ({
    nativeAudio,
    async persistProgress() { saves += 1; },
    async adoptNewerServerProgress() { adoptions.push(book); }
  });
  let actions = actionsFor("original");
  const gate = new NativeForegroundSyncGate(() => now, 5000);
  const sync = createForegroundProgressSync(gate, () => actions, {
    get visibilityState() { return visibilityState; },
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents)
  }, {
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
    setTimeout(handler: TimerHandler, timeout = 0) {
      assert.equal(typeof handler, "function");
      const id = ++nextTimer;
      timers.set(id, { at: now + timeout, run: handler as () => void });
      return id;
    },
    clearTimeout(id?: number) { if (id !== undefined) timers.delete(id); }
  });
  return {
    sync, gate, adoptions, timers,
    saves: () => saves,
    updateBook(book: string) { actions = actionsFor(book); },
    fallBack() { actions = { ...actions, nativeAudio: false }; },
    visibility(value: DocumentVisibilityState) {
      visibilityState = value;
      documentEvents.dispatchEvent(new Event("visibilitychange"));
    },
    pagehide() { windowEvents.dispatchEvent(new Event("pagehide")); },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    }
  };
}

test("silent-player retry survives book updates and reads the latest actions", () => {
  const f = fixture();
  f.visibility("hidden");
  f.visibility("visible");
  f.advance(1000);
  f.updateBook("updated");
  f.advance(3999);
  assert.deepEqual(f.adoptions, []);
  f.advance(1);
  assert.deepEqual(f.adoptions, ["updated"]);
  assert.equal(f.timers.size, 0);
  f.sync.dispose();
});

test("a native clock releases the wait once and cancels the deadline", () => {
  const f = fixture();
  f.visibility("hidden");
  f.sync.nativeStateSynchronized();
  f.visibility("visible");
  assert.deepEqual(f.adoptions, []);
  f.sync.nativeStateSynchronized();
  f.sync.nativeStateSynchronized();
  f.advance(5000);
  assert.deepEqual(f.adoptions, ["original"]);
  assert.equal(f.timers.size, 0);
  f.sync.dispose();
});

test("another background transition cancels the old retry and gets a full grace period", () => {
  const f = fixture();
  f.visibility("hidden");
  f.visibility("visible");
  f.advance(4000);
  f.visibility("hidden");
  f.advance(60 * 60 * 1000);
  assert.deepEqual(f.adoptions, []);
  f.visibility("visible");
  f.advance(4999);
  assert.deepEqual(f.adoptions, []);
  f.advance(1);
  assert.deepEqual(f.adoptions, ["original"]);
  f.sync.dispose();
});

test("disposing cancels pending retries and removes both lifecycle listeners", () => {
  const f = fixture();
  f.visibility("hidden");
  f.visibility("visible");
  f.sync.dispose();
  f.advance(5000);
  f.visibility("hidden");
  f.pagehide();
  f.sync.nativeStateSynchronized();
  assert.deepEqual(f.adoptions, []);
  assert.equal(f.saves(), 1);
  assert.equal(f.timers.size, 0);
});

test("web audio adopts immediately and pagehide still saves progress", () => {
  const f = fixture(false);
  f.visibility("hidden");
  f.visibility("visible");
  f.pagehide();
  assert.deepEqual(f.adoptions, ["original"]);
  assert.equal(f.saves(), 2);
  assert.equal(f.timers.size, 0);
  f.sync.dispose();
});

test("a native failure during the wait allows the fallback retry", () => {
  const f = fixture();
  f.visibility("hidden");
  f.visibility("visible");
  f.fallBack();
  f.advance(5000);
  assert.deepEqual(f.adoptions, ["original"]);
  f.sync.dispose();
});
