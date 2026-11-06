import test from "node:test";
import assert from "node:assert/strict";
import { openRecipientRecoverySignaling, type RecipientRecoveryState } from "../src/giftRecipientRecovery.ts";

async function fixture(lost = false, failPersistence = false, tamperedOffer = false) {
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const binding = { giftId: "gift____________", room: "room____________", size: 10, sha256: "a".repeat(64), expiresAt, offset: 2, prefixSha256: "b".repeat(64) };
  const claim = (nonce: string, previousNonce?: string) => ({ payload: JSON.stringify({ room: binding.room, role: "recipient", nonce, expiresAt, ...(previousNonce ? { previousNonce } : {}) }), signature: "a".repeat(64) });
  const current = claim("current_________"), successor = claim("successor_______", "current_________");
  const signing = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const enc = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
  const link = { broker: "https://broker.example", token: Buffer.from(JSON.stringify(current)).toString("base64url"), signingKey: enc(await crypto.subtle.exportKey("raw", signing.publicKey)), previewKey: enc(new Uint8Array(32).fill(7)) };
  const { offset: _offset, prefixSha256: _prefix, ...archive } = binding;
  let stored: RecipientRecoveryState = { version: 1, broker: link.broker, token: link.token, signingKey: link.signingKey, archive, current };
  let active = current.payload, generation = 0, revoked = false;
  let peerBinding: Record<string, unknown> | undefined;
  const calls: string[] = [];
  const options = {
    async load() { return structuredClone(stored); },
    async compareAndSwap(_id: string, previous: RecipientRecoveryState, next: RecipientRecoveryState) {
      if (failPersistence || JSON.stringify(previous) !== JSON.stringify(stored)) return false;
      stored = structuredClone(next); return true;
    },
    async successor() { return successor; },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const route = new URL(String(input)).pathname.split("/")[1];
      const body = JSON.parse(String(init?.body)); calls.push(route);
      if (revoked) return new Response(null, { status: 403 });
      if (route === "session") return body.payload === active ? Response.json({ generation }) : new Response(null, { status: 403 });
      if (route === "resume") {
        assert.ok(stored.pending, "pending pair must be durable before rotation");
        assert.equal(body.payload, active); assert.equal(body.generation, generation);
        active = body.nextPayload; generation++;
        if (lost) throw new Error("lost response after commit");
        return new Response(null, { status: 204 });
      }
      assert.equal(body.payload, active); assert.equal(body.generation, generation);
      if (route === "send" && body.kind === "ready") {
        const ready = JSON.parse(body.message);
        peerBinding = { giftId: binding.giftId, room: binding.room, archiveSize: binding.size, archiveSha256: binding.sha256, expiresAt, generation, offset: ready.resume.offset, prefixSha256: ready.resume.prefixSha256, challenge: ready.challenge };
        return new Response(null, { status: 204 });
      }
      if (route === "poll") {
        const payload = new TextEncoder().encode(JSON.stringify({ version: 1, ...peerBinding, offer: JSON.stringify({ type: "offer", sdp: "fixture" }) }));
        const context = new TextEncoder().encode("operalibre-gift-peer-offer-v1\0");
        const signed = new Uint8Array(context.length + payload.length); signed.set(context); signed.set(payload, context.length);
        const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, signed));
        if (tamperedOffer) signature[0] ^= 1;
        return Response.json([{ sequence: 1, kind: "offer", message: JSON.stringify({ payload: enc(payload), signature: enc(signature) }) }]);
      }
      if (route === "send" && body.kind === "answer") {
        const answer = JSON.parse(body.message); assert.equal(body.sequence, 2); assert.match(answer.proof, /^[A-Za-z0-9_-]{43}$/);
        return new Response(null, { status: 204 });
      }
      throw new Error("unexpected route");
    }) as typeof fetch,
  };
  return { binding, link, options, calls, state: () => stored, revoke() { revoked = true; } };
}

test("recovery reconciles lost rotation and binds a signed offer to the staged prefix", async () => {
  const f = await fixture(true);
  const protocol = await openRecipientRecoverySignaling(f.link, f.binding, new AbortController().signal, f.options);
  assert.equal(protocol.generation, 1); assert.equal(f.state().pending, undefined);
  assert.equal(JSON.parse((await protocol.receiveOffer())!).type, "offer");
  await assert.rejects(protocol.receiveOffer(), /unavailable/i);
  await protocol.answer(JSON.stringify({ type: "answer", sdp: "fixture" }));
  await protocol.check();
  f.revoke(); await assert.rejects(protocol.check(), /unavailable/i);
});

test("recovery never rotates when durable pending-state persistence fails", async () => {
  const f = await fixture(false, true);
  await assert.rejects(openRecipientRecoverySignaling(f.link, f.binding, new AbortController().signal, f.options));
  assert.equal(f.calls.includes("resume"), false);
});

test("recovery rejects cancellation and mismatched archive identity before broker use", async () => {
  const f = await fixture();
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(openRecipientRecoverySignaling(f.link, f.binding, cancelled.signal, f.options));
  await assert.rejects(openRecipientRecoverySignaling(f.link, { ...f.binding, sha256: "c".repeat(64) }, new AbortController().signal, f.options));
  assert.equal(f.calls.length, 0);
});

test("recovery rejects a forged sender offer and cannot answer afterward", async () => {
  const f = await fixture(false, false, true);
  const protocol = await openRecipientRecoverySignaling(f.link, f.binding, new AbortController().signal, f.options);
  await assert.rejects(protocol.receiveOffer());
  await assert.rejects(protocol.answer(JSON.stringify({ type: "answer", sdp: "fixture" })));
});
