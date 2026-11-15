import test from "node:test";
import assert from "node:assert/strict";
import { GiftChunkReceiver } from "../src/giftChunkReceiver.ts";

function frame(offset: number, final: boolean, bytes: Uint8Array) {
  const id = new TextEncoder().encode("archive"), header = id.length + 1;
  const out = new Uint8Array(header + 13 + bytes.length), view = new DataView(out.buffer);
  out[0] = id.length; out.set(id, 1); view.setBigUint64(header, BigInt(offset)); out[header + 8] = final ? 1 : 0; view.setUint32(header + 9, bytes.length); out.set(bytes, header + 13);
  return out;
}

test("resume receives ordered chunks and asks native sink to verify digest", async () => {
  const writes: number[] = []; let finished = false;
  const receiver = new GiftChunkReceiver({ async append(offset) { writes.push(offset); }, async finish(size, digest) { assert.equal(size, 8); assert.equal(digest, "a".repeat(64)); finished = true; } }, 8, "a".repeat(64), 4);
  await receiver.receive(frame(4, false, new Uint8Array([1, 2, 3, 4])));
  await receiver.receive(frame(8, true, new Uint8Array()));
  assert.deepEqual(writes, [4]); assert.equal(finished, true);
});

test("rejects replay, truncated frames and incomplete finalization", async () => {
  const sink = { async append() {}, async finish() { throw new Error("must not finish"); } };
  const receiver = new GiftChunkReceiver(sink, 8, "a".repeat(64));
  await receiver.receive(frame(0, false, new Uint8Array([1])));
  await assert.rejects(receiver.receive(frame(0, false, new Uint8Array([2]))));
  await assert.rejects(new GiftChunkReceiver(sink, 8, "a".repeat(64)).receive(new Uint8Array([1])));
  await assert.rejects(new GiftChunkReceiver(sink, 8, "a".repeat(64)).receive(frame(0, true, new Uint8Array())));
});

test("receiver bounds queued bytes while native writes are slow", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const sink = { async append() { await blocked; }, async finish() {} };
  const receiver = new GiftChunkReceiver(sink, 5 * 65536, "a".repeat(64));
  const pending = [];
  for (let i = 0; i < 4; i++) pending.push(receiver.receive(frame(i * 65536, false, new Uint8Array(65536))));
  await assert.rejects(receiver.receive(frame(4 * 65536, false, new Uint8Array(65536))), /limit/);
  release();
  await Promise.all(pending);
  await assert.rejects(receiver.receive(frame(4 * 65536, false, new Uint8Array(1))));
});

test("closing rejects new frames and waits for an in-flight write", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const receiver = new GiftChunkReceiver({ async append() { await blocked; }, async finish() {} }, 2, "a".repeat(64));
  const write = receiver.receive(frame(0, false, new Uint8Array([1])));
  let closed = false;
  const close = receiver.close().then(() => { closed = true; });
  await assert.rejects(receiver.receive(frame(1, false, new Uint8Array([2]))));
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await write;
  await close;
  assert.equal(closed, true);
});
