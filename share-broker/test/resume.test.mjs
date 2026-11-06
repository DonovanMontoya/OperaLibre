import test from "node:test";
import assert from "node:assert/strict";
import broker, { SecureRoom } from "../dist-test/index.js";
import { rotateRole } from "../dist-test/claims.js";

function storage() {
  const values = new Map();
  let tail = Promise.resolve();
  return { transaction(fn) {
    const result = tail.then(() => fn({ async get(key) { return values.get(key); }, async put(key, value) { values.set(key, value); } }));
    tail = result.catch(() => {});
    return result;
  } };
}

test("resume rotates only a current, scoped claim atomically and revocation wins", async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("secret")));
  const objects = new Map();
  const env = { EXPERIMENTAL_ENABLED: "true", OWNER_SECRET_DIGEST_HEX: Array.from(digest, b => b.toString(16).padStart(2, "0")).join(""), SIGNING_SECRET: "s".repeat(32) };
  env.ROOMS = { idFromName: name => name, get(name) { if (!objects.has(name)) objects.set(name, new SecureRoom({ storage: storage() }, env)); return objects.get(name); } };
  const room = "room____________", other = "other___________", expiresAt = Math.floor(Date.now() / 1000) + 300;
  const call = (path, body, owner = false) => broker.fetch(new Request(`https://broker/${path}`, { method: "POST", headers: owner ? { authorization: "Bearer secret" } : {}, body: JSON.stringify(body) }), env);
  const issue = async (role, nonce, overrides = {}) => {
    const response = await call("issue", { room, role, nonce, expiresAt, ...overrides }, true);
    assert.equal(response.status, 200);
    return response.json();
  };
  const old = await issue("producer", "producer_old____");
  const next = await issue("producer", "producer_new____");
  const another = await issue("producer", "producer_other__");
  const unused = await issue("producer", "producer_unused_");
  const recipient = await issue("recipient", "recipient_______");
  const foreign = await issue("producer", "foreign_________", { room: other });
  const extended = await issue("producer", "extended________", { expiresAt: expiresAt + 1 });
  const resume = (current, successor, target = room) => call(`resume/${target}`, { ...current, nextPayload: successor.payload, nextSignature: successor.signature });
  assert.equal((await resume(old, next)).status, 403);
  assert.equal((await call(`claim/${room}`, old)).status, 204);
  assert.equal((await resume(old, recipient)).status, 403);
  assert.equal((await resume(old, foreign)).status, 403);
  assert.equal((await resume(old, next, other)).status, 403);
  assert.equal((await resume(old, extended)).status, 403);
  assert.equal((await resume(old, { ...next, signature: "0".repeat(64) })).status, 403);
  assert.deepEqual((await Promise.all([resume(old, next), resume(old, next)])).map(r => r.status).sort(), [204, 403]);
  assert.equal((await call(`poll/${room}`, { ...old, after: 0 })).status, 403);
  assert.equal((await call(`poll/${room}`, { ...next, after: 0 })).status, 200);
  assert.equal((await resume(old, another)).status, 403);
  assert.equal((await resume(next, old)).status, 403);
  assert.equal((await resume(next, another)).status, 204);
  assert.equal((await resume(another, next)).status, 403);
  assert.equal((await call(`revoke/${room}`, {}, true)).status, 204);
  assert.equal((await resume(another, unused)).status, 403);
  assert.equal((await call(`poll/${room}`, { ...another, after: 0 })).status, 403);
});

test("expiry is checked inside the rotation transaction", async () => {
  const db = storage();
  const current = { room: "room", role: "recipient", nonce: "old", expiresAt: 101 };
  const next = { ...current, nonce: "next" };
  await db.transaction(txn => txn.put("claim:recipient", { nonce: current.nonce, expiresAt: current.expiresAt }));
  assert.equal(await rotateRole(db, "room", current, next, () => 101), false);
  assert.equal(await rotateRole(db, "room", current, next, () => 100), true);
});

test("resume rotation storage is bounded per role", async () => {
  const db = storage();
  let current = { room: "room", role: "recipient", nonce: "initial", expiresAt: 101 };
  await db.transaction(txn => txn.put("claim:recipient", { nonce: current.nonce, expiresAt: current.expiresAt }));
  for (let i = 0; i < 16; i++) {
    const next = { ...current, nonce: `nonce-${i}` };
    assert.equal(await rotateRole(db, "room", current, next, () => 100), true);
    current = next;
  }
  assert.equal(await rotateRole(db, "room", current, { ...current, nonce: "overflow" }, () => 100), false);
});
