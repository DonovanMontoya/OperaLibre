import test from "node:test";
import assert from "node:assert/strict";
import { authenticateOwner, claimRole } from "../dist-test/claims.js";
import { issue, consume } from "../dist-test/experimental.js";
import broker, { SecureRoom } from "../dist-test/index.js";

test("native preview preflight is explicit and experimental gate stays closed", async () => {
  const preflight = origin => new Request("https://broker/preview-read/room____________", {
    method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" }
  });
  assert.equal((await broker.fetch(preflight("capacitor://localhost"), {})).status, 503);
  const env = { EXPERIMENTAL_ENABLED: "true" };
  const allowed = await broker.fetch(preflight("capacitor://localhost"), env);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "capacitor://localhost");
  assert.equal((await broker.fetch(preflight("https://attacker.example"), env)).status, 403);
  assert.equal((await broker.fetch(preflight("null"), env)).status, 403);
});

function storage() {
  const values = new Map();
  let tail = Promise.resolve();
  return { transaction(fn) {
    const result = tail.then(() => fn({ async get(k) { return values.get(k); }, async put(k, v) { values.set(k, v); } }));
    tail = result.catch(() => {});
    return result;
  } };
}

test("owner secret is required", async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("owner-secret")));
  assert.equal(await authenticateOwner("owner-secret", digest), true);
  assert.equal(await authenticateOwner("other", digest), false);
  assert.equal(await authenticateOwner("", digest), false);
});

test("owner issuance and atomic consumption reject forgery, replay and cross-room claims", async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("owner-secret")));
  const env = { OWNER_SECRET_DIGEST_HEX: Array.from(digest, b => b.toString(16).padStart(2, "0")).join(""), SIGNING_SECRET: "s".repeat(32), ROOMS: {} };
  const claim = { room: "room____________", role: "producer", nonce: "nonce___________", expiresAt: Math.floor(Date.now() / 1000) + 60 };
  const request = token => new Request("https://broker/issue", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(claim) });
  assert.equal((await issue(request("wrong"), env)).status, 401);
  const response = await issue(request("owner-secret"), env);
  assert.equal(response.status, 200);
  const { payload, signature } = await response.json();
  const db = storage();
  const now = Math.floor(Date.now() / 1000);
  assert.equal(await consume(db, "another-room", payload, signature, env.SIGNING_SECRET, now), false);
  assert.equal(await consume(db, claim.room, payload, "0".repeat(64), env.SIGNING_SECRET, now), false);
  assert.deepEqual((await Promise.all([consume(db, claim.room, payload, signature, env.SIGNING_SECRET, now), consume(db, claim.room, payload, signature, env.SIGNING_SECRET, now)])).sort(), [false, true]);
});

test("Worker routes authenticate, scope and atomically consume claims", async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("owner-secret")));
  const instances = new Map();
  const env = { EXPERIMENTAL_ENABLED: "true", OWNER_SECRET_DIGEST_HEX: Array.from(digest, b => b.toString(16).padStart(2, "0")).join(""), SIGNING_SECRET: "s".repeat(32) };
  env.ROOMS = { idFromName(name) { return name; }, get(name) { if (!instances.has(name)) instances.set(name, new SecureRoom({ storage: storage() }, env)); return instances.get(name); } };
  const claim = { room: "room____________", role: "producer", nonce: "nonce___________", expiresAt: Math.floor(Date.now() / 1000) + 60 };
  const request = secret => new Request("https://broker/issue", { method: "POST", headers: { authorization: `Bearer ${secret}` }, body: JSON.stringify(claim) });
  assert.equal((await broker.fetch(request("wrong"), env)).status, 401);
  for (let i = 0; i < 35; i++) assert.equal((await broker.fetch(request("wrong"), env)).status, 401);
  const response = await broker.fetch(request("owner-secret"), env);
  assert.equal(response.status, 200);
  const data = await response.json();
  const consumeRequest = room => new Request(`https://broker/claim/${room}`, { method: "POST", body: JSON.stringify(data) });
  assert.equal((await broker.fetch(consumeRequest("other___________"), env)).status, 403);
  assert.deepEqual((await Promise.all([broker.fetch(consumeRequest(claim.room), env), broker.fetch(consumeRequest(claim.room), env)])).map(r => r.status).sort(), [204, 403]);
});

