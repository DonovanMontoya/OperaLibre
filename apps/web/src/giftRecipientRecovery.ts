import { GiftChunkReceiver, type GiftChunkSink } from "./giftChunkReceiver.ts";
import type { GiftStagedPrefix } from "./giftNativeStaging";
import type { GiftLink } from "./ExperimentalGiftRoute";
import { giftBrokerOrigin } from "./giftBrokerOrigin.ts";
import { verifySignedPeerOffer, type PeerOfferBinding, type SignedPeerOffer } from "./giftSignedPreview.ts";
import { createGiftPeerProof } from "./giftPeerProof.ts";

type Staging = GiftChunkSink & { close(): void | Promise<void> };
export type RecoveryBinding = GiftStagedPrefix & { giftId: string; room: string; size: number; sha256: string; expiresAt: number };

export type RecoveryCapability = { payload: string; signature: string };
/** Bearer secrets: keep this record in app-private durable storage. An initial
 * record is seeded only after claim succeeds, with current decoded from token.
 * The pending pair must survive crashes and lost /resume responses. */
export type RecipientRecoveryState = {
  version: 1;
  broker: string;
  token: string;
  signingKey: string;
  archive: Omit<RecoveryBinding, keyof GiftStagedPrefix>;
  current: RecoveryCapability;
  pending?: { successor: RecoveryCapability; generation: number };
};

export type RecipientRecoverySignalingOptions = {
  load(giftId: string): Promise<RecipientRecoveryState>;
  /** Atomically compare the complete previous record and durably replace it.
   * Resolve true only after persistence; false means another attempt won.
   * Never mutate either argument, including on failure. */
  compareAndSwap(giftId: string, previous: RecipientRecoveryState, next: RecipientRecoveryState): Promise<boolean>;
  /** Obtain an owner-signed successor through an authenticated confidential
   * channel scoped to this recipient. No issuance or mailbox shortcut exists
   * here; possession of the original shared link alone is insufficient. */
  successor(current: Readonly<RecoveryCapability>, signal: AbortSignal): Promise<RecoveryCapability>;
  fetch?: typeof fetch;
};

const encoder = new TextEncoder();
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const validHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const validKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
const validGeneration = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < Number.MAX_SAFE_INTEGER;
const unavailable = () => new Error("Recovery signaling unavailable.");

