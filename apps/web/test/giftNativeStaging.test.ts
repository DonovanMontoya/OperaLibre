import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createGiftStagingManager } from "../src/giftNativeStaging.ts";
import { GiftChunkReceiver } from "../src/giftChunkReceiver.ts";

const id = "gift____________";
const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function frame(offset: number, final: boolean, data: Uint8Array) {
  const out = new Uint8Array(21 + data.length), view = new DataView(out.buffer);
  out[0] = 7; out.set(new TextEncoder().encode("archive"), 1);
  view.setBigUint64(8, BigInt(offset)); out[16] = final ? 1 : 0; view.setUint32(17, data.length); out.set(data, 21);
  return out;
}

test("recover locks the inspected prefix through resumed writes and full verification", async () => {
  let bytes = new Uint8Array([1, 2]);
  const manager = createGiftStagingManager({
    async prepareArchive() { throw new Error("existing file"); },
    async inspectArchive() { return { offset: bytes.length, prefixSha256: digest(bytes) }; },
    async append(_id, chunk) { bytes = Uint8Array.from([...bytes, ...chunk]); },
    async verifyArchive({ size, sha256 }) { assert.equal(bytes.length, size); assert.equal(digest(bytes), sha256); }
  }, () => true);
  const { prefix, staging } = await manager.recover(id, 4);
  assert.deepEqual(prefix, { offset: 2, prefixSha256: digest(bytes) });
  await assert.rejects(manager.recover(id, 4), /active/);
  const receiver = new GiftChunkReceiver(staging, 4, digest(new Uint8Array([1, 2, 3, 4])), prefix.offset);
  await receiver.receive(frame(2, false, new Uint8Array([3, 4])));
  await receiver.receive(frame(4, true, new Uint8Array()));
  await receiver.close(); await staging.close();
  const next = await manager.recover(id, 4);
  await staging.close();
  await assert.rejects(manager.recover(id, 4), /active/);
  await next.staging.close();
});

test("invalid inspection and verification failure cannot complete a recovered transfer", async () => {
  let bad = true;
  const manager = createGiftStagingManager({
    async prepareArchive() {},
    async inspectArchive() { return { offset: bad ? 5 : 1, prefixSha256: "a".repeat(64) }; },
    async append() {},
    async verifyArchive() { throw new Error("digest mismatch"); }
  }, () => true);
  await assert.rejects(manager.recover(id, 4), /prefix/);
  bad = false;
  const { staging } = await manager.recover(id, 4);
  const receiver = new GiftChunkReceiver(staging, 1, "b".repeat(64), 1);
  await assert.rejects(receiver.receive(frame(1, true, new Uint8Array())), /digest mismatch/);
  await receiver.close(); await staging.close();
});
