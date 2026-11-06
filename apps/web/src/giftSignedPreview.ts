import type { GiftDetails } from "./ExperimentalGiftRoute";
import type { NativeGiftAsset } from "./giftDeviceImport";
import { parseGiftIceConfiguration } from "./giftIceConfiguration.ts";
import { giftCoverPreviewDataUrl } from "./giftCoverPreview.ts";

export type EncryptedGiftPreview = { nonce: string; ciphertext: string };
export type VerifiedPreview = GiftDetails & { connectivity?: RTCConfiguration; transfer: { room: string; size: number; sha256: string; expiresAt: number } };
const MAX_PREVIEW_BYTES = 128 * 1024;
const MAX_CONTENT_BYTES = 25 * 1024 ** 3;
const context = new TextEncoder().encode("operalibre-gift-preview-v1");
const peerContext = new TextEncoder().encode("operalibre-gift-peer-offer-v1\0");

export type PeerOfferBinding = {
  giftId: string; room: string; expiresAt: number; archiveSize: number; archiveSha256: string;
  generation: number; offset: number; prefixSha256: string; challenge: string;
};
export type SignedPeerOffer = { payload: string; signature: string };

/** Verify before applying the returned complete SDP (including ICE). `expected`
 * must come from the verified link/preview and local recovery state, never the
 * broker. Generate a fresh random 32-byte challenge for every attempt and keep
 * the consumed set for the lifetime of those challenges, across concurrent
 * verifications. This primitive does not persist replay state or wire signaling. */
export async function verifySignedPeerOffer(
  signed: SignedPeerOffer, pinnedPublicKey: string, expected: PeerOfferBinding,
  consumedChallenges: Set<string>, nowSeconds?: number,
): Promise<string> {
  const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
  const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  const currentTime = () => nowSeconds ?? Math.floor(Date.now() / 1000);
  const challenge = decode(expected.challenge, 32);
  if (!validId(expected.giftId) || !validId(expected.room) || !Number.isSafeInteger(expected.expiresAt) || !Number.isSafeInteger(currentTime()) || expected.expiresAt <= currentTime() || !Number.isSafeInteger(expected.archiveSize) || expected.archiveSize <= 0 || expected.archiveSize > MAX_CONTENT_BYTES || !validHash(expected.archiveSha256) || !Number.isSafeInteger(expected.generation) || expected.generation < 0 || !Number.isSafeInteger(expected.offset) || expected.offset < 0 || expected.offset > expected.archiveSize || !validHash(expected.prefixSha256) || challenge.length !== 32 || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(expected.challenge) || consumedChallenges.has(expected.challenge)) throw new Error("Invalid or expired peer binding.");
  const payload = decode(signed.payload, 400 * 1024), signature = decode(signed.signature, 64), publicBytes = decode(pinnedPublicKey, 32);
  if (signature.length !== 64 || publicBytes.length !== 32) throw new Error("Invalid peer key or signature.");
  const message = new Uint8Array(peerContext.length + payload.length);
  message.set(peerContext); message.set(payload, peerContext.length);
  const publicKey = await crypto.subtle.importKey("raw", publicBytes, "Ed25519", false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", publicKey, signature, message)) throw new Error("Peer authentication failed.");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid peer offer.");
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || Object.entries(expected).some(([key, expectedValue]) => record[key] !== expectedValue) || typeof record.offer !== "string" || !record.offer || new TextEncoder().encode(record.offer).length > 64 * 1024 || expected.expiresAt <= currentTime() || consumedChallenges.has(expected.challenge)) throw new Error("Invalid, expired or replayed peer offer.");
  consumedChallenges.add(expected.challenge);
  return record.offer;
}

function decode(value: unknown, maximum: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > Math.ceil(maximum * 4 / 3) + 4) throw new Error("Invalid preview encoding.");
  const input = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(input + "=".repeat((4 - input.length % 4) % 4));
  if (binary.length > maximum) throw new Error("Preview too large.");
  return Uint8Array.from(binary, value => value.charCodeAt(0));
}
function text(value: unknown, max: number, required = false): string | null {
  if (value == null && !required) return null;
  if (typeof value !== "string" || Array.from(value).length > max || (required && !value.trim())) throw new Error("Invalid preview text.");
  return value;
}

/** Authenticate exact payload bytes against the public key carried in the
 * gift link. The encryption key must also remain in the link fragment and
 * must never be sent to the broker. */
