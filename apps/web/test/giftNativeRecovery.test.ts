import assert from "node:assert/strict";
import test from "node:test";
import { createNativeGiftRecoveryStorage, type NativeGiftRecoveryBackend } from "../src/giftNativeRecovery.ts";
import type { RecipientRecoveryState } from "../src/giftRecipientRecovery.ts";

const giftId = "gift____________";
const archive = { giftId, room: "room____________", size: 10, sha256: "a".repeat(64), expiresAt: 2000000000 };
const claim = (nonce: string, previousNonce?: string) => ({
  payload: JSON.stringify({ room: archive.room, role: "recipient", nonce, expiresAt: archive.expiresAt, ...(previousNonce ? { previousNonce } : {}) }),
  signature: "b".repeat(64)
});
function state(): RecipientRecoveryState {
  return { version: 1, broker: "https://broker.example", token: "t".repeat(32), signingKey: "A".repeat(43), archive: { ...archive }, current: claim("current_________") };
}
function pending(): RecipientRecoveryState {
  return { ...state(), pending: { successor: claim("successor_______", "current_________"), generation: 0 } };
}
function fixture() {
  // A shared fake native boundary, not a JS storage implementation: two bridge
  // clients must delegate CAS to the same authority without a read/write split.
  let stored: string | null = null;
  const calls: string[] = [];
  const backend: NativeGiftRecoveryBackend = {
    async loadRecoveryState() { calls.push("load"); return { state: stored }; },
    async compareAndSwapRecoveryState(input) {
      calls.push("cas");
      if (input.previous !== stored) return { swapped: false };
      stored = input.next;
      return { swapped: true };
    }
  };
  return { backend, calls, storage: createNativeGiftRecoveryStorage(backend, () => true), raw: () => stored, replace: (raw: string | null) => { stored = raw; } };
}

test("seed, pending rotation and promotion survive replacement of the JS bridge", async () => {
  const f = fixture();
  await assert.rejects(f.storage.load(giftId), /unavailable/);
  assert.equal(await f.storage.compareAndSwap(giftId, null, state()), true);
  assert.equal(await f.storage.compareAndSwap(giftId, null, state()), false);
  const reloaded = createNativeGiftRecoveryStorage(f.backend, () => true);
  assert.deepEqual(await reloaded.load(giftId), state());
  assert.equal(await reloaded.compareAndSwap(giftId, state(), pending()), true);
  const afterCrash = createNativeGiftRecoveryStorage(f.backend, () => true);
  assert.deepEqual(await afterCrash.load(giftId), pending());
  const next = { ...state(), current: pending().pending!.successor };
  assert.equal(await afterCrash.compareAndSwap(giftId, pending(), next), true);
  assert.deepEqual(await afterCrash.load(giftId), next);
});

test("two bridge instances use one native CAS and the stale writer loses", async () => {
  const f = fixture();
  await f.storage.compareAndSwap(giftId, null, state());
  f.calls.length = 0;
  const other = createNativeGiftRecoveryStorage(f.backend, () => true);
  const results = await Promise.all([f.storage.compareAndSwap(giftId, state(), pending()), other.compareAndSwap(giftId, state(), pending())]);
  assert.deepEqual(results, [true, false]);
  assert.deepEqual(f.calls, ["cas", "cas"]);
  assert.deepEqual(await f.storage.load(giftId), pending());
});

test("property order does not change CAS but signed payload bytes remain exact", async () => {
  const f = fixture();
  const initial = state();
  await f.storage.compareAndSwap(giftId, null, initial);
  const reordered = { current: initial.current, archive: { expiresAt: archive.expiresAt, sha256: archive.sha256, size: archive.size, room: archive.room, giftId }, signingKey: initial.signingKey, token: initial.token, broker: initial.broker, version: 1 as const };
  assert.equal(await f.storage.compareAndSwap(giftId, reordered, pending()), true);
  assert.equal((await f.storage.load(giftId)).current.payload, initial.current.payload);
  assert.equal(await f.storage.compareAndSwap(giftId, { ...pending(), current: { ...initial.current, payload: ` ${initial.current.payload}` } }, state()), false);
});

test("arguments are copied before awaiting native persistence and loads do not alias", async () => {
  let finish!: (value: { swapped: boolean }) => void;
  let saved = "";
  const storage = createNativeGiftRecoveryStorage({
    async loadRecoveryState() { return { state: saved }; },
    compareAndSwapRecoveryState(input) { saved = input.next; return new Promise(resolve => { finish = resolve; }); }
  }, () => true);
  const next = pending(), original = structuredClone(next);
  const writing = storage.compareAndSwap(giftId, null, next);
  next.pending!.successor.signature = "c".repeat(64); next.archive.size = 20;
  finish({ swapped: true });
  assert.equal(await writing, true);
  const loaded = await storage.load(giftId);
  assert.deepEqual(loaded, original);
  loaded.archive.size = 1;
  assert.deepEqual(await storage.load(giftId), original);
});

