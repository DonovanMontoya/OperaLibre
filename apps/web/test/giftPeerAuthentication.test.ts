import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifySignedPeerOffer, type PeerOfferBinding } from "../src/giftSignedPreview.ts";

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
const binding: PeerOfferBinding = { giftId: "gift____________", room: "room____________", expiresAt: 200, archiveSize: 22, archiveSha256: "a".repeat(64), generation: 2, offset: 4, prefixSha256: "b".repeat(64), challenge: b64(new Uint8Array(32).fill(3)) };
const offer = "v=0\r\na=candidate:1\r\n";
async function signedOffer(value: unknown = { version: 1, ...binding, offer }, domain = "operalibre-gift-peer-offer-v1\0") {
  const key = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const prefix = new TextEncoder().encode(domain), message = new Uint8Array(prefix.length + payload.length);
  message.set(prefix); message.set(payload, prefix.length);
  return { signed: { payload: b64(payload), signature: b64(await crypto.subtle.sign("Ed25519", key.privateKey, message)) }, publicKey: b64(await crypto.subtle.exportKey("raw", key.publicKey)) };
}

test("authenticates gathered offer and consumes challenge only once, including concurrent attempts", async () => {
  const input = await signedOffer(), used = new Set<string>();
  const results = await Promise.allSettled([1, 2].map(() => verifySignedPeerOffer(input.signed, input.publicKey, binding, used, 100)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal((results.find(result => result.status === "fulfilled") as PromiseFulfilledResult<string>).value, offer);
  await assert.rejects(verifySignedPeerOffer(input.signed, input.publicKey, binding, used, 100));
});

test("rejects every changed binding, changed payload, wrong key, domain and expiration", async () => {
  const input = await signedOffer();
  const alterations: Partial<PeerOfferBinding>[] = [
    { giftId: "other___________" }, { room: "other___________" }, { expiresAt: 201 },
    { archiveSize: 23 }, { archiveSha256: "c".repeat(64) }, { generation: 3 },
    { offset: 5 }, { prefixSha256: "c".repeat(64) }, { challenge: b64(new Uint8Array(32).fill(4)) },
  ];
  for (const alteration of alterations) await assert.rejects(verifySignedPeerOffer(input.signed, input.publicKey, { ...binding, ...alteration }, new Set(), 100));
  const payload = JSON.parse(Buffer.from(input.signed.payload, "base64url").toString()); payload.offer += "tampered";
  await assert.rejects(verifySignedPeerOffer({ ...input.signed, payload: b64(Buffer.from(JSON.stringify(payload))) }, input.publicKey, binding, new Set(), 100));
  const other = await signedOffer();
  await assert.rejects(verifySignedPeerOffer(input.signed, other.publicKey, binding, new Set(), 100));
  const wrongDomain = await signedOffer(undefined, "operalibre-gift-preview-v1");
  await assert.rejects(verifySignedPeerOffer(wrongDomain.signed, wrongDomain.publicKey, binding, new Set(), 100));
  await assert.rejects(verifySignedPeerOffer(input.signed, input.publicKey, binding, new Set(), 200));
  await assert.rejects(verifySignedPeerOffer(input.signed, input.publicKey, { ...binding, offset: 23 }, new Set(), 100));
});

test("accepts Rust's signed offer", { skip: !process.env.OPERALIBRE_PEER_FIXTURE_PATH }, async () => {
  const fixture = JSON.parse(readFileSync(process.env.OPERALIBRE_PEER_FIXTURE_PATH!, "utf8"));
  const { version: _version, offer: _offer, ...expected } = fixture.binding;
  assert.equal(await verifySignedPeerOffer(fixture.signed, fixture.publicKey, expected, new Set(), 100), offer);
});
