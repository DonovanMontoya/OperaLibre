import test from "node:test";
import assert from "node:assert/strict";
import broker, { Room, sign, verify } from "../dist-test/index.js";
import { acceptChunk, decodeChunk, encodeChunk } from "../dist-test/transfer.js";

const base = { room: "room-a", invitationDigest: "digest", nonce: "nonce", expiresAt: Math.floor(Date.now() / 1000) + 60, maxBytes: 100, assets: ["ebook"] };
test("public broker stays disabled", async () => {
  const response = await broker.fetch(new Request("https://broker/rooms/test", { method: "POST", body: "{}" }), {});
  assert.equal(response.status, 503);
});
test("rejects signature tampering", async () => assert.equal(await verify(`${await sign(base, "secret")}x`, "secret"), null));
test("rejects expired capabilities", async () => assert.equal(await verify(await sign({...base, expiresAt: 0}, "secret"), "secret"), null));
test("capabilities remain room-scoped", async () => { const capability = await verify(await sign(base, "secret"), "secret"); assert.equal(capability?.room, "room-a"); assert.notEqual(capability?.room, "room-b"); });

function fakeState() {
  const values = new Map();
  return { storage: { async get(key) { return values.get(key); }, async put(key, value) { values.set(key, value); } }, values };
}

test("room accepts bounded signaling messages and enforces quota", async () => {
  const state = fakeState();
  const room = new Room(state);
  const headers = { "content-type": "application/json", "x-role": "producer", "x-nonce": "p", "x-invitation-digest": "d" };
  for (let i = 0; i < 32; i++) assert.equal((await room.fetch(new Request("https://broker", { method: "POST", headers, body: JSON.stringify({ i }) }))).status, 204);
  assert.equal((await room.fetch(new Request("https://broker", { method: "POST", headers, body: "{}" }))).status, 429);
});

test("room rejects oversized signaling messages", async () => {
  const room = new Room(fakeState());
  const body = JSON.stringify({ data: "x".repeat(70 * 1024) });
  assert.equal((await room.fetch(new Request("https://broker", { method: "POST", headers: { "content-type": "application/json", "x-role": "producer", "x-nonce": "p", "x-invitation-digest": "d" }, body }))).status, 413);
});

test("room isolates roles and prevents replayed claims", async () => {
  const room = new Room(fakeState());
  const producer = { "content-type": "application/json", "x-role": "producer", "x-nonce": "p", "x-invitation-digest": "d" };
  const recipient = { "content-type": "application/json", "x-role": "recipient", "x-nonce": "r", "x-invitation-digest": "d" };
  assert.equal((await room.fetch(new Request("https://broker", { method: "POST", headers: producer, body: "{}" }))).status, 204);
  assert.equal((await room.fetch(new Request("https://broker", { method: "POST", headers: { ...producer, "x-nonce": "other" }, body: "{}" }))).status, 409);
  assert.equal((await room.fetch(new Request("https://broker", { method: "POST", headers: recipient, body: "{}" }))).status, 204);
  assert.equal((await room.fetch(new Request("https://broker", { method: "POST", headers: { ...recipient, "x-invitation-digest": "other" }, body: "{}" }))).status, 403);
});

test("transfer chunks round-trip and resume offsets are bounded", () => {
  const encoded = encodeChunk({ assetId: "ebook", offset: 0, final: false, data: new Uint8Array([1, 2, 3]) });
  const chunk = decodeChunk(encoded);
  assert.equal(chunk.assetId, "ebook");
  assert.equal(acceptChunk(0, 0, chunk, 10), 3);
  assert.throws(() => acceptChunk(4, 3, chunk, 10));
  assert.throws(() => acceptChunk(0, 9, chunk, 10));
});