function encode(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function recoveryClaim(capability: RecoveryCapability, binding: RecoveryBinding): { nonce: string; previousNonce?: string } {
  if (!capability || typeof capability.payload !== "string" || encoder.encode(capability.payload).length > 4096 || !validHash(capability.signature)) throw unavailable();
  const claim = JSON.parse(capability.payload);
  if (!claim || claim.role !== "recipient" || claim.room !== binding.room || claim.expiresAt !== binding.expiresAt || !validId(claim.nonce) || (claim.previousNonce !== undefined && !validId(claim.previousNonce))) throw unavailable();
  // This only checks scope. The broker verifies the capability MAC; peer
  // authentication still requires the separately pinned Ed25519 signing key.
  return claim;
}

/** Opt-in signaling building block, not a RecipientRecoveryProtocol or a live
 * transport. It never creates a peer, accepts frames, or activates the feature.
 * The caller must hold the native staging lock for binding.offset/prefixSha256
 * and retain the original verified archive descriptor. After receiveOffer(),
 * apply only that authenticated SDP, gather the complete local answer and call
 * answer() with its exact JSON. Frames still need an authenticated, bounded
 * data channel, cancellation/revocation monitoring and a verified receipt. */
export async function openRecipientRecoverySignaling(
  link: GiftLink, binding: Readonly<RecoveryBinding>, signal: AbortSignal,
  options: RecipientRecoverySignalingOptions,
): Promise<{
  generation: number;
  peerBinding: Readonly<PeerOfferBinding>;
  receiveOffer(): Promise<string | null>;
  answer(descriptionJson: string): Promise<void>;
  check(): Promise<void>;
}> {
  // Copy trusted inputs before any asynchronous storage or network operation.
  link = { ...link }; binding = Object.freeze({ ...binding });
  const broker = giftBrokerOrigin(link.broker);
  if (!broker || broker !== link.broker || !validKey(link.signingKey) || !validKey(link.previewKey) || !validId(binding.giftId) || !validId(binding.room) || !Number.isSafeInteger(binding.size) || binding.size <= 0 || binding.size > 25 * 1024 ** 3 || !validHash(binding.sha256) || !Number.isSafeInteger(binding.offset) || binding.offset < 0 || binding.offset > binding.size || !validHash(binding.prefixSha256) || !Number.isSafeInteger(binding.expiresAt) || typeof link.token !== "string" || !/^[A-Za-z0-9_-]{32,4096}$/.test(link.token)) throw unavailable();
  let deadline = Math.min(binding.expiresAt * 1000, Date.now() + 30_000);
  const live = () => { if (signal.aborted || Date.now() >= deadline) throw unavailable(); };
  live();

  // A stalled bridge callback must not keep the JS staging lock forever after
  // cancellation. A pending CAS can still commit: never retry it here or infer
  // failure. The next attempt reloads/reconciles the native atomic authority.
  async function callback<T>(operation: () => Promise<T>): Promise<T> {
    live();
    return new Promise<T>((resolve, reject) => {
      const abort = () => { cleanup(); reject(unavailable()); };
      const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      try {
        void operation().then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(unavailable()); });
      } catch { cleanup(); reject(unavailable()); }
    });
  }

  async function post(route: string, capability: RecoveryCapability, extra: object = {}): Promise<{ status: number; value: unknown }> {
    live();
    const body = JSON.stringify({ ...capability, ...extra });
    if (encoder.encode(body).length > 8192) throw unavailable();
    const controller = new AbortController(), abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, Math.max(1, Math.min(15_000, deadline - Date.now())));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await (options.fetch ?? fetch)(new URL(`/${route}/${binding.room}`, broker!), {
        method: "POST", headers: { "content-type": "application/json" }, body,
        credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal,
      });
      const parts: Uint8Array[] = []; let length = 0;
      reader = response.body?.getReader();
      while (reader) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > 160 * 1024) throw unavailable();
        parts.push(part.value);
      }
      if (controller.signal.aborted) throw unavailable();
      live();
      const bytes = new Uint8Array(length); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      return { status: response.status, value: length ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) : null };
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); controller.abort(); signal.removeEventListener("abort", abort); try { await reader?.cancel(); } finally { reader?.releaseLock(); } }
  }
  async function session(capability: RecoveryCapability): Promise<number | null> {
    const result = await post("session", capability);
    if (result.status === 403) return null;
    const value = result.value as { generation?: unknown } | null;
    if (result.status !== 200 || !value || !validGeneration(value.generation)) throw unavailable();
    return value.generation;
  }
  let state = structuredClone(await callback(() => options.load(binding.giftId)));
  live();
  if (!state || state.version !== 1 || state.broker !== broker || state.token !== link.token || state.signingKey !== link.signingKey || !state.archive || (["giftId", "room", "size", "sha256", "expiresAt"] as const).some(key => state.archive[key] !== binding[key])) throw unavailable();
  const currentClaim = recoveryClaim(state.current, binding);
  if (state.pending) {
    const nextClaim = recoveryClaim(state.pending.successor, binding);
    if (!validGeneration(state.pending.generation) || nextClaim.previousNonce !== currentClaim.nonce || nextClaim.nonce === currentClaim.nonce) throw unavailable();
  }
  async function persist(next: RecipientRecoveryState) {
    live();
    if (!await callback(() => options.compareAndSwap(binding.giftId, structuredClone(state), structuredClone(next)))) throw unavailable();
    state = next;
    live();
  }
  let generation = state.pending ? await session(state.pending.successor) : null;
  if (generation !== null && generation <= state.pending!.generation) throw unavailable();
  if (generation === null) {
    const base = await session(state.current);
    if (base === null) throw unavailable();
    let successor = state.pending?.successor;
    if (!successor) {
      successor = structuredClone(await callback(() => options.successor(Object.freeze({ ...state.current }), signal)));
      live();
      const claim = recoveryClaim(successor, binding);
      if (claim.previousNonce !== currentClaim.nonce || claim.nonce === currentClaim.nonce) throw unavailable();
    }
    // Retain both claims before the only mutating broker request. Reusing the
    // pending successor is safe only after /session has rejected it and accepted
    // current. A generation race fails closed and can be retried on a later open.
    await persist({ ...state, pending: { successor, generation: base } });
    try { await post("resume", state.current, { nextPayload: successor.payload, nextSignature: successor.signature, generation: base }); }
    catch { live(); /* A lost response does not establish failure. Probe next. */ }
    generation = await session(successor);
    if (generation === null || generation <= base) throw unavailable();
  }
  const { pending, ...rest } = state;
  if (!pending) throw unavailable();
  await persist({ ...rest, current: pending.successor });
  const active = { ...state.current }, activeGeneration = generation;
  const peerBinding: Readonly<PeerOfferBinding> = Object.freeze({
    giftId: binding.giftId, room: binding.room, expiresAt: binding.expiresAt,
    archiveSize: binding.size, archiveSha256: binding.sha256, generation: activeGeneration,
    offset: binding.offset, prefixSha256: binding.prefixSha256,
    challenge: encode(crypto.getRandomValues(new Uint8Array(32))),
  });
  const ready = await post("send", active, { generation: activeGeneration, sequence: 1, kind: "ready", message: JSON.stringify({ challenge: peerBinding.challenge, resume: { offset: binding.offset, prefixSha256: binding.prefixSha256 } }) });
  if (ready.status !== 204) throw unavailable();
  const consumed = new Set<string>(); let offer: string | undefined, reading = false, answered = false, failed = false;
  const usable = () => { live(); if (failed) throw unavailable(); };
  return {
    generation: activeGeneration, peerBinding,
    async receiveOffer() {
      usable();
      if (reading || offer !== undefined || answered) throw unavailable();
      reading = true;
      try {
        const result = await post("poll", active, { generation: activeGeneration, after: 0 });
        if (result.status !== 200 || !Array.isArray(result.value) || result.value.length > 1) throw unavailable();
        if (!result.value.length) return null;
        const item = result.value[0];
        if (!item || item.sequence !== 1 || item.kind !== "offer" || typeof item.message !== "string" || encoder.encode(item.message).length > 7168) throw unavailable();
        offer = await verifySignedPeerOffer(JSON.parse(item.message) as SignedPeerOffer, link.signingKey!, peerBinding, consumed);
        usable();
        return offer;
      } catch { failed = true; throw unavailable(); }
      finally { reading = false; }
    },
    async answer(descriptionJson) {
      usable();
      if (offer === undefined || answered) throw unavailable();
      answered = true;
      try {
        const proof = encode(await createGiftPeerProof(link.previewKey!, peerBinding, offer, descriptionJson));
        usable();
        const result = await post("send", active, { generation: activeGeneration, sequence: 2, kind: "answer", message: JSON.stringify({ descriptionJson, proof }) });
        if (result.status !== 204) throw unavailable();
        deadline = binding.expiresAt * 1000;
      } catch { failed = true; throw unavailable(); }
    },
    async check() {
      usable();
      try { if (await session(active) !== activeGeneration) throw unavailable(); }
      catch { failed = true; throw unavailable(); }
    },
  };
}

