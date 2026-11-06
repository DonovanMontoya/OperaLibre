import broker, { SecureRoom } from "../../../share-broker/src/index";
import { createPersistentGiftTransport } from "../src/giftPersistentTransport";
import { createNativeGiftRecoveryStorage } from "../src/giftNativeRecovery";
import { createGiftStagingManager } from "../src/giftNativeStaging";
import { fetchVerifiedGiftPreview } from "../src/giftPreviewSource";
import type { GiftLink } from "../src/ExperimentalGiftRoute";
import type { RecoveryCapability, RecipientRecoveryState } from "../src/giftRecipientRecovery";
import type { PeerOfferBinding } from "../src/giftSignedPreview";

// Real Worker routes, signed/encrypted preview, persistent transport, storage
// adapter and peer authentication. Native persistence, native archive IO and
// WebRTC are simulated; this fixture does not extract/import a real archive.
type Attempt = { generation: number; offset: number; prefix: string; proofVerified: boolean; remoteDescriptions: number; deliveredBytes: number; confirmed: boolean };
type Checkpoint = { outcome: "success" | "failed"; bytes: number; imports: number; digestVerified: boolean; recoveryClaimRequests: number; successorRequests: number };
type Result = {
  status: "running" | "done" | "fixture-error"; errors: string[]; gateClosed: boolean;
  preview: { routes: string[]; creates: number; bytes: number; recipientClaimed: boolean; producerClaimed: boolean; statePresent: boolean } | null;
  previewFetches: number; creates: number; seedWrites: number; recoveryClaimRequests: number;
  successorRequests: number; cachedSuccessors: number; missingSecretDenied: number; lostResponses: number;
  claimBodiesIdentical: boolean; persistedBeforeClaim: boolean; pendingBeforeResume: boolean;
  attempts: Attempt[]; checkpoints: Checkpoint[]; events: string[]; persistedOffsets: number[];
  imports: number; receipts: number; digestVerified: boolean; lockReleased: boolean;
  oldPreviewStatus: number | null; currentSessionStatus: number | null; initialSessionStatus: number | null;
  archiveSize: number; stagedBytes: number; archiveMatches: boolean; linkUnchanged: boolean;
  linkProbe: { generation: number; ready: number; session: number; poll: number; preview: number; authorizedSession: number } | null;
  initialCASStalls: number; abortedLockReleased: boolean; lateCommitObserved: boolean; lateSecretRetained: boolean;
  transportInstances: number; authenticatedPreviewRequests: number; currentPreviewStatus: number | null; restartPreviewSafe: boolean;
};
declare global { interface Window { persistentGiftResult: Result } }
const result: Result = window.persistentGiftResult = {
  status: "running", errors: [], gateClosed: false, preview: null, previewFetches: 0, creates: 0,
  seedWrites: 0, recoveryClaimRequests: 0, successorRequests: 0, cachedSuccessors: 0,
  missingSecretDenied: 0, lostResponses: 0, claimBodiesIdentical: true,
  persistedBeforeClaim: true, pendingBeforeResume: true, attempts: [], checkpoints: [], events: [],
  persistedOffsets: [], imports: 0, receipts: 0, digestVerified: false, lockReleased: false,
  oldPreviewStatus: null, currentSessionStatus: null, initialSessionStatus: null,
  archiveSize: 0, stagedBytes: 0, archiveMatches: false, linkUnchanged: false,
  linkProbe: null, initialCASStalls: 0, abortedLockReleased: false, lateCommitObserved: false, lateSecretRetained: false,
  transportInstances: 0, authenticatedPreviewRequests: 0, currentPreviewStatus: null, restartPreviewSafe: false,
};
function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) { result.errors.push(message); throw new Error(message); }
}
const encoder = new TextEncoder();
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));
async function hash(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join(""); }
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
  const mode = new URLSearchParams(location.search).get("case") ?? "resume";
  const room = "persistent_room1", giftId = "persistent_gift1";
  const ownerSecret = encode(crypto.getRandomValues(new Uint8Array(32)));
  const stores = new Map<string, ReturnType<typeof memoryStorage>>(), objects = new Map<string, SecureRoom>();
  const env = {
    EXPERIMENTAL_ENABLED: "true", OWNER_SECRET_DIGEST_HEX: await hash(encoder.encode(ownerSecret)),
    SIGNING_SECRET: encode(crypto.getRandomValues(new Uint8Array(32))), CAPABILITY_SECRET: "unused-fixture-secret",
    ROOMS: { idFromName(name: string) { return name; }, get(id: unknown) {
      const name = String(id);
      if (!objects.has(name)) { const store = memoryStorage(); stores.set(name, store); objects.set(name, new SecureRoom({ storage: store }, env)); }
      return objects.get(name)!;
    } },
  };
  async function post(route: string, body: unknown, owner = false) {
    return broker.fetch(new Request(`https://broker.test/${route}`, {
      method: "POST", headers: { "content-type": "application/json", ...(owner ? { authorization: `Bearer ${ownerSecret}` } : {}) }, body: JSON.stringify(body),
    }), env);
  }
  result.gateClosed = (await broker.fetch(new Request(`https://broker.test/recovery-claim/${room}`, { method: "POST" }), { ...env, EXPERIMENTAL_ENABLED: undefined })).status === 503;
  const expiresAt = Math.floor(Date.now() / 1000) + 60;
  async function issue(role: string, nonce: string): Promise<RecoveryCapability> {
    const response = await post("issue", { room, role, nonce, expiresAt }, true);
    ensure(response.status === 200, "fixture issuance failed"); return response.json();
  }
  const producer = await issue("producer", "persistent_prod1"), recipient = await issue("recipient", "persistent_recv1");
  const signing = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]), previewKey = crypto.getRandomValues(new Uint8Array(32));
  const archive = encoder.encode("retained original archive for persistent recovery"), archiveHash = await hash(archive);
  result.archiveSize = archive.length;
  const link: GiftLink = {
    broker: "https://broker.test", token: encode(encoder.encode(JSON.stringify(recipient))), previewKey: encode(previewKey),
    signingKey: encode(new Uint8Array(await crypto.subtle.exportKey("raw", signing.publicKey))),
    ...(mode === "restart" ? { giftId } : {}),
  };
  const originalLink = JSON.stringify(link);
  const previewRecord = {
    version: 1, giftId, room, expiresAt, archiveSize: archive.length, archiveSha256: archiveHash,
    sender: "Alex", title: "Persistent gift", author: "A writer", summary: "Recovery fixture", message: "Private note",
    assets: [{ name: "book.epub", kind: "ebook", size: 12, sha256: await hash(encoder.encode("ebook fixture")) }],
  };
  const payload = encoder.encode(JSON.stringify(previewRecord));
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, payload));
  const encryption = await crypto.subtle.importKey("raw", previewKey, "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode("operalibre-gift-preview-v1") }, encryption, encoder.encode(JSON.stringify({ payload: encode(payload), signature: encode(signature) }))));
  ensure((await post(`preview-put/${room}`, { nonce: encode(nonce), ciphertext: encode(ciphertext), expiresAt }, true)).status === 204, "preview publication failed");

  // The native bridge is simulated as a serialized durable record; use the
  // actual storage adapter's validation, immutable scope and CAS snapshots.
  let rawState: string | null = null, staged = new Uint8Array(), initialClaimBody: string | undefined;
  let enteredCAS!: () => void, releaseCAS!: () => void, committedCAS!: () => void, stalledSecret: string | undefined;
  const casEntered = new Promise<void>(resolve => { enteredCAS = resolve; });
  const casRelease = new Promise<void>(resolve => { releaseCAS = resolve; });
  const casCommitted = new Promise<void>(resolve => { committedCAS = resolve; });
  const readState = () => rawState === null ? null : JSON.parse(rawState) as RecipientRecoveryState;
  const storage = createNativeGiftRecoveryStorage({
    async loadRecoveryState() { return { state: rawState }; },
    async compareAndSwapRecoveryState({ previous, next }) {
      if (previous !== rawState || (mode === "cas-failure" && previous === null)) return { swapped: false };
      if (mode === "stalled-cas" && previous === null) {
        result.initialCASStalls++; stalledSecret = JSON.parse(next).recoverySecret;
        enteredCAS(); await casRelease;
        ensure(previous === rawState, "late initial CAS overwrote another state");
      }
      rawState = next;
      if (previous === null) { result.seedWrites++; result.events.push("state-seeded"); }
      if (mode === "stalled-cas" && previous === null) committedCAS();
      return { swapped: true };
    },
  }, () => true);
  const stages = createGiftStagingManager({
    async prepareArchive() { result.creates++; ensure(result.creates === 1, "retry truncated the staging archive"); staged = new Uint8Array(); },
    async inspectArchive() { return { offset: staged.length, prefixSha256: await hash(staged) }; },
    async append(_giftId, bytes) { const next = new Uint8Array(staged.length + bytes.length); next.set(staged); next.set(bytes, staged.length); staged = next; },
    async verifyArchive({ size, sha256 }) {
      ensure(staged.length === size && await hash(staged) === sha256, "full archive digest mismatch");
      result.digestVerified = true; result.events.push("digest-verified");
    },
  }, () => true);
  const bindings = new Map<number, PeerOfferBinding>(), peers = new Map<number, FakePeer>();
  const offerFor = (generation: number) => JSON.stringify({ type: "offer", sdp: `simulated gathered offer generation ${generation}` });
  const answerFor = (generation: number) => ({ type: "answer", sdp: `simulated gathered answer generation ${generation}` });
  class FakeChannel extends EventTarget {
    label = "operalibre-share"; ordered = true; maxRetransmits = null; maxPacketLifeTime = null;
    negotiated = false; protocol = ""; binaryType = ""; readyState = "open";
    constructor(private peer: FakePeer) { super(); }
    close() { if (this.readyState !== "closed") { this.readyState = "closed"; this.dispatchEvent(new Event("close")); } }
    send(text: string) {
      const message = JSON.parse(text), attempt = this.peer.attempt;
      if (message.type === "persisted") {
        ensure(message.offset === staged.length && message.offset === this.peer.sentOffset, "persisted receipt preceded native append");
        result.persistedOffsets.push(message.offset);
        if ((mode === "resume" || mode === "restart") && attempt.generation === 1) queueMicrotask(() => this.close());
        else queueMicrotask(() => this.peer.sendNext());
        return;
      }
      ensure(message.type === "verified" && result.digestVerified && staged.length === archive.length && message.size === archive.length && message.sha256 === archiveHash, "verified receipt preceded complete digest");
      result.receipts++; result.events.push("verified-receipt");
      queueMicrotask(() => {
        attempt.confirmed = true; result.events.push("receipt-confirmed");
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "receipt-confirmed", size: archive.length, sha256: archiveHash }) }));
      });
    }
  }
  class FakePeer extends EventTarget {
    iceGatheringState = "complete"; connectionState = "connected"; localDescription: unknown = null;
    channel: FakeChannel; sentOffset: number;
    constructor(public attempt: Attempt) { super(); this.channel = new FakeChannel(this); this.sentOffset = attempt.offset; }
    async setRemoteDescription(value: unknown) { ensure(JSON.stringify(value) === offerFor(this.attempt.generation), "unexpected remote SDP"); this.attempt.remoteDescriptions++; }
    async createAnswer() { return answerFor(this.attempt.generation); }
    async setLocalDescription(value: unknown) { this.localDescription = value; }
    close() { this.connectionState = "closed"; this.channel.close(); }
    deliver() {
      ensure(this.attempt.proofVerified, "data preceded independently verified proof");
      const event = new Event("datachannel"); Object.defineProperty(event, "channel", { value: this.channel }); this.dispatchEvent(event); this.sendNext();
    }
    sendNext() {
      if (this.channel.readyState !== "open") return;
      const bytes = archive.slice(this.sentOffset, this.sentOffset + 8), final = this.sentOffset === archive.length;
      const message = frame(this.sentOffset, bytes, final); this.sentOffset += bytes.length; this.attempt.deliveredBytes += bytes.length;
      this.channel.dispatchEvent(new MessageEvent("message", { data: message.buffer }));
    }
  }
  // Independently verify the exact broker-stored producer/recipient transcript.
  // A different generation must fail verification of the same proof.
  async function verifyProof(binding: PeerOfferBinding, descriptionJson: string, proof: string) {
    ensure(descriptionJson === JSON.stringify(answerFor(binding.generation)), "unexpected answer JSON");
    const base = await crypto.subtle.importKey("raw", previewKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const derived = await crypto.subtle.sign("HMAC", base, encoder.encode("operalibre-peer-proof-key-v1"));
    const key = await crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const transcript = async (generation: number) => encoder.encode([
      "operalibre-peer-proof-v1", room, giftId, expiresAt, generation, archive.length, archiveHash, binding.offset,
      binding.prefixSha256, binding.challenge, await hash(encoder.encode(offerFor(binding.generation))), await hash(encoder.encode(descriptionJson)),
    ].join("\n"));
    ensure(await crypto.subtle.verify("HMAC", key, decode(proof), await transcript(binding.generation)), "answer proof failed");
    ensure(!await crypto.subtle.verify("HMAC", key, decode(proof), await transcript(binding.generation + 1)), "answer proof replayed across generations");
  }
  let producerClaimed = false;
  const receiverRoutes: string[] = [];
  const fixtureFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url), route = url.pathname.split("/")[1];
    ensure(url.origin === link.broker, "unexpected fixture destination");
    receiverRoutes.push(route);
    const body = await request.clone().json(), state = readState();
    if (route === "preview-read") {
      result.previewFetches++;
      if (body.recoverySecret !== undefined) {
        ensure(state?.recoverySecret === body.recoverySecret && state.current.payload === body.payload && state.current.signature === body.signature, "restart preview did not use native current claim and secret");
        ensure(request.url === `${link.broker}/preview-read/${room}` && ![...request.headers.values()].some(value => value.includes(body.recoverySecret)), "recovery secret escaped the preview POST body");
        result.authenticatedPreviewRequests++;
      }
    }
    if (route === "recovery-claim") {
      result.recoveryClaimRequests++;
      result.persistedBeforeClaim &&= Boolean(state?.recoverySecret && state.recoverySecret === body.recoverySecret && state.current.payload === recipient.payload);
      ensure(result.persistedBeforeClaim, "recovery enrollment preceded durable secret state");
      const encodedBody = JSON.stringify(body);
      if (initialClaimBody === undefined) initialClaimBody = encodedBody;
      result.claimBodiesIdentical &&= initialClaimBody === encodedBody;
    }
    if (route === "resume") {
      result.pendingBeforeResume &&= Boolean(state?.pending && state.pending.successor.payload === body.nextPayload && state.pending.successor.signature === body.nextSignature && state.recoverySecret === body.recoverySecret);
      ensure(result.pendingBeforeResume, "broker rotation preceded durable pending pair");
    }
    const response = await broker.fetch(request, env);
    if (route === "recovery-claim" && response.status === 204 && result.linkProbe === null) {
      // Probe while the original claim is still active at generation zero.
      // Without the separate enrollment secret, even the original signed link
      // must not inject ready, discover a session, poll, or read the preview.
      const active = await post(`session/${room}`, { ...recipient, recoverySecret: state!.recoverySecret });
      ensure(active.status === 200, "enrolled original claim is not active");
      const generation = (await active.json()).generation;
      ensure(generation === 0, "link probe ran after rotation");
      result.linkProbe = {
        generation, authorizedSession: active.status,
        ready: (await post(`send/${room}`, { ...recipient, generation, sequence: 1, kind: "ready", message: JSON.stringify({ challenge: encode(crypto.getRandomValues(new Uint8Array(32))) }) })).status,
        session: (await post(`session/${room}`, recipient)).status,
        poll: (await post(`poll/${room}`, { ...recipient, generation, after: 0 })).status,
        preview: (await post(`preview-read/${room}`, recipient)).status,
      };
      ensure([result.linkProbe.ready, result.linkProbe.session, result.linkProbe.poll, result.linkProbe.preview].every(status => status === 403), "enrolled room accepted original link without secret");
    }
    if (route === "recovery-claim" && response.status === 204 && mode.startsWith("lost-claim") && result.lostResponses === 0) {
      result.lostResponses++; throw new TypeError("simulated lost successful enrollment response");
    }
    if (route === "recovery-successor") {
      result.successorRequests++;
      if (response.status === 200) {
        const next = await response.clone().json(), currentClaim = JSON.parse(body.payload), nextClaim = JSON.parse(next.payload);
        ensure(nextClaim.previousNonce === currentClaim.nonce && nextClaim.expiresAt === expiresAt && nextClaim.room === room && nextClaim.role === "recipient", "incorrect scoped successor");
        const cached = await post(`recovery-successor/${room}`, body);
        ensure(cached.status === 200 && JSON.stringify(await cached.json()) === JSON.stringify(next), "successor changed after response retry"); result.cachedSuccessors++;
        const denied = await post(`recovery-successor/${room}`, { payload: body.payload, signature: body.signature });
        ensure(denied.status === 403, "successor issued without recipient secret"); result.missingSecretDenied++;
      }
    }
    if (route === "send" && response.status === 204) {
      if (!producerClaimed) { ensure((await post(`claim/${room}`, producer)).status === 204, "producer claim failed"); producerClaimed = true; }
      const polled = await post(`poll/${room}`, { ...producer, generation: body.generation, after: body.kind === "ready" ? 0 : 1 });
      ensure(polled.status === 200, "producer poll failed"); const signals = await polled.json();
      ensure(signals.length === 1 && signals[0].kind === body.kind && signals[0].sequence === (body.kind === "ready" ? 1 : 2), "unexpected producer signal queue");
      const message = JSON.parse(signals[0].message);
      if (body.kind === "ready") {
        ensure(message.resume.offset === staged.length && message.resume.prefixSha256 === await hash(archive.slice(0, staged.length)), "sender rejected staged prefix against retained archive");
        const binding: PeerOfferBinding = { giftId, room, expiresAt, archiveSize: archive.length, archiveSha256: archiveHash, generation: body.generation, offset: message.resume.offset, prefixSha256: message.resume.prefixSha256, challenge: message.challenge };
        bindings.set(binding.generation, binding);
        result.attempts.push({ generation: binding.generation, offset: binding.offset, prefix: binding.prefixSha256, proofVerified: false, remoteDescriptions: 0, deliveredBytes: 0, confirmed: false });
        const payload = encoder.encode(JSON.stringify({ version: 1, ...binding, offer: offerFor(binding.generation) })), context = encoder.encode("operalibre-gift-peer-offer-v1\0");
        const transcript = new Uint8Array(context.length + payload.length); transcript.set(context); transcript.set(payload, context.length);
        const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", signing.privateKey, transcript));
        if (mode === "forged-offer") signature[0] ^= 1;
        ensure((await post(`send/${room}`, { ...producer, generation: binding.generation, sequence: 1, kind: "offer", message: JSON.stringify({ payload: encode(payload), signature: encode(signature) }) })).status === 204, "producer offer failed");
      } else if (body.kind === "answer") {
        const binding = bindings.get(body.generation), peer = peers.get(body.generation);
        ensure(binding && peer, "answer without matching generation peer"); await verifyProof(binding, message.descriptionJson, message.proof);
        peer.attempt.proofVerified = true; queueMicrotask(() => peer.deliver());
      }
    }
    return response;
  };
  // The production preview source uses global fetch; route only its test broker
  // requests through the actual Worker without contacting a remote service.
  const originalFetch = window.fetch;
  window.fetch = (input, init) => new URL(input instanceof Request ? input.url : String(input), location.href).origin === link.broker ? fixtureFetch(input, init) : originalFetch(input, init);
  function makeTransport() {
    result.transportInstances++;
    return createPersistentGiftTransport(fetchVerifiedGiftPreview, {
      storage, stages, fetch: fixtureFetch,
      peer() { const attempt = result.attempts[result.attempts.length - 1]; ensure(attempt, "peer before ready"); const peer = new FakePeer(attempt); peers.set(attempt.generation, peer); return peer as unknown as RTCPeerConnection; },
    });
  }
  let transport = makeTransport(), details = await transport.preview(link, new AbortController().signal);
  result.preview = {
    routes: [...receiverRoutes], creates: result.creates, bytes: staged.length,
    recipientClaimed: Boolean(await stores.get(room)!.get("claim:recipient")),
    producerClaimed: Boolean(await stores.get(room)!.get("claim:producer")), statePresent: rawState !== null,
  };
  async function accept(signal = new AbortController().signal) {
    let outcome: Checkpoint["outcome"] = "failed";
    try {
      await transport.receive(link, details, signal);
      // This callback models the caller's publication boundary; no real native
      // extraction or library write occurs in this receiver integration fixture.
      const importGift = async () => {
        ensure(result.digestVerified && result.attempts[result.attempts.length - 1]?.confirmed, "import preceded full verified receipt");
        result.imports++; result.events.push("import");
      };
      await importGift(); outcome = "success";
    } catch { /* The scenario assertions below distinguish expected failures. */ }
    result.checkpoints.push({ outcome, bytes: staged.length, imports: result.imports, digestVerified: result.digestVerified, recoveryClaimRequests: result.recoveryClaimRequests, successorRequests: result.successorRequests });
  }
  if (mode === "revoked") ensure((await post(`revoke/${room}`, {}, true)).status === 204, "revocation failed");
  if (mode === "stalled-cas") {
    const controller = new AbortController(), receiving = accept(controller.signal);
    await casEntered;
    ensure(rawState === null && result.recoveryClaimRequests === 0, "stalled initial CAS enrolled a recipient");
    controller.abort(); await receiving;
    // Cancellation must settle the call before the bridge operation resolves.
    // Release the mock staging lock, then let the uncertain CAS commit late.
    const unlocked = await stages.recover(giftId, archive.length); await unlocked.staging.close(); result.abortedLockReleased = true;
    ensure(rawState === null, "stalled CAS committed before explicit release");
    releaseCAS(); await casCommitted;
    result.lateCommitObserved = readState()?.recoverySecret === stalledSecret;
    ensure(result.lateCommitObserved && result.recoveryClaimRequests === 0, "late CAS started enrollment after abort");
  } else await accept();
  if (mode === "resume" || mode === "restart" || mode.startsWith("lost-claim") || mode === "stalled-cas") {
    if (mode === "lost-claim-revoked") ensure((await post(`revoke/${room}`, {}, true)).status === 204, "revocation after lost claim failed");
    if (mode === "resume" || mode === "restart") result.oldPreviewStatus = (await post(`preview-read/${room}`, recipient)).status;
    if (mode === "restart") {
      const stored = readState(); ensure(stored, "missing persisted state after interrupted transfer");
      result.currentPreviewStatus = (await post(`preview-read/${room}`, { ...stored.current, recoverySecret: stored.recoverySecret })).status;
      const previousDetails = JSON.stringify(details), previousState = rawState, previousBytes = staged.length, previousAttempts = result.attempts.length, requestCursor = receiverRoutes.length;
      // A new factory instance has no verified-preview cache. Only native state,
      // staged bytes and the unchanged original gift link survive this restart.
      transport = makeTransport(); details = await transport.preview(link, new AbortController().signal);
      result.restartPreviewSafe = JSON.stringify(details) === previousDetails && rawState === previousState && staged.length === previousBytes && result.attempts.length === previousAttempts && JSON.stringify(receiverRoutes.slice(requestCursor)) === JSON.stringify(["preview-read"]);
      ensure(result.restartPreviewSafe, "restart preview changed staging/state or began a transfer");
    } else {
      const cached = await transport.preview(link, new AbortController().signal);
      ensure(JSON.stringify(cached) === JSON.stringify(details), "cached verified preview changed on retry");
    }
    await accept();
  }
  const released = await stages.recover(giftId, archive.length); await released.staging.close(); result.lockReleased = true;
  const finalState = readState();
  result.initialSessionStatus = (await post(`session/${room}`, recipient)).status;
  if (finalState) result.currentSessionStatus = (await post(`session/${room}`, { ...finalState.current, recoverySecret: finalState.recoverySecret })).status;
  if (mode === "stalled-cas") result.lateSecretRetained = finalState?.recoverySecret === stalledSecret;
  result.stagedBytes = staged.length; result.archiveMatches = await hash(staged) === archiveHash;
  result.linkUnchanged = JSON.stringify(link) === originalLink; result.status = "done";
}

void run().catch(error => { result.status = "fixture-error"; result.errors.push(String(error)); }).finally(() => {
  document.getElementById("result")!.textContent = JSON.stringify(result);
  document.documentElement.dataset.complete = "true";
});
