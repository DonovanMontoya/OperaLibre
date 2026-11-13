import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createExperimentalRecoveryPeer } from "../src/giftRecoveryPeer.ts";
import { createGiftStagingManager } from "../src/giftNativeStaging.ts";
import { receiveRecoveredGift, type RecipientRecoveryState } from "../src/giftRecipientRecovery.ts";
import { createGiftPeerProof } from "../src/giftPeerProof.ts";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: ArrayBuffer | Uint8Array) => Buffer.from(new Uint8Array(value)).toString("base64url");
function frame(offset: number, bytes = new Uint8Array(), final = false) {
  const data = new Uint8Array(21 + bytes.length), view = new DataView(data.buffer);
  data[0] = 7; data.set(new TextEncoder().encode("archive"), 1);
  view.setBigUint64(8, BigInt(offset)); data[16] = final ? 1 : 0; view.setUint32(17, bytes.length); data.set(bytes, 21);
  return data.buffer;
}

async function fixture(mode = "good") {
  const bytes = new Uint8Array([1, 2, 3, 4]), controller = new AbortController();
  const descriptor = { giftId: "gift____________", room: "room____________", size: bytes.length, sha256: hash(bytes), expiresAt: Math.floor(Date.now() / 1000) + 60 };
  const claim = (nonce: string, previousNonce?: string) => ({ payload: JSON.stringify({ room: descriptor.room, role: "recipient", nonce, expiresAt: descriptor.expiresAt, ...(previousNonce ? { previousNonce } : {}) }), signature: "a".repeat(64) });
  const current = claim("current_________"), successor = claim("successor_______", "current_________");
  const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const link = { broker: "https://broker.example", token: Buffer.from(JSON.stringify(current)).toString("base64url"), signingKey: encode(await crypto.subtle.exportKey("raw", signing.publicKey)), previewKey: encode(new Uint8Array(32).fill(7)) };
  let stored: RecipientRecoveryState = { version: 1, broker: link.broker, token: link.token, signingKey: link.signingKey, archive: descriptor, current };
  let active = current.payload, generation = 0, applied = 0, verified = false, closed = false, receipt = false, acknowledgements = 0;
  let entered!: () => void, release!: () => void;
  const appending = new Promise<void>(resolve => { entered = resolve; });
  const writeReady = new Promise<void>(resolve => { release = resolve; });
  let staged = bytes.slice(0, 2), peerBinding: Parameters<typeof createGiftPeerProof>[1], offer: string;
  class Channel extends EventTarget {
    label = "operalibre-share"; ordered = true; maxRetransmits = null; maxPacketLifeTime = null; negotiated = false; readyState = "open"; binaryType = "";
    close() { this.readyState = "closed"; }
    send(value: string) {
      if (JSON.parse(value).type === "persisted") {
        assert.deepEqual(staged, bytes, "chunk ACK must follow native append");
        assert.deepEqual(JSON.parse(value), { type: "persisted", offset: 4 }); acknowledgements++; return;
      }
      assert.equal(verified, true, "must verify full native digest before receipt");
      assert.deepEqual(JSON.parse(value), { type: "verified", size: descriptor.size, sha256: descriptor.sha256 }); receipt = true;
      queueMicrotask(() => {
        if (mode === "cancel-receipt") { controller.abort(); return; }
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "receipt-confirmed", size: descriptor.size, sha256: mode === "bad-receipt" ? "f".repeat(64) : descriptor.sha256 }) }));
      });
    }
  }
  const channel = new Channel();
  class Peer extends EventTarget {
    // iOS can sit in "gathering" for longer than the connection attempt lasts.
    iceGatheringState = mode.startsWith("slow-gather") ? "gathering" : "complete"; localDescription: unknown;
    async setRemoteDescription() { applied++; }
    async createAnswer() { return { type: "answer", sdp: mode === "slow-gather" ? "v=0\r\na=candidate:1 1 udp 1 192.0.2.1 9 typ host\r\n" : "fixture" }; }
    async setLocalDescription(value: unknown) { this.localDescription = value; }
    close() { closed = true; }
    deliver() {
      if (mode === "unordered") channel.ordered = false;
      const event = new Event("datachannel"); Object.defineProperty(event, "channel", { value: channel }); this.dispatchEvent(event);
      if (mode === "duplicate-channel") this.dispatchEvent(event);
      if (mode === "oversized") { channel.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(64 * 1024 + 22) })); return; }
      if (mode === "queue-flood") { for (let i = 0; i < 33; i++) channel.dispatchEvent(new MessageEvent("message", { data: frame(2, new Uint8Array([3])) })); return; }
      const suffix = mode === "bad-digest" ? new Uint8Array([3, 9]) : bytes.slice(2);
      channel.dispatchEvent(new MessageEvent("message", { data: frame(2, suffix) }));
      channel.dispatchEvent(new MessageEvent("message", { data: frame(4, new Uint8Array(), true) }));
    }
  }
  const peer = new Peer();
  const protocol = createExperimentalRecoveryPeer({
    peer: () => peer as unknown as RTCPeerConnection,
    gatherWaitMs: 20,
    async load() { return structuredClone(stored); },
    async compareAndSwap(_id, previous, next) { assert.deepEqual(previous, stored); stored = structuredClone(next); return true; },
    async successor() { return successor; },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const route = new URL(String(input)).pathname.split("/")[1], body = JSON.parse(String(init?.body));
      if (route === "session") return body.payload === active ? Response.json({ generation }) : new Response(null, { status: 403 });
      if (route === "resume") { active = body.nextPayload; generation++; return new Response(null, { status: 204 }); }
      assert.equal(body.payload, active); assert.equal(body.generation, generation);
      if (route === "send" && body.kind === "ready") {
        const ready = JSON.parse(body.message);
        peerBinding = { giftId: descriptor.giftId, room: descriptor.room, archiveSize: descriptor.size, archiveSha256: descriptor.sha256, expiresAt: descriptor.expiresAt, generation, ...ready.resume, challenge: ready.challenge };
        return new Response(null, { status: 204 });
      }
      if (route === "poll") {
        offer = JSON.stringify({ type: "offer", sdp: "fixture" });
        const payload = new TextEncoder().encode(JSON.stringify({ version: 1, ...peerBinding, offer }));
        const message = Buffer.concat([Buffer.from("operalibre-gift-peer-offer-v1\0"), payload]);
        const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, message));
        if (mode === "forged-offer") signature[0] ^= 1;
        return Response.json([{ sequence: 1, kind: "offer", message: JSON.stringify({ payload: encode(payload), signature: encode(signature) }) }]);
      }
      if (route === "send" && body.kind === "answer") {
        const answer = JSON.parse(body.message);
        assert.equal(answer.proof, encode(await createGiftPeerProof(link.previewKey, peerBinding, offer, answer.descriptionJson)));
        peer.deliver(); return new Response(null, { status: 204 });
      }
      throw new Error("unexpected route");
    }) as typeof fetch,
  });
  const staging = createGiftStagingManager({
    async prepareArchive() { assert.fail("recovery must not truncate"); },
    async inspectArchive() { return { offset: staged.length, prefixSha256: hash(staged) }; },
    async append(_id, bytes) { if (mode === "slow-write") { entered(); await writeReady; } staged = Uint8Array.from([...staged, ...bytes]); },
    async verifyArchive({ size, sha256 }) { if (staged.length !== size || hash(staged) !== sha256) throw new Error("digest mismatch"); verified = true; }
  }, () => true);
  return { cancel: () => controller.abort(), run: () => receiveRecoveredGift(link, descriptor, controller.signal, staging.recover, protocol), staged: () => staged, applied: () => applied, verified: () => verified, closed: () => closed, receipt: () => receipt, acknowledgements: () => acknowledgements, appending, release };
}