test("claimed peers exchange ordered offer and answer and reject role abuse", async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("secret")));
  const objects = new Map();
  const env = { EXPERIMENTAL_ENABLED: "true", OWNER_SECRET_DIGEST_HEX: Array.from(digest, b => b.toString(16).padStart(2, "0")).join(""), SIGNING_SECRET: "s".repeat(32) };
  env.ROOMS = { idFromName: name => name, get(name) { if (!objects.has(name)) objects.set(name, new SecureRoom({ storage: storage() }, env)); return objects.get(name); } };
  const room = "room____________";
  const call = (path, body, headers = {}) => broker.fetch(new Request(`https://broker/${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env);
  async function member(role, nonce) {
    const response = await call("issue", { room, role, nonce, expiresAt: Math.floor(Date.now() / 1000) + 60 }, { authorization: "Bearer secret" });
    const token = await response.json();
    assert.equal((await call(`claim/${room}`, token)).status, 204);
    return token;
  }
  const producer = await member("producer", "producer________");
  const recipient = await member("recipient", "recipient_______");
  assert.equal((await call(`send/${room}`, { ...producer, sequence: 1, kind: "ready", message: "bad" })).status, 400);
  assert.equal((await call(`send/${room}`, { ...recipient, sequence: 1, kind: "answer", message: "bad" })).status, 400);
  assert.equal((await call(`send/${room}`, { ...recipient, sequence: 1, kind: "ice", message: "bad" })).status, 400);
  const ready = JSON.stringify({ challenge: "A".repeat(43) });
  assert.equal((await call(`send/${room}`, { ...recipient, sequence: 1, kind: "ready", message: ready })).status, 204);
  assert.equal((await (await call(`poll/${room}`, { ...producer, after: 0 })).json())[0].message, ready);
  assert.equal((await call(`send/${room}`, { ...recipient, sequence: 1, kind: "offer", message: "bad" })).status, 400);
  assert.equal((await call(`send/${room}`, { ...producer, sequence: 1, kind: "offer", message: "sdp-offer" })).status, 204);
  assert.equal((await call(`send/${room}`, { ...producer, sequence: 1, kind: "offer", message: "replay" })).status, 409);
  assert.equal((await (await call(`poll/${room}`, { ...recipient, after: 0 })).json())[0].message, "sdp-offer");
  assert.equal((await call(`send/${room}`, { ...recipient, sequence: 2, kind: "answer", message: "sdp-answer" })).status, 204);
  assert.equal((await (await call(`poll/${room}`, { ...producer, after: 1 })).json())[0].message, "sdp-answer");
  assert.equal((await call(`send/${room}`, { ...producer, sequence: 2, kind: "ice", message: "x".repeat(7169) })).status, 400);
  assert.equal((await call(`revoke/${room}`, {}, { authorization: "Bearer wrong" })).status, 401);
  assert.equal((await call(`revoke/${room}`, {}, { authorization: "Bearer secret" })).status, 204);
  assert.equal((await call(`poll/${room}`, { ...producer, after: 0 })).status, 403);
  assert.equal((await call(`send/${room}`, { ...recipient, sequence: 3, kind: "ice", message: "candidate" })).status, 403);
  assert.equal((await call(`claim/${room}`, producer)).status, 403);
});

test("encrypted preview requires recipient capability and does not consume its claim", async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("secret")));
  const objects = new Map();
  const env = { EXPERIMENTAL_ENABLED: "true", OWNER_SECRET_DIGEST_HEX: Array.from(digest, b => b.toString(16).padStart(2, "0")).join(""), SIGNING_SECRET: "s".repeat(32) };
  env.ROOMS = { idFromName: name => name, get(name) { if (!objects.has(name)) objects.set(name, new SecureRoom({ storage: storage() }, env)); return objects.get(name); } };
  const room = "room____________", expiresAt = Math.floor(Date.now() / 1000) + 60;
  const call = (path, body, owner = false) => broker.fetch(new Request(`https://broker/${path}`, { method: "POST", headers: owner ? { authorization: "Bearer secret" } : {}, body: JSON.stringify(body) }), env);
  const issue = async role => (await call("issue", { room, role, nonce: role === "producer" ? "producer________" : "recipient_______", expiresAt }, true)).json();
  const producer = await issue("producer"), recipient = await issue("recipient");
  const envelope = { nonce: "a".repeat(16), ciphertext: "b".repeat(48), expiresAt };
  assert.equal((await call(`preview-put/${room}`, envelope)).status, 401);
  assert.equal((await call(`preview-put/${room}`, envelope, true)).status, 204);
  assert.equal((await call(`preview-read/${room}`, producer)).status, 403);
  const preview = await call(`preview-read/${room}`, recipient);
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { nonce: envelope.nonce, ciphertext: envelope.ciphertext });
  assert.equal((await call(`claim/${room}`, recipient)).status, 204);
  assert.equal((await call(`revoke/${room}`, {}, true)).status, 204);
  assert.equal((await call(`preview-read/${room}`, recipient)).status, 403);
});

test("simultaneous claims consume role once and are room-scoped", async () => {
  const db = storage();
  const claim = { room: "one", role: "producer", nonce: "n", expiresAt: 101 };
  assert.deepEqual((await Promise.all([claimRole(db, "one", claim, 100), claimRole(db, "one", claim, 100)])).sort(), [false, true]);
  assert.equal(await claimRole(db, "two", { ...claim, role: "recipient" }, 100), false);
  assert.equal(await claimRole(db, "one", { ...claim, role: "recipient" }, 101), false);
  assert.equal(await claimRole(db, "one", { ...claim, role: "recipient", nonce: "r" }, 100), true);
});
