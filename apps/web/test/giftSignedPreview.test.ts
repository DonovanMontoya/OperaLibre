import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyEncryptedGiftPreview } from "../src/giftSignedPreview.ts";

function b64(bytes: ArrayBuffer | Uint8Array) { return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url"); }
const record = { version: 1, giftId: "gift____________", room: "room____________", expiresAt: 200, archiveSize: 22, archiveSha256: "a".repeat(64), sender: "Alex", title: "A book", author: "A writer", summary: "A summary", message: "Private note", assets: [{ name: "book.epub", kind: "ebook", size: 12, sha256: "b".repeat(64) }] };
async function envelope(value: unknown, badSignature = false) {
  const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const encryption = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, payload));
  if (badSignature) signature[0] ^= 1;
  const plain = new TextEncoder().encode(JSON.stringify({ payload: b64(payload), signature: b64(signature) }));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode("operalibre-gift-preview-v1") }, encryption, plain);
  return { envelope: { nonce: b64(nonce), ciphertext: b64(ciphertext) }, key: b64(await crypto.subtle.exportKey("raw", encryption)), publicKey: b64(await crypto.subtle.exportKey("raw", signing.publicKey)) };
}

test("decrypts and authenticates selected preview without transferring content", async () => {
  const input = await envelope(record);
  const verified = await verifyEncryptedGiftPreview(input.envelope, input.key, input.publicKey, 100);
  assert.equal(verified.preview.message, "Private note");
  assert.equal(verified.assets[0].sha256, "b".repeat(64));
  assert.equal(verified.transfer.sha256, "a".repeat(64));
  assert.equal(verified.transfer.room, record.room);
  assert.deepEqual(verified.preview.formats, ["EPUB"]);
  assert.equal(verified.preview.sizeBytes, record.archiveSize, "show actual transfer size including archive overhead");
});

test("rejects modified ciphertext, invalid signature and expired selection", async () => {
  const input = await envelope(record);
  const bytes = Buffer.from(input.envelope.ciphertext, "base64url"); bytes[0] ^= 1;
  await assert.rejects(verifyEncryptedGiftPreview({ ...input.envelope, ciphertext: bytes.toString("base64url") }, input.key, input.publicKey, 100));
  const forged = await envelope(record, true);
  await assert.rejects(verifyEncryptedGiftPreview(forged.envelope, forged.key, forged.publicKey, 100));
  await assert.rejects(verifyEncryptedGiftPreview(input.envelope, input.key, input.publicKey, 200));
});

test("rejects unselected paths and alignment without matching audio", async () => {
  for (const assets of [
    [{ ...record.assets[0], name: "../book.epub" }],
    [...record.assets, { name: "map.json", kind: "alignment", size: 4, sha256: "c".repeat(64) }]
  ]) {
    const input = await envelope({ ...record, assets });
    await assert.rejects(verifyEncryptedGiftPreview(input.envelope, input.key, input.publicKey, 100));
  }
});

test("accepts the Rust server's encrypted and signed envelope", { skip: !process.env.OPERALIBRE_PREVIEW_FIXTURE_PATH }, async () => {
  const fixture = JSON.parse(readFileSync(process.env.OPERALIBRE_PREVIEW_FIXTURE_PATH!, "utf8"));
  const verified = await verifyEncryptedGiftPreview(fixture.envelope, fixture.key, fixture.publicKey, 100);
  assert.equal(verified.preview.message, "Private note");
  assert.equal(verified.assets[0].name, "book.epub");
});
