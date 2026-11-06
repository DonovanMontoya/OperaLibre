import test from "node:test";
import assert from "node:assert/strict";
import broker, { SecureRoom } from "../dist-test/index.js";
import { recipientRecoverySuccessor } from "../dist-test/claims.js";

async function fixture() {
  const objects = new Map(), stores = new Map();
  const owner = "owner-only-test-secret", digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner)));
  const env = { EXPERIMENTAL_ENABLED: "true", SIGNING_SECRET: "s".repeat(32), OWNER_SECRET_DIGEST_HEX: Buffer.from(digest).toString("hex") };
  env.ROOMS = { idFromName: name => name, get(name) {
    if (!objects.has(name)) {
      const values = new Map(); let tail = Promise.resolve();
      const store = { async get(key) { return structuredClone(values.get(key)); }, async put(key, value) { values.set(key, structuredClone(value)); }, transaction(fn) { const result = tail.then(() => fn(this)); tail = result.catch(() => {}); return result; } };
      stores.set(name, store); objects.set(name, new SecureRoom({ storage: store }, env));
    }
    return objects.get(name);
  } };
  const room = "recovery_room___1", expiresAt = Math.floor(Date.now() / 1000) + 300;
  const secret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const call = (route, body, authenticated = false) => broker.fetch(new Request(`https://broker.test/${route}`, { method: "POST", headers: authenticated ? { authorization: `Bearer ${owner}` } : {}, body: JSON.stringify(body) }), env);
  const issue = async (role = "recipient", nonce = "recipient_nonce1", target = room) => {
    const response = await call("issue", { room: target, role, nonce, expiresAt }, true); assert.equal(response.status, 200); return response.json();
  };
  const current = await issue();
  return { room, expiresAt, secret, current, issue, call, store: () => stores.get(room) };
}

test("recipient secret enrollment is atomic and retryable but the original link cannot recover", async () => {
  const f = await fixture();
  assert.equal((await f.call(`recovery-successor/${f.room}`, { ...f.current, recoverySecret: f.secret })).status, 403);
  const results = await Promise.all([f.call(`recovery-claim/${f.room}`, { ...f.current, recoverySecret: f.secret }), f.call(`recovery-claim/${f.room}`, { ...f.current, recoverySecret: "A".repeat(43) })]);
  assert.deepEqual(results.map(r => r.status), [204, 403]);
  assert.equal((await f.call(`recovery-claim/${f.room}`, { ...f.current, recoverySecret: f.secret })).status, 204, "lost successful response can be retried");
  assert.equal((await f.call(`claim/${f.room}`, f.current)).status, 403);
  for (const [route, extra] of [["session", {}], ["poll", { after: 0 }], ["send", { sequence: 1, kind: "ready", message: "{}" }], ["preview-read", {}]]) {
    assert.equal((await f.call(`${route}/${f.room}`, { ...f.current, ...extra })).status, 403, `original link cannot use ${route} after enrollment`);
    assert.equal((await f.call(`${route}/${f.room}`, { ...f.current, ...extra, recoverySecret: "A".repeat(43) })).status, 403);
  }
  assert.equal((await f.call(`session/${f.room}`, { ...f.current, recoverySecret: f.secret })).status, 200);
  for (const recoverySecret of [undefined, "A".repeat(43), f.secret + "\n"]) {
    assert.equal((await f.call(`recovery-successor/${f.room}`, { ...f.current, recoverySecret })).status, 403);
  }
  assert.equal((await f.call(`recovery-claim/${f.room}`, { ...f.current, recoverySecret: f.secret + "\n" })).status, 403);
  const stored = await f.store().get("recovery:recipient");
  assert.equal(JSON.stringify(stored).includes(f.secret), false);
});

test("successor delivery is idempotent, scoped, and legacy resume cannot bypass the recipient secret", async () => {
  const f = await fixture();
  assert.equal((await f.call(`recovery-claim/${f.room}`, { ...f.current, recoverySecret: f.secret })).status, 204);
  const successors = await Promise.all([0, 1, 2].map(async () => {
    const response = await f.call(`recovery-successor/${f.room}`, { ...f.current, recoverySecret: f.secret });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); return response.json();
  }));
  assert.deepEqual(successors[0], successors[1]); assert.deepEqual(successors[1], successors[2]);
  const next = successors[0], claim = JSON.parse(next.payload), previous = JSON.parse(f.current.payload);
  assert.deepEqual({ ...claim, nonce: previous.nonce, previousNonce: undefined }, { ...previous, previousNonce: undefined });
  assert.notEqual(claim.nonce, previous.nonce);
  const rotation = { ...f.current, nextPayload: next.payload, nextSignature: next.signature, generation: 0 };
  assert.equal((await f.call(`resume/${f.room}`, rotation)).status, 403);
  assert.equal((await f.call(`resume/${f.room}`, { ...rotation, recoverySecret: "A".repeat(43) })).status, 403);
  const concurrent = await Promise.all([0, 1].map(() => f.call(`resume/${f.room}`, { ...rotation, recoverySecret: f.secret })));
  assert.deepEqual(concurrent.map(r => r.status).sort(), [204, 403]);
  assert.equal((await f.call(`recovery-successor/${f.room}`, { ...f.current, recoverySecret: f.secret })).status, 403);
  assert.equal((await f.call(`recovery-claim/${f.room}`, { ...f.current, recoverySecret: f.secret })).status, 403);
  const another = await f.call(`recovery-successor/${f.room}`, { ...next, recoverySecret: f.secret });
  assert.equal(another.status, 200); assert.equal(JSON.parse((await another.json()).payload).previousNonce, claim.nonce);
  assert.equal((await f.call(`revoke/${f.room}`, {}, true)).status, 204);
  assert.equal((await f.call(`recovery-successor/${f.room}`, { ...next, recoverySecret: f.secret })).status, 403);
  assert.equal(await f.store().get("recovery:recipient"), null);
});

test("recovery does not upgrade legacy claims, other roles or other rooms", async () => {
  const f = await fixture();
  assert.equal((await f.call(`claim/${f.room}`, f.current)).status, 204);
  assert.equal((await f.call(`recovery-claim/${f.room}`, { ...f.current, recoverySecret: f.secret })).status, 403);
  assert.equal((await f.call(`recovery-successor/${f.room}`, { ...f.current, recoverySecret: f.secret })).status, 403);
  const producer = await f.issue("producer", "producer_nonce1_");
  const foreign = await f.issue("recipient", "foreign_nonce1__", "foreign_room___1");
  for (const credential of [producer, foreign, { ...f.current, signature: "0".repeat(64) }]) {
    assert.equal((await f.call(`recovery-claim/${f.room}`, { ...credential, recoverySecret: f.secret })).status, 403);
    assert.equal((await f.call(`recovery-successor/${f.room}`, { ...credential, recoverySecret: f.secret })).status, 403);
  }
});

test("expiry is rechecked after cryptography before a successor is stored", async () => {
  const f = await fixture(); await f.call(`recovery-claim/${f.room}`, { ...f.current, recoverySecret: f.secret });
  let now = f.expiresAt - 1;
  const result = await recipientRecoverySuccessor(f.store(), f.room, JSON.parse(f.current.payload), f.secret, async next => { now = f.expiresAt; return { payload: JSON.stringify(next), signature: "a".repeat(64) }; }, () => now);
  assert.equal(result, null); assert.equal((await f.store().get("recovery:recipient")).successor, undefined);
});
