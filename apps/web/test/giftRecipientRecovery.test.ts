import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGiftStagingManager } from "../src/giftNativeStaging.ts";
import { receiveRecoveredGift, type RecipientRecoveryProtocol } from "../src/giftRecipientRecovery.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const giftId = "gift____________", room = "room____________";
const link = { broker: "https://broker.example", token: "token", signingKey: "pinned-key" };
const descriptor = { giftId, room, size: 4, sha256: digest(new Uint8Array([1, 2, 3, 4])), expiresAt: 2000000000 };
function frame(offset: number, bytes: Uint8Array, final = false) {
  const result = new Uint8Array(21 + bytes.length), view = new DataView(result.buffer);
  result[0] = 7; result.set(new TextEncoder().encode("archive"), 1);
  view.setBigUint64(8, BigInt(offset)); result[16] = final ? 1 : 0; view.setUint32(17, bytes.length); result.set(bytes, 21);
  return result;
}
function fixture() {
  let bytes = new Uint8Array([1, 2]), verified = false;
  const manager = createGiftStagingManager({
    async prepareArchive() { throw new Error("must not truncate"); },
    async inspectArchive() { return { offset: bytes.length, prefixSha256: digest(bytes) }; },
    async append(_id, chunk) { bytes = Uint8Array.from([...bytes, ...chunk]); },
    async verifyArchive({ size, sha256 }) { if (bytes.length !== size || digest(bytes) !== sha256) throw new Error("digest mismatch"); verified = true; }
  }, () => true);
  return { manager, bytes: () => bytes, verified: () => verified };
}

test("authenticated recovery binds the locked prefix and verifies the complete archive", async () => {
  const f = fixture(); let closed = false;
  const protocol: RecipientRecoveryProtocol = { async open(actualLink, binding) {
    assert.equal(actualLink.signingKey, link.signingKey);
    assert.deepEqual(binding, { ...descriptor, offset: 2, prefixSha256: digest(new Uint8Array([1, 2])) });
    await assert.rejects(f.manager.recover(giftId, 4), /active/);
    const frames = [frame(2, new Uint8Array([3, 4])), frame(4, new Uint8Array(), true)];
    return { binding: { ...binding }, async next() { return frames.shift() ?? null; }, async close() { closed = true; } };
  } };
  await receiveRecoveredGift(link, descriptor, new AbortController().signal, f.manager.recover, protocol);
  assert.deepEqual(f.bytes(), new Uint8Array([1, 2, 3, 4]));
  assert.equal(f.verified(), true); assert.equal(closed, true);
  const again = await f.manager.recover(giftId, 4); await again.staging.close();
});

test("mismatched sender binding and authentication failures never write and release the lock", async () => {
  for (const variant of ["offset", "prefixSha256", "giftId", "room", "size", "sha256", "expiresAt", "auth"] as const) {
    const f = fixture(); let read = false, closed = false;
    const protocol: RecipientRecoveryProtocol = { async open(_link, binding) {
      if (variant === "auth") throw new Error("authentication failed");
      return { binding: { ...binding, [variant]: typeof binding[variant] === "number" ? 0 : "wrong" }, async next() { read = true; return null; }, async close() { closed = true; } };
    } };
    await assert.rejects(receiveRecoveredGift(link, descriptor, new AbortController().signal, f.manager.recover, protocol));
    assert.equal(read, false); assert.equal(f.verified(), false);
    assert.deepEqual(f.bytes(), new Uint8Array([1, 2])); assert.equal(closed, variant !== "auth");
    const again = await f.manager.recover(giftId, 4); await again.staging.close();
  }
});

test("recovery rejects out-of-order data, incorrect final digest, and cancellation", async () => {
  for (const variant of ["offset", "digest", "abort"] as const) {
    const f = fixture(), controller = new AbortController(); let closed = false;
    const protocol: RecipientRecoveryProtocol = { async open(_link, binding) {
      const frames = [frame(variant === "offset" ? 0 : 2, new Uint8Array([3, variant === "digest" ? 9 : 4])), frame(4, new Uint8Array(), true)];
      return { binding: { ...binding }, async next() { if (variant === "abort") controller.abort(); return frames.shift() ?? null; }, async close() { closed = true; } };
    } };
    await assert.rejects(receiveRecoveredGift(link, descriptor, controller.signal, f.manager.recover, protocol));
    assert.equal(f.verified(), false); assert.equal(closed, true);
    const again = await f.manager.recover(giftId, 4); await again.staging.close();
  }
});
