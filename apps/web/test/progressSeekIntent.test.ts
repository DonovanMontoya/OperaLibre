import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgeProgressSeekIntent, progressSeekOptions, readProgressSeekIntent, recordProgressSeekIntent } from "../src/progressSeekIntent.ts";
import type { Progress } from "../src/types.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
}

function checkpoint(position = 350): Progress {
  return { bookId: "book", trackId: "track", positionSeconds: position, bookPositionSeconds: position, durationSeconds: 600, updatedAt: new Date().toISOString() };
}

test("an offline rewind retains its intent after restarting and loses it only after acknowledgement", () => {
  const disk = storage();
  recordProgressSeekIntent(disk, "server", "reader", "book", 350);
  const intent = readProgressSeekIntent(disk, "server", "reader", "book")!;
  const position = checkpoint();
  assert.deepEqual(progressSeekOptions(intent, position, 400), { intentionalSeek: true, intentionalRegression: true });
  acknowledgeProgressSeekIntent(disk, "server", "reader", "book", intent.id);
  assert.deepEqual(progressSeekOptions(readProgressSeekIntent(disk, "server", "reader", "book"), position, 400), { intentionalSeek: false, intentionalRegression: false });
});

test("restarting near zero is intentional, but a forward seek cannot authorize a zero clock", () => {
  const disk = storage();
  recordProgressSeekIntent(disk, "server", "reader", "book", 0);
  assert.equal(progressSeekOptions(readProgressSeekIntent(disk, "server", "reader", "book"), checkpoint(0), 400).intentionalRegression, true);
  recordProgressSeekIntent(disk, "server", "reader", "book", 430);
  assert.equal(progressSeekOptions(readProgressSeekIntent(disk, "server", "reader", "book"), checkpoint(0), 400).intentionalRegression, false);
});

test("a later seek does not authorize an older checkpoint or get cleared by an earlier response", () => {
  const disk = storage();
  recordProgressSeekIntent(disk, "server", "reader", "book", 350);
  const first = readProgressSeekIntent(disk, "server", "reader", "book")!;
  recordProgressSeekIntent(disk, "server", "reader", "book", 300);
  const second = readProgressSeekIntent(disk, "server", "reader", "book")!;
  acknowledgeProgressSeekIntent(disk, "server", "reader", "book", first.id);
  assert.equal(readProgressSeekIntent(disk, "server", "reader", "book")?.id, second.id);
  assert.equal(progressSeekOptions(second, { ...checkpoint(), updatedAt: String(second.recordedAt - 10) }, 400).intentionalSeek, false);
});

test("pending seeks are scoped by book, account and server", () => {
  const disk = storage();
  recordProgressSeekIntent(disk, "server", "reader", "book", 350);
  assert.equal(readProgressSeekIntent(disk, "other", "reader", "book"), null);
  assert.equal(readProgressSeekIntent(disk, "server", "other", "book"), null);
  assert.equal(readProgressSeekIntent(disk, "server", "reader", "other"), null);
});

test("an adopted offline CarPlay seek uses its original checkpoint time after restarting", () => {
  const disk = storage();
  const updatedAt = Date.now() - 60_000;
  const intent = recordProgressSeekIntent(disk, "server", "reader", "book", 0, updatedAt)!;
  assert.equal(intent.recordedAt, updatedAt);
  const pending = readProgressSeekIntent(disk, "server", "reader", "book");
  assert.deepEqual(progressSeekOptions(pending, { ...checkpoint(0), updatedAt: new Date(updatedAt).toISOString() }, 400),
    { intentionalSeek: true, intentionalRegression: true });
  acknowledgeProgressSeekIntent(disk, "server", "reader", "book", intent.id);
  assert.equal(readProgressSeekIntent(disk, "server", "reader", "book"), null);
});

test("blocked storage does not interrupt playback", () => {
  const blocked = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  recordProgressSeekIntent(blocked, "server", "reader", "book", 350);
  assert.equal(readProgressSeekIntent(blocked, "server", "reader", "book"), null);
  acknowledgeProgressSeekIntent(blocked, "server", "reader", "book", "request");
});

test("LAN HTTP retains seek intent without secure-context randomUUID", () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  const random = crypto.getRandomValues.bind(crypto);
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: random } });
  try {
    const disk = storage();
    recordProgressSeekIntent(disk, "lan-server", "reader", "book", 350);
    assert.equal(readProgressSeekIntent(disk, "lan-server", "reader", "book")?.targetBookPosition, 350);
  } finally {
    Object.defineProperty(globalThis, "crypto", descriptor);
  }
});