/** Trusted protocol adapter: it must securely obtain and persist a successor,
 * resolve ambiguous broker rotation, authenticate the sender against the link's
 * pinned key, and authenticate the sender's agreement to the entire binding.
 * Frames must come from that authenticated connection. It must observe abort
 * and close pending reads. The experimental peer adapter requires explicitly
 * configured private successor delivery and durable storage. */
export type RecipientRecoveryProtocol = {
  open(link: GiftLink, binding: Readonly<RecoveryBinding>, signal: AbortSignal): Promise<{
    binding: RecoveryBinding;
    next(signal: AbortSignal): Promise<Uint8Array | null>;
    /** Acknowledge only a chunk already persisted by the native sink. */
    persisted(offset: number, signal: AbortSignal): Promise<void>;
    /** Called only after native verification of the complete archive. Wait for
     * the sender's matching receipt confirmation before allowing import. */
    complete(signal: AbortSignal): Promise<void>;
    close(): void | Promise<void>;
  }>;
};

/** Recover under the native staging lock; no bytes are accepted until the
 * trusted protocol confirms the exact inspected prefix and archive identity. */
export async function receiveRecoveredGift(
  link: GiftLink,
  descriptor: Omit<RecoveryBinding, keyof GiftStagedPrefix>,
  signal: AbortSignal,
  recover: (giftId: string, maximumSize: number) => Promise<{ prefix: GiftStagedPrefix; staging: Staging }>,
  protocol: RecipientRecoveryProtocol
): Promise<void> {
  if (!link.signingKey || signal.aborted) throw new Error("Recovery unavailable.");
  const { prefix, staging } = await recover(descriptor.giftId, descriptor.size);
  let session: Awaited<ReturnType<RecipientRecoveryProtocol["open"]>> | undefined;
  let receiver: GiftChunkReceiver | undefined;
  try {
    if (!Number.isSafeInteger(prefix.offset) || prefix.offset < 0 || prefix.offset > descriptor.size || !/^[a-f0-9]{64}$/.test(prefix.prefixSha256) || signal.aborted) throw new Error("Invalid recovery prefix.");
    const binding: RecoveryBinding = { ...descriptor, offset: prefix.offset, prefixSha256: prefix.prefixSha256 };
    session = await protocol.open(link, Object.freeze({ ...binding }), signal);
    if (signal.aborted || (Object.keys(binding) as (keyof RecoveryBinding)[]).some(key => session!.binding?.[key] !== binding[key])) throw new Error("Recovery binding mismatch.");
    receiver = new GiftChunkReceiver(staging, descriptor.size, descriptor.sha256, prefix.offset);
    while (!signal.aborted) {
      const frame = await session.next(signal);
      if (signal.aborted || !(frame instanceof Uint8Array)) throw new Error("Recovery interrupted.");
      const final = frame.length > frame[0] + 9 && frame[frame[0] + 9] === 1;
      await receiver.receive(frame);
      if (signal.aborted) throw new Error("Recovery interrupted.");
      if (final) { await session.complete(signal); if (signal.aborted) throw new Error("Recovery interrupted."); return; }
      // receive() validated this archive frame and awaited its native append.
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      await session.persisted(Number(view.getBigUint64(frame[0] + 1)) + view.getUint32(frame[0] + 10), signal);
    }
    throw new Error("Recovery interrupted.");
  } finally {
    try { await session?.close(); } finally { try { await receiver?.close(); } finally { await staging.close(); } }
  }
}
