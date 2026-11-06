import test from "node:test";
import assert from "node:assert/strict";
import broker, { SecureRoom } from "../dist-test/index.js";
import { reserveRoom, cleanupRoom } from "../dist-test/reservations.js";

function storage() {
  const values = new Map();
  let tail = Promise.resolve();
  return { values, transaction(fn) {
    const result = tail.then(() => fn({ async get(key) { return values.get(key); }, async put(key, value) { values.set(key, value); } }));
    tail = result.catch(() => {});
    return result;
  } };
}

test("reservation collision, retries, cleanup ownership, replay and expiry", async () => {
  const db = storage(), clock = () => 100;
  const first = { reservationId: "A".repeat(43), expiresAt: 200 };
  const second = { ...first, reservationId: "B".repeat(43) };
  const results = await Promise.all([reserveRoom(db, first, clock), reserveRoom(db, second, clock)]);
  assert.deepEqual([...results].sort(), [false, true]);
  const [a, b] = results[0] ? [first, second] : [second, first];
  assert.equal(await reserveRoom(db, a, clock), true); // lost response retry
  assert.equal(await reserveRoom(db, { ...a, expiresAt: 201 }, clock), false);
  assert.equal(await cleanupRoom(db, b, clock), false);
  assert.equal(await cleanupRoom(db, { ...a, expiresAt: 201 }, clock), false);
  assert.equal(await cleanupRoom(db, a, () => 200), false);
  assert.equal(await cleanupRoom(db, a, clock), true);
  assert.equal(await cleanupRoom(db, a, clock), true); // lost cleanup response
  assert.equal(await reserveRoom(db, a, clock), false);
  assert.equal(await reserveRoom(db, b, clock), false);
  assert.equal(await cleanupRoom(db, b, clock), false);
  assert.equal(await cleanupRoom(db, a, () => 200), false);
});

test("old state, expired reservations and revoked rooms cannot be acquired", async () => {
  const a = { reservationId: "A".repeat(43), expiresAt: 200 };
  for (const key of ["preview", "claim:producer", "claim:recipient", "queue:producer", "queue:recipient", "revoked"]) {
    const db = storage(); db.values.set(key, { present: true });
    assert.equal(await reserveRoom(db, a, () => 100), false, key);
  }
  const db = storage();
  assert.equal(await reserveRoom(db, a, () => 100), true);
  assert.equal(await reserveRoom(db, { ...a, reservationId: "B".repeat(43), expiresAt: 300 }, () => 200), false);
  assert.equal(await reserveRoom(storage(), { ...a, expiresAt: 1001 }, () => 100), false);
});

test("public endpoints require owner authorization and clean only their room", async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("secret")));
  const objects = new Map();
  const env = { EXPERIMENTAL_ENABLED: "true", OWNER_SECRET_DIGEST_HEX: Array.from(digest, b => b.toString(16).padStart(2, "0")).join(""), SIGNING_SECRET: "s".repeat(32) };
  env.ROOMS = { idFromName: name => name, get(name) { if (!objects.has(name)) objects.set(name, new SecureRoom({ storage: storage() }, env)); return objects.get(name); } };
  const room = "room____________", other = "other___________";
  const body = { reservationId: "A".repeat(43), expiresAt: Math.floor(Date.now() / 1000) + 300 };
  const call = (path, data = body, owner = true) => broker.fetch(new Request(`https://broker/${path}`, { method: "POST", headers: owner ? { authorization: "Bearer secret" } : {}, body: JSON.stringify(data) }), env);
  assert.equal((await call(`reserve/${room}`, body, false)).status, 401);
  assert.equal((await call(`reserve/${room}`, { ...body, reservationId: "short" })).status, 400);
  assert.equal((await call(`reserve/${room}`)).status, 204);
  assert.equal((await call(`cleanup/${other}`)).status, 403);
  assert.equal((await call(`reserve/${other}`)).status, 204);
  assert.equal((await call(`revoke/${room}`, {})).status, 204);
  assert.equal((await call(`cleanup/${room}`)).status, 403);
  assert.equal((await call(`cleanup/${other}`)).status, 204);
  assert.equal((await broker.fetch(new Request(`https://broker/reserve/${room}`, { method: "POST" }), {})).status, 503);
});
