import { createRoot } from "react-dom/client";
import broker, { SecureRoom } from "../../../share-broker/src/index";
import { ExperimentalGiftRoute, type GiftLink } from "../src/ExperimentalGiftRoute";
import { createExperimentalRecipientTransport, type VerifiedRecipientDetails } from "../src/giftRecipientTransport";

declare global { interface Window { stagedBytes: number; verifiedArchive: boolean; importCount: number; remoteDescriptionCalls: number } }
window.stagedBytes = 0; window.verifiedArchive = false; window.importCount = 0; window.remoteDescriptionCalls = 0;
const room = "recipient_______", giftId = "gift____________", ownerSecret = "owner-secret";
const bytes = new TextEncoder().encode("verified archive bytes");
const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
const ownerDigest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ownerSecret))), byte => byte.toString(16).padStart(2, "0")).join("");
function storage() {
  const values = new Map<string, unknown>(); let tail: Promise<unknown> = Promise.resolve();
  return { async get<T>(key: string) { return values.get(key) as T | undefined; }, async put(key: string, value: unknown) { values.set(key, value); }, transaction<T>(fn: (txn: { get<U>(key: string): Promise<U | undefined>; put(key: string, value: unknown): Promise<void> }) => Promise<T>) { const result = tail.then(() => fn(this)); tail = result.catch(() => {}); return result; } };
}
const objects = new Map<string, SecureRoom>();
const env = { EXPERIMENTAL_ENABLED: "true", OWNER_SECRET_DIGEST_HEX: ownerDigest, SIGNING_SECRET: "s".repeat(32), CAPABILITY_SECRET: "unused", ROOMS: { idFromName(name: string) { return name; }, get(id: unknown) { const name = String(id); if (!objects.has(name)) objects.set(name, new SecureRoom({ storage: storage() }, env)); return objects.get(name)!; } } };
async function post(path: string, body: unknown, owner = false) {
  return broker.fetch(new Request(`https://broker.test/${path}`, { method: "POST", headers: owner ? { authorization: `Bearer ${ownerSecret}` } : {}, body: JSON.stringify(body) }), env);
}
const expiry = Math.floor(Date.now() / 1000) + 60;
async function member(role: string, nonce: string) {
  const response = await post("issue", { room, role, nonce, expiresAt: expiry }, true);
  if (!response.ok) throw new Error("fixture issuance failed");
  return response.json() as Promise<{ payload: string; signature: string }>;
}
const producer = await member("producer", "producer________");
const recipient = await member("recipient", "recipient_______");
if (!(await post(`claim/${room}`, producer)).ok) throw new Error("fixture claim failed");
const token = btoa(JSON.stringify(recipient)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const encode = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const link: GiftLink = { broker: "https://broker.test", token, signingKey: encode(new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey))), previewKey: encode(new Uint8Array(32).fill(7)) };
const details: VerifiedRecipientDetails = { giftId, assets: [{ name: "book.epub", size: 10, sha256: "a".repeat(64), kind: "ebook" }], metadata: { title: "Gift" }, preview: { sender: "Alex", title: "Gift", author: null, summary: null, message: null, coverUrl: null, formats: ["EPUB"], sizeBytes: 10 }, transfer: { room, size: bytes.length, sha256: hash, expiresAt: expiry } };
if (new URLSearchParams(location.search).has("expired")) details.transfer.expiresAt = Math.floor(Date.now() / 1000) - 1;
if (new URLSearchParams(location.search).has("revoked")) await post(`revoke/${room}`, {}, true);
function frame(offset: number, final: boolean, data: Uint8Array) {
  const id = new TextEncoder().encode("archive"), header = id.length + 1;
  const output = new Uint8Array(header + 13 + data.length), view = new DataView(output.buffer);
  output[0] = id.length; output.set(id, 1); view.setBigUint64(header, BigInt(offset)); output[header + 8] = final ? 1 : 0; view.setUint32(header + 9, data.length); output.set(data, header + 13); return output;
}
class FakeChannel extends EventTarget { binaryType = ""; close() {} send(value: string) { const ack = JSON.parse(value); if (!window.verifiedArchive || ack.type !== "verified" || ack.size !== bytes.length || ack.sha256 !== hash) throw new Error("invalid acknowledgement"); queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "receipt-confirmed", size: bytes.length, sha256: hash }) }))); } }
class FakePeer extends EventTarget {
  iceGatheringState = "complete"; localDescription: unknown = null; channel = new FakeChannel();
  async setRemoteDescription() { window.remoteDescriptionCalls++; }
  async createAnswer() { return { type: "answer", sdp: "fake" }; }
  async setLocalDescription(value: unknown) { this.localDescription = value; }
  close() {}
  deliver() {
    const event = new Event("datachannel"); Object.defineProperty(event, "channel", { value: this.channel }); this.dispatchEvent(event);
    const transferred = bytes.slice();
    if (new URLSearchParams(location.search).has("tamper")) transferred[0] ^= 1;
    const chunk = frame(0, false, transferred), final = frame(bytes.length, true, new Uint8Array());
    this.channel.dispatchEvent(new MessageEvent("message", { data: chunk.buffer }));
    this.channel.dispatchEvent(new MessageEvent("message", { data: final.buffer }));
  }
}
const peer = new FakePeer();
const originalFetch = window.fetch;
window.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (new URL(request.url).hostname !== "broker.test") return originalFetch(input, init);
  const response = await broker.fetch(request, env);
  if (new URL(request.url).pathname.startsWith("/send/") && response.ok) {
    const payload = JSON.parse(String(init?.body));
    if (payload.kind === "ready") {
      const challenge = JSON.parse(payload.message).challenge;
      const signedPayload = new TextEncoder().encode(JSON.stringify({ version: 1, giftId, room, expiresAt: expiry, archiveSize: bytes.length, archiveSha256: hash, generation: 0, offset: 0, prefixSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", challenge, offer: JSON.stringify({ type: "offer", sdp: "fake" }) }));
      const context = new TextEncoder().encode("operalibre-gift-peer-offer-v1\0");
      const message = new Uint8Array(context.length + signedPayload.length); message.set(context); message.set(signedPayload, context.length);
      const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, message));
      if (new URLSearchParams(location.search).has("tampered-offer")) signature[0] ^= 1;
      await post(`send/${room}`, { ...producer, sequence: 1, kind: "offer", message: JSON.stringify({ payload: encode(signedPayload), signature: encode(signature) }) });
    }
    if (payload.kind === "answer") setTimeout(() => peer.deliver(), 0);
  }
  return response;
};
const collected: Uint8Array[] = [];
const transport = createExperimentalRecipientTransport(async () => details, {
  peer: () => peer as unknown as RTCPeerConnection,
  async stage() { return {
    async append(_offset, chunk) { window.stagedBytes += chunk.length; collected.push(chunk); },
    async finish(size, expected) { const joined = new Uint8Array(size); let offset = 0; for (const chunk of collected) { joined.set(chunk, offset); offset += chunk.length; } const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", joined)), byte => byte.toString(16).padStart(2, "0")).join(""); if (actual !== expected) throw new Error("digest mismatch"); window.verifiedArchive = true; },
    close() {}
  }; }
});
createRoot(document.getElementById("root")!).render(<ExperimentalGiftRoute link={link} transport={transport} importGift={async () => { if (!window.verifiedArchive) throw new Error("unverified"); window.importCount++; return "imported"; }} onClose={() => {}} />);
