import test from "node:test";
import assert from "node:assert/strict";
import { createGiftPeerProof, type GiftPeerProofBinding } from "../src/giftPeerProof.ts";

test("peer proof matches the server transcript and binds both descriptions", async () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const binding: GiftPeerProofBinding = { room: "room____________", giftId: "gift____________", expiresAt: 100, generation: 1, archiveSize: 100, archiveSha256: "a".repeat(64), offset: 12, prefixSha256: "b".repeat(64), challenge: Buffer.alloc(32, 3).toString("base64url") };
  const proof = await createGiftPeerProof(key, binding, "offer", "answer", 90);
  assert.equal(Buffer.from(proof).toString("hex"), "43818e2473d196a965da58367cc94046519460199ad6ed70b004435feca37fee");
  assert.notDeepEqual(await createGiftPeerProof(key, binding, "offer!", "answer", 90), proof);
  assert.notDeepEqual(await createGiftPeerProof(key, { ...binding, generation: 2 }, "offer", "answer", 90), proof);
  await assert.rejects(createGiftPeerProof(key, binding, "offer", "answer", 100));
  await assert.rejects(createGiftPeerProof(key, { ...binding, offset: 101 }, "offer", "answer", 90));
});