test("path keys, unavailable platform and malformed records never reach native CAS", async () => {
  const f = fixture();
  for (const invalid of ["../gift____________", "gift____________/x", "gift____________\0", "gift____________\n", "short", "g".repeat(129)]) {
    await assert.rejects(f.storage.load(invalid), /unavailable/);
    await assert.rejects(f.storage.compareAndSwap(invalid, null, state()), /unavailable/);
  }
  const unavailable = createNativeGiftRecoveryStorage(f.backend, () => false);
  await assert.rejects(unavailable.load(giftId), /unavailable/);
  await assert.rejects(unavailable.compareAndSwap(giftId, null, state()), /unavailable/);
  const malformed = [
    { ...state(), extra: "not persisted" }, { ...state(), version: 2 },
    { ...state(), broker: "https://user:password@broker.example" },
    { ...state(), broker: "https://broker.example/path" },
    { ...state(), token: "t".repeat(4097) }, { ...state(), token: "t".repeat(32) + "\n" }, { ...state(), signingKey: "bad-key" },
    { ...state(), archive: { ...archive, giftId: "another_gift____" } },
    { ...state(), archive: { ...archive, size: 0 } },
    { ...state(), archive: { ...archive, size: 25 * 1024 ** 3 + 1 } },
    { ...state(), archive: { ...archive, expiresAt: 1.5 } },
    { ...state(), archive: { ...archive, path: "../escape" } },
    { ...state(), current: { ...state().current, signature: "bad" } },
    { ...state(), current: { ...state().current, payload: "x".repeat(4097) } },
    { ...state(), current: { ...state().current, payload: "{" } },
    { ...state(), current: { ...state().current, payload: JSON.stringify({ ...JSON.parse(state().current.payload), role: "producer" }) } },
    { ...pending(), pending: { ...pending().pending, generation: Number.MAX_SAFE_INTEGER } },
    { ...pending(), pending: { successor: claim("successor_______", "wrong___________"), generation: 0 } },
    { ...pending(), pending: { successor: claim("current_________", "current_________"), generation: 0 } },
    { ...state(), pending: null }
  ];
  for (const invalid of malformed) await assert.rejects(f.storage.compareAndSwap(giftId, null, invalid as RecipientRecoveryState), /unavailable/);
  assert.deepEqual(f.calls, []);
});

test("CAS cannot change the pinned link or archive scope", async () => {
  const f = fixture();
  for (const next of [
    { ...state(), broker: "https://other.example" }, { ...state(), token: "s".repeat(32) },
    { ...state(), signingKey: "B".repeat(42) + "A" }, { ...state(), archive: { ...archive, size: 11 } },
    { ...state(), archive: { ...archive, sha256: "c".repeat(64) } }
  ]) await assert.rejects(f.storage.compareAndSwap(giftId, state(), next), /unavailable/);
  assert.deepEqual(f.calls, []);
});

test("native corruption and errors fail closed without exposing secret contents", async () => {
  const f = fixture();
  for (const raw of [null, "{", "x".repeat(16 * 1024 + 1), JSON.stringify({ ...state(), archive: { ...archive, giftId: "another_gift____" } })]) {
    f.replace(raw); await assert.rejects(f.storage.load(giftId), /unavailable/);
    assert.equal(f.raw(), raw, "a load must not erase an unreadable record");
  }
  const secret = "secret native error details";
  const broken = createNativeGiftRecoveryStorage({
    async loadRecoveryState() { throw new Error(secret); },
    async compareAndSwapRecoveryState() { throw new Error(secret); }
  }, () => true);
  await assert.rejects(broken.load(giftId), error => error instanceof Error && !error.message.includes(secret));
  await assert.rejects(broken.compareAndSwap(giftId, null, state()), error => error instanceof Error && !error.message.includes(secret));
});

test("ambiguous native write is reconciled by loading, not silently retried", async () => {
  const f = fixture();
  const storage = createNativeGiftRecoveryStorage({
    loadRecoveryState: f.backend.loadRecoveryState,
    async compareAndSwapRecoveryState(input) {
      await f.backend.compareAndSwapRecoveryState(input);
      throw new Error("bridge response lost after commit");
    }
  }, () => true);
  await assert.rejects(storage.compareAndSwap(giftId, null, pending()), /unavailable/);
  assert.deepEqual(await storage.load(giftId), pending());
  assert.deepEqual(f.calls, ["cas", "load"]);
});