export async function verifyEncryptedGiftPreview(envelope: EncryptedGiftPreview, decryptionKey: string, pinnedPublicKey: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<VerifiedPreview> {
  const nonce = decode(envelope.nonce, 12), ciphertext = decode(envelope.ciphertext, MAX_PREVIEW_BYTES);
  const keyBytes = decode(decryptionKey, 32), publicBytes = decode(pinnedPublicKey, 32);
  if (nonce.length !== 12 || keyBytes.length !== 32 || publicBytes.length !== 32) throw new Error("Invalid preview key.");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: context }, key, ciphertext);
  if (decrypted.byteLength > MAX_PREVIEW_BYTES) throw new Error("Preview too large.");
  const signed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decrypted)) as { payload: string; signature: string };
  const payload = decode(signed.payload, MAX_PREVIEW_BYTES), signature = decode(signed.signature, 64);
  if (signature.length !== 64) throw new Error("Invalid preview signature.");
  const publicKey = await crypto.subtle.importKey("raw", publicBytes, "Ed25519", false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", publicKey, signature, payload)) throw new Error("Preview authentication failed.");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid preview.");
  const record = value as Record<string, unknown>;
  const giftId = record.giftId, room = record.room, expiresAt = record.expiresAt, archiveSize = record.archiveSize, archiveSha256 = record.archiveSha256;
  if (record.version !== 1 || typeof giftId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(giftId) || typeof room !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(room) || !Number.isSafeInteger(expiresAt) || (expiresAt as number) <= nowSeconds || !Number.isSafeInteger(archiveSize) || (archiveSize as number) <= 0 || (archiveSize as number) > MAX_CONTENT_BYTES || typeof archiveSha256 !== "string" || !/^[a-f0-9]{64}$/.test(archiveSha256)) throw new Error("Invalid or expired preview.");
  const sender = text(record.sender, 128, true)!, title = text(record.title, 1024, true)!, author = text(record.author, 1024), summary = text(record.summary, 32000), message = text(record.message, 1000);
  if (!Array.isArray(record.assets) || !record.assets.length || record.assets.length > 256) throw new Error("Invalid selected assets.");
  const names = new Set<string>(); let total = 0;
  const assets: NativeGiftAsset[] = record.assets.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid asset.");
    const asset = item as Record<string, unknown>, name = asset.name, kind = asset.kind, size = asset.size, sha256 = asset.sha256;
    if (typeof name !== "string" || !name || name === "." || name === ".." || name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(name) || names.has(name.toLowerCase()) || typeof kind !== "string" || !["ebook", "audio", "cover", "metadata", "alignment"].includes(kind) || !Number.isSafeInteger(size) || (size as number) < 0 || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid asset.");
    names.add(name.toLowerCase()); total += size as number;
    if (!Number.isSafeInteger(total) || total > MAX_CONTENT_BYTES) throw new Error("Gift is too large.");
    return { name, kind: kind as NativeGiftAsset["kind"], size: size as number, sha256 };
  });
  if (assets.some(asset => asset.kind === "alignment") && (!assets.some(asset => asset.kind === "ebook") || !assets.some(asset => asset.kind === "audio"))) throw new Error("Invalid read-along selection.");
  const formats = [...new Set(assets.filter(asset => asset.kind === "ebook" || asset.kind === "audio" || asset.kind === "alignment").map(asset => {
    if (asset.kind === "alignment") return "Read-along";
    const extension = asset.name.split(".").pop() ?? "";
    return /^[a-z0-9]{1,8}$/i.test(extension) ? extension.toUpperCase() : asset.kind === "ebook" ? "Ebook" : "Audiobook";
  }))];
  if (!formats.length) throw new Error("Gift has no book files.");
  const connectivity = parseGiftIceConfiguration(record.connectivity, giftId, expiresAt as number);
  if (record.cover !== undefined && record.cover !== null && !assets.some(asset => asset.kind === "cover")) throw new Error("Preview includes an unselected cover.");
  const coverUrl = giftCoverPreviewDataUrl(record.cover);
  return { giftId, assets, metadata: { title, author, description: summary }, preview: { sender, title, author, summary, message, coverUrl, formats, sizeBytes: archiveSize as number }, transfer: { room, size: archiveSize as number, sha256: archiveSha256, expiresAt: expiresAt as number }, ...(connectivity ? { connectivity } : {}) };
}
