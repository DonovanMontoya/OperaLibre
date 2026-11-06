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
  const next = await issue("producer", "producer_new____", { previousNonce: "producer_old____" });
  const another = await issue("producer", "producer_other__", { previousNonce: "producer_new____" });
  const unused = await issue("producer", "producer_unused_", { previousNonce: "producer_other__" });
  const recipient = await issue("recipient", "recipient_______");
  const foreign = await issue("producer", "foreign_________", { room: other });
  const extended = await issue("producer", "extended________", { expiresAt: expiresAt + 1 });
  const resume = (current, successor, target = room, generation = 0) => call(`resume/${target}`, { ...current, nextPayload: successor.payload, nextSignature: successor.signature, generation });
  assert.equal((await resume(old, next)).status, 403);
  assert.equal((await call(`claim/${room}`, old)).status, 204);
  assert.equal((await resume(old, recipient)).status, 403);
  assert.equal((await resume(old, foreign)).status, 403);
  assert.equal((await resume(old, next, other)).status, 403);
  assert.equal((await resume(old, extended)).status, 403);
  assert.equal((await resume(old, { ...next, signature: "0".repeat(64) })).status, 403);
  assert.deepEqual((await Promise.all([resume(old, next), resume(old, next)])).map(r => r.status).sort(), [204, 403]);
  assert.equal((await call(`poll/${room}`, { ...old, after: 0 })).status, 403);
  assert.equal((await call(`poll/${room}`, { ...next, after: 0, generation: 1 })).status, 200);
  assert.equal((await resume(old, another)).status, 403);
  assert.equal((await resume(next, old, room, 1)).status, 403);
  assert.equal((await resume(next, another, room, 1)).status, 204);
  assert.equal((await resume(another, next, room, 2)).status, 403);
  assert.equal((await call(`revoke/${room}`, {}, true)).status, 204);
  assert.equal((await resume(another, unused, room, 2)).status, 403);
  assert.equal((await call(`poll/${room}`, { ...another, after: 0 })).status, 403);
});

test("expiry is checked inside the rotation transaction", async () => {
  const db = storage();
  const current = { room: "room", role: "recipient", nonce: "old", expiresAt: 101 };
  const next = { ...current, nonce: "next", previousNonce: "old" };
  await db.transaction(txn => txn.put("claim:recipient", { nonce: current.nonce, expiresAt: current.expiresAt }));
  assert.equal(await rotateRole(db, "room", current, next, 0, () => 101), false);
  assert.equal(await rotateRole(db, "room", current, next, 0, () => 100), true);
});

test("resume rotation storage is bounded per role", async () => {
  const db = storage();
  let current = { room: "room", role: "recipient", nonce: "initial", expiresAt: 101 };
  await db.transaction(txn => txn.put("claim:recipient", { nonce: current.nonce, expiresAt: current.expiresAt }));
  for (let i = 0; i < 16; i++) {
    const next = { ...current, nonce: `nonce-${i}`, previousNonce: current.nonce };
    assert.equal(await rotateRole(db, "room", current, next, i, () => 100), true);
    current = next;
  }
  assert.equal(await rotateRole(db, "room", current, { ...current, nonce: "overflow", previousNonce: current.nonce }, 16, () => 100), false);
});

test("reconnection isolates generations and races across both roles", async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("secret")));
  const objects = new Map();
  const env = { EXPERIMENTAL_ENABLED: "true", OWNER_SECRET_DIGEST_HEX: Array.from(digest, b => b.toString(16).padStart(2, "0")).join(""), SIGNING_SECRET: "s".repeat(32) };
  env.ROOMS = { idFromName: name => name, get(name) { if (!objects.has(name)) objects.set(name, new SecureRoom({ storage: storage() }, env)); return objects.get(name); } };
  const room = "reconnect_______", expiresAt = Math.floor(Date.now() / 1000) + 300;
  const call = (path, body, owner = false) => broker.fetch(new Request(`https://broker/${path}`, { method: "POST", headers: owner ? { authorization: "Bearer secret" } : {}, body: JSON.stringify(body) }), env);
  const issue = async (role, nonce, previousNonce) => {
    const response = await call("issue", { room, role, nonce, expiresAt, ...(previousNonce ? { previousNonce } : {}) }, true);
    assert.equal(response.status, 200);
    return response.json();
  };
  const p = await issue("producer", "producer_old____"), r = await issue("recipient", "recipient_old___");
  const pn = await issue("producer", "producer_new____", "producer_old____"), rn = await issue("recipient", "recipient_new___", "recipient_old___");
  const unrelated = await issue("producer", "unrelated_______");
  const wrongParent = await issue("producer", "wrong_parent____", "another_parent__");
  const resume = (current, next, generation) => call(`resume/${room}`, { ...current, nextPayload: next.payload, nextSignature: next.signature, generation });
  assert.equal((await call(`claim/${room}`, pn)).status, 403);
  assert.equal((await call(`claim/${room}`, p)).status, 204);
  assert.equal((await call(`claim/${room}`, r)).status, 204);
  assert.equal((await resume(p, unrelated, 0)).status, 403);
  assert.equal((await resume(p, wrongParent, 0)).status, 403);
  assert.equal((await call(`send/${room}`, { ...p, sequence: 1, kind: "offer", message: "old offer" })).status, 204);
  assert.equal((await call(`send/${room}`, { ...r, sequence: 1, kind: "answer", message: "old answer" })).status, 204);
  const results = await Promise.all([resume(p, pn, 0), resume(r, rn, 0)]);
  assert.deepEqual(results.map(x => x.status).sort(), [204, 403]);
  assert.equal(results.find(x => x.status === 204).headers.get("x-signaling-generation"), "1");
  const producer = results[0].status === 204 ? pn : p;
  const recipient = results[1].status === 204 ? rn : r;
  assert.equal((await call(`poll/${room}`, { ...producer, after: 0 })).status, 409);
  assert.equal((await call(`send/${room}`, { ...recipient, sequence: 2, kind: "ice", message: "stale", generation: 0 })).status, 409);
  assert.deepEqual(await (await call(`poll/${room}`, { ...producer, after: 0, generation: 1 })).json(), []);
  assert.deepEqual(await (await call(`poll/${room}`, { ...recipient, after: 0, generation: 1 })).json(), []);
  assert.equal((await call(`send/${room}`, { ...recipient, sequence: 1, kind: "offer", message: "bad", generation: 1 })).status, 400);
  assert.equal((await call(`send/${room}`, { ...producer, sequence: 1, kind: "offer", message: "new offer", generation: 1 })).status, 204);
  assert.equal((await call(`send/${room}`, { ...recipient, sequence: 1, kind: "answer", message: "new answer", generation: 1 })).status, 204);
  assert.equal((await (await call(`poll/${room}`, { ...recipient, after: 0, generation: 1 })).json())[0].message, "new offer");
  assert.equal((await (await call(`poll/${room}`, { ...producer, after: 0, generation: 1 })).json())[0].message, "new answer");
  assert.equal((await resume(p, pn, 0)).status, 403);
  assert.equal((await resume(r, rn, 0)).status, 403);
});
