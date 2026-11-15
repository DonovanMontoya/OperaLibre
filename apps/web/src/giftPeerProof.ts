/** Proof of possession of the gift secret over an exact peer transcript.
 * This primitive is not connected to the production transport. */
export type GiftPeerProofBinding = { room: string; giftId: string; expiresAt: number; generation: number; archiveSize: number; archiveSha256: string; offset: number; prefixSha256: string; challenge: string };
const encoder = new TextEncoder();
const safeId = /^[A-Za-z0-9_-]{16,128}$/;
const digest = /^[a-f0-9]{64}$/;
const maxArchive = 25 * 1024 ** 3;

function decodeKey(key: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("Invalid proof key.");
  const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/") + "=");
  if (raw.length !== 32) throw new Error("Invalid proof key.");
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}
async function hash(text: string): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, "0")).join("");
}
export async function createGiftPeerProof(key: string, binding: GiftPeerProofBinding, offer: string, answer: string, now = Math.floor(Date.now() / 1000)): Promise<Uint8Array<ArrayBuffer>> {
  if (!safeId.test(binding.room) || !safeId.test(binding.giftId) || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= now || !Number.isSafeInteger(binding.generation) || binding.generation < 0 || !Number.isSafeInteger(binding.archiveSize) || binding.archiveSize <= 0 || binding.archiveSize > maxArchive || !Number.isSafeInteger(binding.offset) || binding.offset < 0 || binding.offset > binding.archiveSize || !digest.test(binding.archiveSha256) || !digest.test(binding.prefixSha256) || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(binding.challenge) || !offer || encoder.encode(offer).length > 4096 || !answer || encoder.encode(answer).length > 4096) throw new Error("Invalid peer proof binding.");
  const transcript = ["operalibre-peer-proof-v1", binding.room, binding.giftId, binding.expiresAt, binding.generation, binding.archiveSize, binding.archiveSha256, binding.offset, binding.prefixSha256, binding.challenge, await hash(offer), await hash(answer)].join("\n");
  const base = await crypto.subtle.importKey("raw", decodeKey(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, encoder.encode("operalibre-peer-proof-key-v1"));
  const proofKey = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", proofKey, encoder.encode(transcript)));
}
