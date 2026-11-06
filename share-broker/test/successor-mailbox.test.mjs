import test from "node:test";
import assert from "node:assert/strict";
import { claimMailbox, publishSuccessor, consumeSuccessor } from "../dist-test/successor-mailbox.js";

function storage() {
  const values = new Map();
  let tail = Promise.resolve();
  return {
    values,
    transaction(fn) {
      const result = tail.then(() => fn({ async get(key) { return structuredClone(values.get(key)); }, async put(key, value) { values.set(key, structuredClone(value)); } }));
      tail = result.catch(() => {});
      return result;
    }
  };
}
const room = "room____________";
const claim = { room, role: "recipient", nonce: "recipient_______", expiresAt: 200 };
const secret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const envelope = { nonce: "a".repeat(16), ciphertext: "b".repeat(48) };
const clock = () => 100;

test("atomic claim binds a random recovery secret and original link alone cannot read", async () => {
  const db = storage(), first = secret(), second = secret();
  const attempts = await Promise.all([claimMailbox(db, room, claim, first, clock), claimMailbox(db, room, claim, second, clock)]);
  assert.deepEqual(attempts.toSorted(), [false, true]);
  const winner = attempts[0] ? first : second, loser = attempts[0] ? second : first;
  assert.equal(JSON.stringify([...db.values]).includes(winner), false);
  assert.equal(await consumeSuccessor(db, room, claim, winner, clock), null);
  assert.equal(await publishSuccessor(db, room, claim, envelope, clock), true);
  assert.equal(await consumeSuccessor(db, room, claim, "", clock), null);
  assert.equal(await consumeSuccessor(db, room, claim, loser, clock), null);
  assert.equal(await consumeSuccessor(db, room, claim, secret(), clock), null);
  const reads = await Promise.all([consumeSuccessor(db, room, claim, winner, clock), consumeSuccessor(db, room, claim, winner, clock)]);
  assert.equal(reads.filter(Boolean).length, 1);
  assert.deepEqual(reads.find(Boolean), envelope);
  assert.equal(JSON.stringify([...db.values]).includes(envelope.ciphertext), false);
  assert.equal(await consumeSuccessor(db, room, claim, winner, clock), null);
  assert.equal(await publishSuccessor(db, room, claim, envelope, clock), false);
  assert.equal(await claimMailbox(db, room, claim, second, clock), false);
});

test("room, role, nonce and exact expiry are bound across all operations", async () => {
  const db = storage(), recovery = secret();
  assert.equal(await claimMailbox(db, room, claim, recovery, clock), true);
  for (const altered of [
    { ...claim, room: "other___________" }, { ...claim, role: "producer" },
    { ...claim, nonce: "different_______" }, { ...claim, expiresAt: 201 },
    { ...claim, previousNonce: "old_____________" }
  ]) {
    assert.equal(await claimMailbox(db, room, altered, recovery, clock), false);
    assert.equal(await publishSuccessor(db, room, altered, envelope, clock), false);
  }
  assert.equal(await publishSuccessor(db, room, claim, envelope, clock), true);
  for (const altered of [
    { ...claim, room: "other___________" }, { ...claim, role: "producer" },
    { ...claim, nonce: "different_______" }, { ...claim, expiresAt: 201 }
  ]) assert.equal(await consumeSuccessor(db, room, altered, recovery, clock), null);
  assert.equal(await consumeSuccessor(db, "other___________", claim, recovery, clock), null);
  assert.deepEqual(await consumeSuccessor(db, room, claim, recovery, clock), envelope);
});

test("expiry, revocation and concurrent publication serialize with delivery", async () => {
  const db = storage(), recovery = secret();
  assert.equal(await claimMailbox(db, room, claim, recovery, () => 200), false);
  assert.equal(await claimMailbox(db, room, { ...claim, expiresAt: 1001 }, recovery, clock), false);
  assert.equal(await claimMailbox(db, room, claim, recovery, clock), true);
  assert.equal(await publishSuccessor(db, room, claim, envelope, () => 200), false);
  assert.deepEqual((await Promise.all([publishSuccessor(db, room, claim, envelope, clock), publishSuccessor(db, room, claim, envelope, clock)])).toSorted(), [false, true]);
  assert.equal(await consumeSuccessor(db, room, claim, recovery, () => 200), null);
  let calls = 0;
  assert.equal(await consumeSuccessor(db, room, claim, recovery, () => ++calls === 1 ? 199 : 200), null);
  const [revoked, read] = await Promise.all([
    db.transaction(async txn => { await txn.put("revoked", true); return true; }),
    consumeSuccessor(db, room, claim, recovery, clock)
  ]);
  assert.equal(revoked, true);
  assert.equal(read, null);
  assert.equal(await publishSuccessor(db, room, claim, envelope, clock), false);
  assert.equal(await claimMailbox(db, room, claim, recovery, clock), false);
});

test("malformed and oversized inputs are rejected without changing state", async () => {
  const db = storage(), recovery = secret();
  for (const value of ["", "x".repeat(43), "a".repeat(44), null]) assert.equal(await claimMailbox(db, room, claim, value, clock), false);
  assert.equal(db.values.size, 0);
  assert.equal(await claimMailbox(db, room, claim, recovery, clock), true);
  for (const invalid of [null, { ...envelope, nonce: "x" }, { ...envelope, ciphertext: "a".repeat(10925) }, { ...envelope, ciphertext: "!".repeat(22) }]) {
    assert.equal(await publishSuccessor(db, room, claim, invalid, clock), false);
  }
  assert.equal(await publishSuccessor(db, room, claim, envelope, clock), true);
});
