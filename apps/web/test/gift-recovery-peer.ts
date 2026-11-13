import broker, { SecureRoom } from "../../../share-broker/src/index";
import { createExperimentalRecoveryPeer } from "../src/giftRecoveryPeer";
import { receiveRecoveredGift, type RecipientRecoveryState, type RecoveryCapability } from "../src/giftRecipientRecovery";
import { createGiftStagingManager } from "../src/giftNativeStaging";
import type { GiftLink } from "../src/ExperimentalGiftRoute";

// Worker successor issuance, enrollment and cryptography are real. Peer events,
// native storage and durable CAS are disposable in-process test doubles.
type Result = {
  status: "running" | "success" | "failed" | "fixture-error";
  remoteDescriptions: number; deliveredFrames: number; appendedBytes: number;
  digestVerified: boolean; proofVerified: boolean; receiptSent: boolean;
  confirmed: boolean; revoked: boolean; lockReleased: boolean; peerClosed: boolean;
  generation: number | null; readyOffset: number | null; readyPrefix: string | null;
  prefix: string; archiveSize: number; prefixSize: number; gateClosed: boolean;
  oldClaimStatus: number | null; replayStatus: number | null; events: string[];
  error?: string; requests?: string[];
};
declare global { interface Window { recoveryResult: Result } }
const result: Result = window.recoveryResult = {
  status: "running", remoteDescriptions: 0, deliveredFrames: 0, appendedBytes: 0,
  digestVerified: false, proofVerified: false, receiptSent: false, confirmed: false,
  revoked: false, lockReleased: false, peerClosed: false, generation: null,
  readyOffset: null, readyPrefix: null, prefix: "", archiveSize: 0, prefixSize: 8,
  gateClosed: false, oldClaimStatus: null, replayStatus: null, events: [],
};
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));
async function sha256(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join(""); }
function requireFixture(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function memoryStorage() {
  const values = new Map<string, unknown>(); let tail: Promise<unknown> = Promise.resolve();
  return {
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    transaction<T>(fn: (txn: { get<U>(key: string): Promise<U | undefined>; put(key: string, value: unknown): Promise<void> }) => Promise<T>) {
      const operation = tail.then(() => fn(this)); tail = operation.catch(() => undefined); return operation;
    },
  };
}
function frame(offset: number, bytes: Uint8Array, final = false) {
  const output = new Uint8Array(21 + bytes.length), view = new DataView(output.buffer);
  output[0] = 7; output.set(encoder.encode("archive"), 1); view.setBigUint64(8, BigInt(offset));
  output[16] = final ? 1 : 0; view.setUint32(17, bytes.length); output.set(bytes, 21); return output;
}

async function run() {
  const mode = new URLSearchParams(location.search).get("case") ?? "success";
  const room = "recovery_room___1", giftId = "recovery_gift___1";
  const ownerSecret = encode(crypto.getRandomValues(new Uint8Array(32)));
  const objects = new Map<string, SecureRoom>();
  const env = {
    EXPERIMENTAL_ENABLED: "true", OWNER_SECRET_DIGEST_HEX: await sha256(encoder.encode(ownerSecret)),
    SIGNING_SECRET: encode(crypto.getRandomValues(new Uint8Array(32))), CAPABILITY_SECRET: "unused-test-secret",
    ROOMS: { idFromName(name: string) { return name; }, get(id: unknown) {
      const name = String(id);
      if (!objects.has(name)) objects.set(name, new SecureRoom({ storage: memoryStorage() }, env));
      return objects.get(name)!;
    } },
  };
  async function post(route: string, body: unknown, owner = false) {
    return broker.fetch(new Request(`https://broker.test/${route}`, {
      method: "POST", headers: { "content-type": "application/json", ...(owner ? { authorization: `Bearer ${ownerSecret}` } : {}) }, body: JSON.stringify(body),
    }), env);
  }
  result.gateClosed = (await broker.fetch(new Request("https://broker.test/session/" + room, { method: "POST" }), { ...env, EXPERIMENTAL_ENABLED: undefined })).status === 503;
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  async function issue(role: string, nonce: string, previousNonce?: string): Promise<RecoveryCapability> {
    const response = await post("issue", { room, role, nonce, expiresAt, ...(previousNonce ? { previousNonce } : {}) }, true);
    requireFixture(response.status === 200, "test issuance failed"); return response.json();
  }
  const producer = await issue("producer", "producer_nonce_1"), recipient = await issue("recipient", "recipient_nonce1");
  const recoverySecret = encode(crypto.getRandomValues(new Uint8Array(32)));
  requireFixture((await post(`claim/${room}`, producer)).status === 204, "producer claim failed");
  requireFixture((await post(`recovery-claim/${room}`, { ...recipient, recoverySecret })).status === 204, "recipient enrollment failed");
  const archive = encoder.encode("retained original recovery archive bytes"), archiveSha256 = await sha256(archive);
  let staged = archive.slice(0, result.prefixSize);
  result.archiveSize = archive.length; result.prefix = await sha256(staged);
  const signing = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const previewKey = crypto.getRandomValues(new Uint8Array(32));
  const link: GiftLink = {
    broker: "https://broker.test", token: encode(encoder.encode(JSON.stringify(recipient))),
    signingKey: encode(new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey))), previewKey: encode(previewKey),
  };
  const descriptor = { giftId, room, size: archive.length, sha256: archiveSha256, expiresAt };
  let durable: RecipientRecoveryState = { version: 1, broker: link.broker, token: link.token, signingKey: link.signingKey!, archive: descriptor, current: recipient, recoverySecret };
  const manager = createGiftStagingManager({
    async prepareArchive() { throw new Error("recovery must not truncate staging"); },
    async inspectArchive() { return { offset: staged.length, prefixSha256: await sha256(staged) }; },
    async append(_giftId, chunk) {
      const next = new Uint8Array(staged.length + chunk.length); next.set(staged); next.set(chunk, staged.length); staged = next;
      result.appendedBytes += chunk.length;
    },
    async verifyArchive({ size, sha256: expected }) {
      requireFixture(staged.length === size && await sha256(staged) === expected, "complete archive digest mismatch");
      result.digestVerified = true; result.events.push("digest-verified");
    },
  }, () => true);
  class FakeChannel extends EventTarget {
    label = "operalibre-share"; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
    negotiated = false; binaryType = ""; readyState = "open";
    close() { if (this.readyState !== "closed") { this.readyState = "closed"; this.dispatchEvent(new Event("close")); } }
    send(text: string) {
      const receipt = JSON.parse(text);
      if (receipt.type === "persisted") {
        requireFixture(receipt.offset === staged.length && result.appendedBytes === archive.length - result.prefixSize, "chunk acknowledged before native append");
        return;
      }
      requireFixture(result.digestVerified && receipt.type === "verified" && receipt.size === archive.length && receipt.sha256 === archiveSha256, "receipt sent before digest verification");
      result.receiptSent = true; result.events.push("verified-receipt");
      queueMicrotask(() => {
        const confirmation = { type: "receipt-confirmed", size: archive.length, sha256: mode === "invalid-receipt" ? "0".repeat(64) : archiveSha256 };
        result.confirmed = mode !== "invalid-receipt";
        result.events.push(result.confirmed ? "receipt-confirmed" : "invalid-receipt");
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(confirmation) }));
      });
    }
  }
  const offer = JSON.stringify({ type: "offer", sdp: "simulated complete gathered offer" });
  const answer = { type: "answer", sdp: "simulated complete gathered answer" };
  class FakePeer extends EventTarget {
    iceGatheringState = "complete"; connectionState = "connected"; localDescription: unknown = null;
    channel = new FakeChannel();
    async setRemoteDescription(value: unknown) { requireFixture(JSON.stringify(value) === offer, "wrong remote SDP"); result.remoteDescriptions++; }
    async createAnswer() { return answer; }
    async setLocalDescription(value: unknown) { this.localDescription = value; }
    close() { result.peerClosed = true; this.connectionState = "closed"; this.channel.close(); }
    deliver() {
      requireFixture(result.proofVerified, "data delivered before proof verification");
      const event = new Event("datachannel"); Object.defineProperty(event, "channel", { value: this.channel }); this.dispatchEvent(event);
      const remaining = archive.slice(result.prefixSize);
      if (mode === "corrupt-archive") remaining[0] ^= 1;
      for (const bytes of [frame(result.prefixSize, remaining), frame(archive.length, new Uint8Array(), true)]) {
        result.deliveredFrames++; this.channel.dispatchEvent(new MessageEvent("message", { data: bytes.buffer }));
      }
    }
  }
  const peer = new FakePeer();
  let signedBinding: Record<string, string | number> | undefined;
  // Verify the proof independently on the simulated producer, using the actual
  // broker-stored answer and the exact offer/answer transcript, not the client
  // proof generator. Binding changes must invalidate the same tag.
  async function verifyAnswer(descriptionJson: string, proof: string) {
    requireFixture(signedBinding && descriptionJson === JSON.stringify(answer), "unexpected answer transcript");
    const base = await crypto.subtle.importKey("raw", previewKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const derived = await crypto.subtle.sign("HMAC", base, encoder.encode("operalibre-peer-proof-key-v1"));
    const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const transcript = async (offset: number) => encoder.encode([
      "operalibre-peer-proof-v1", room, giftId, expiresAt, 1, archive.length, archiveSha256,
      offset, result.prefix, signedBinding!.challenge, await sha256(encoder.encode(offer)), await sha256(encoder.encode(descriptionJson)),
    ].join("\n"));
    requireFixture(await crypto.subtle.verify("HMAC", key, decode(proof), await transcript(result.prefixSize)), "answer proof failed");
    requireFixture(!await crypto.subtle.verify("HMAC", key, decode(proof), await transcript(result.prefixSize + 1)), "proof accepted another prefix offset");
    result.proofVerified = true; result.events.push("proof-verified");
  }
  const fixtureFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init), route = new URL(request.url);
    requireFixture(route.origin === link.broker, "unexpected outbound fixture request");
    const body = await request.clone().json();
    if (route.pathname === `/resume/${room}`) requireFixture(durable.pending?.successor.payload === body.nextPayload && durable.pending?.successor.signature === body.nextSignature, "resume preceded pending persistence");
    const response = await broker.fetch(request, env);
    (result.requests ??= []).push(`${route.pathname.split("/")[1]}:${response.status}`);
    if (route.pathname === `/send/${room}` && response.status === 204) {
      requireFixture(body.generation === 1, "wrong signaling generation"); result.generation = body.generation;
      const queued = await post(`poll/${room}`, { ...producer, generation: 1, after: body.kind === "ready" ? 0 : 1 });
      requireFixture(queued.status === 200, "producer poll failed");
      const signals = await queued.json(); requireFixture(signals.length === 1, "unexpected producer queue");
      const message = JSON.parse(signals[0].message);
      if (body.kind === "ready") {
        requireFixture(signals[0].sequence === 1 && signals[0].kind === "ready", "wrong ready sequence");
        requireFixture(message.resume.offset === result.prefixSize && message.resume.prefixSha256 === await sha256(archive.slice(0, result.prefixSize)), "sender rejected retained archive prefix");
        result.readyOffset = message.resume.offset; result.readyPrefix = message.resume.prefixSha256;
        signedBinding = { version: 1, giftId, room, expiresAt, archiveSize: archive.length, archiveSha256, generation: 1, offset: message.resume.offset, prefixSha256: message.resume.prefixSha256, challenge: message.challenge, offer };
        const payload = encoder.encode(JSON.stringify(signedBinding)), context = encoder.encode("operalibre-gift-peer-offer-v1\0");
        const signedMessage = new Uint8Array(context.length + payload.length); signedMessage.set(context); signedMessage.set(payload, context.length);
        const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, signedMessage));
        if (mode === "forged-offer") signature[0] ^= 1;
        requireFixture((await post(`send/${room}`, { ...producer, generation: 1, sequence: 1, kind: "offer", message: JSON.stringify({ payload: encode(payload), signature: encode(signature) }) })).status === 204, "producer offer failed");
      } else if (body.kind === "answer") {
        requireFixture(signals[0].sequence === 2 && signals[0].kind === "answer", "wrong answer sequence");
        await verifyAnswer(message.descriptionJson, message.proof);
        if (mode === "revoked") {
          requireFixture((await post(`revoke/${room}`, {}, true)).status === 204, "revocation failed"); result.revoked = true;
        } else queueMicrotask(() => peer.deliver());
      }
    }
    return response;
  };
  const protocol = createExperimentalRecoveryPeer({
    fetch: fixtureFetch, peer: () => peer as unknown as RTCPeerConnection,
    async load() { return structuredClone(durable); },
    async compareAndSwap(_giftId, previous, next) {
      if (JSON.stringify(previous) !== JSON.stringify(durable)) return false;
      durable = structuredClone(next); return true;
    },
  });
  try {
    await receiveRecoveredGift(link, descriptor, new AbortController().signal, manager.recover, protocol);
    result.events.push("completed"); result.status = "success";
  } catch { result.status = "failed"; }
  const reopened = await manager.recover(giftId, archive.length); await reopened.staging.close(); result.lockReleased = true;
  result.oldClaimStatus = (await post(`session/${room}`, recipient)).status;
  const successor = durable.current;
  result.replayStatus = (await post(`resume/${room}`, { ...recipient, nextPayload: successor.payload, nextSignature: successor.signature, generation: 0 })).status;
}

void run().catch(error => { result.status = "fixture-error"; result.error = String(error); }).finally(() => {
  document.getElementById("result")!.textContent = JSON.stringify(result);
  document.documentElement.dataset.complete = "true";
});