test("recovery peer verifies resumed bytes and confirms native receipt over the authenticated connection", async () => {
  const f = await fixture(); await f.run();
  assert.deepEqual(f.staged(), new Uint8Array([1, 2, 3, 4]));
  assert.equal(f.applied(), 1); assert.equal(f.verified(), true); assert.equal(f.receipt(), true); assert.equal(f.closed(), true);
});

test("forged recovery offer never reaches the peer or staging", async () => {
  const f = await fixture("forged-offer"); await assert.rejects(f.run());
  assert.equal(f.applied(), 0); assert.deepEqual(f.staged(), new Uint8Array([1, 2])); assert.equal(f.receipt(), false); assert.equal(f.closed(), true);
});

test("recovery withholds chunk acknowledgements until native writes finish", async () => {
  const f = await fixture("slow-write"), receiving = f.run();
  await f.appending;
  assert.equal(f.acknowledgements(), 0); assert.equal(f.receipt(), false);
  assert.deepEqual(f.staged(), new Uint8Array([1, 2]));
  f.release(); await receiving;
  assert.equal(f.acknowledgements(), 1); assert.equal(f.verified(), true);
});

test("recovery rejects invalid channels, queue abuse, bad digest and receipt failures", async () => {
  for (const mode of ["unordered", "duplicate-channel", "queue-flood", "bad-digest", "oversized", "bad-receipt", "cancel-receipt"]) {
    const f = await fixture(mode); await assert.rejects(f.run(), undefined, mode);
    assert.equal(f.closed(), true); assert.equal(f.receipt(), mode.includes("receipt"));
  }
});

test("an answer goes out with the addresses found so far when gathering never finishes", async () => {
  const f = await fixture("slow-gather"); await f.run();
  assert.equal(f.verified(), true); assert.equal(f.receipt(), true);
});

test("an answer with no address at all is never sent", async () => {
  const f = await fixture("slow-gather-empty"), receiving = f.run();
  const outcome = await Promise.race([receiving.then(() => "sent", () => "failed"), new Promise(resolve => setTimeout(() => resolve("waiting"), 150))]);
  assert.equal(outcome, "waiting"); assert.equal(f.receipt(), false);
  f.cancel(); await assert.rejects(receiving);
});
