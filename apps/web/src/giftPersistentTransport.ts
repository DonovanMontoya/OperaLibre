import type { GiftLink, GiftTransport } from "./ExperimentalGiftRoute";
import { GiftScreenError } from "./GiftScreen";
import { giftBrokerOrigin } from "./giftBrokerOrigin.ts";
import { buildImportBase } from "./giftDeviceImport.ts";
import type { GiftChunkSink } from "./giftChunkReceiver.ts";
import type { GiftStagedPrefix } from "./giftNativeStaging.ts";
import { createExperimentalRecoveryPeer } from "./giftRecoveryPeer.ts";
import { receiveRecoveredGift, type RecipientRecoveryState, type RecoveryCapability } from "./giftRecipientRecovery.ts";
import type { VerifiedPreviewSource, VerifiedRecipientDetails } from "./giftRecipientTransport";

type Staging = GiftChunkSink & { close(): void | Promise<void> };
type Storage = {
  loadOptional(giftId: string): Promise<RecipientRecoveryState | null>;
  compareAndSwap(giftId: string, previous: RecipientRecoveryState | null, next: RecipientRecoveryState): Promise<boolean>;
};
type Stages = {
  create(giftId: string): Promise<Staging>;
  recover(giftId: string, size: number): Promise<{ prefix: GiftStagedPrefix; staging: Staging }>;
};
const canonicalKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.exec(value)?.[0] === value;

/** Explicitly configured, still gated by the application. A fresh acceptance
 * persists an independent recovery secret before the idempotent broker claim.
 * It then uses the same authenticated prefix/peer path as subsequent attempts.
 * The first rotation consumes one of the broker's sixteen rotation slots. */
export function createPersistentGiftTransport(verifiedPreview: VerifiedPreviewSource, options: {
  storage: Storage; stages: Stages; fetch?: typeof fetch; iceServers?: RTCIceServer[];
  peer?: (configuration: RTCConfiguration) => RTCPeerConnection;
}): GiftTransport {
  // Cache verified metadata within a screen. On relaunch, the link's opaque ID
  // locates private native state for an authenticated current-member lookup.
  let cached: { identity: string; details: VerifiedRecipientDetails } | undefined;
  function identity(link: GiftLink) {
    if (giftBrokerOrigin(link.broker) !== link.broker || !canonicalKey(link.previewKey) || !canonicalKey(link.signingKey) || !/^[A-Za-z0-9_-]{32,4096}$/.test(link.token)) throw new GiftScreenError("unavailable");
    if (link.giftId !== undefined && /^[A-Za-z0-9_-]{16,128}$/.exec(link.giftId)?.[0] !== link.giftId) throw new GiftScreenError("unavailable");
    return JSON.stringify([link.broker, link.token, link.signingKey, link.previewKey, link.giftId]);
  }
  return {
    async preview(link, signal) {
      link = Object.freeze({ ...link });
      const key = identity(link);
      if (signal.aborted) throw new GiftScreenError("unavailable");
      if (cached?.identity === key) {
        if (cached.details.transfer.expiresAt <= Math.floor(Date.now() / 1000)) throw new GiftScreenError("expired");
        return structuredClone(cached.details);
      }
      let stored: RecipientRecoveryState | null = null;
      if (link.giftId) {
        const loading = options.storage.loadOptional(link.giftId);
        const controller = new AbortController(), abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, 15_000);
        try {
          stored = await new Promise<RecipientRecoveryState | null>((resolve, reject) => {
            const fail = () => reject(new GiftScreenError("unavailable"));
            controller.signal.addEventListener("abort", fail, { once: true });
            void loading.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", fail)).catch(() => undefined);
            if (signal.aborted) abort();
          });
        } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
      }
      let details: VerifiedRecipientDetails;
      if (stored) {
        stored = structuredClone(stored);
        if (stored.broker !== link.broker || stored.token !== link.token || stored.signingKey !== link.signingKey || stored.archive.giftId !== link.giftId || !canonicalKey(stored.recoverySecret)) throw new GiftScreenError("unavailable");
        const credentials = stored.pending ? [stored.pending.successor, stored.current] : [stored.current];
        let recovered: VerifiedRecipientDetails | undefined;
        for (const capability of credentials) {
          if (signal.aborted) throw new GiftScreenError("unavailable");
          try { recovered = await verifiedPreview(link, signal, { capability, recoverySecret: stored.recoverySecret }); break; }
          catch { /* Either member may be active after a lost rotation response. */ }
        }
        if (!recovered || (["room", "size", "sha256", "expiresAt"] as const).some(name => recovered!.transfer[name] !== stored!.archive[name]) || recovered.giftId !== stored.archive.giftId) throw new GiftScreenError("unavailable");
        details = recovered;
      } else details = await verifiedPreview(link, signal);
      if (signal.aborted) throw new GiftScreenError("unavailable");
      cached = { identity: key, details: structuredClone(details) };
      return details;
    },
    async receive(link, details, signal) {
      link = Object.freeze({ ...link });
      const key = identity(link);
      if (!cached || cached.identity !== key || JSON.stringify(details) !== JSON.stringify(cached.details) || signal.aborted) throw new GiftScreenError("unavailable");
      const trusted = structuredClone(cached.details), descriptor = { giftId: trusted.giftId, ...trusted.transfer };
      try { buildImportBase(trusted.giftId, trusted.assets, trusted.metadata); }
      catch { throw new GiftScreenError("unsupported"); }
      if (descriptor.expiresAt <= Math.floor(Date.now() / 1000)) throw new GiftScreenError("expired");
      const deadline = Math.min(descriptor.expiresAt * 1000, Date.now() + 30_000);
      function callback<T>(operation: () => Promise<T>, late?: (value: T) => void): Promise<T> {
        if (signal.aborted || Date.now() >= deadline) return Promise.reject(new GiftScreenError("unavailable"));
        return new Promise<T>((resolve, reject) => {
          let cancelled = false;
          const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
          const abort = () => { cancelled = true; cleanup(); reject(new GiftScreenError("unavailable")); };
          const timer = setTimeout(abort, Math.max(1, deadline - Date.now()));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) { abort(); return; }
          try { void operation().then(value => { cleanup(); if (cancelled) late?.(value); else resolve(value); }, () => { cleanup(); reject(new GiftScreenError("unavailable")); }).catch(() => undefined); }
          catch { cleanup(); reject(new GiftScreenError("unavailable")); }
        });
      }
      let credential: RecoveryCapability;
      try {
        const normalized = link.token.replace(/-/g, "+").replace(/_/g, "/");
        credential = JSON.parse(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)));
        const claim = JSON.parse(credential.payload);
        if (!/^[a-f0-9]{64}$/.test(credential.signature) || claim.role !== "recipient" || claim.room !== descriptor.room || claim.expiresAt !== descriptor.expiresAt) throw new Error();
      } catch { throw new GiftScreenError("unavailable"); }
      let state = await callback(() => options.storage.loadOptional(trusted.giftId));
      if (signal.aborted) throw new GiftScreenError("unavailable");
      if (!state) {
        const staging = await callback(() => options.stages.create(trusted.giftId), stage => { void Promise.resolve(stage.close()).catch(() => undefined); });
        try {
          if (signal.aborted) throw new GiftScreenError("unavailable");
          const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          state = { version: 1, broker: link.broker, token: link.token, signingKey: link.signingKey!, archive: descriptor, current: credential, recoverySecret: secret };
          if (!await callback(() => options.storage.compareAndSwap(trusted.giftId, null, state!))) throw new GiftScreenError("unavailable");
        } finally {
          // A cancelled or timed-out CAS may still commit. Request lease release
          // but never pretend an unsettled native queue has already unlocked.
          const closing = Promise.resolve(staging.close());
          void closing.catch(() => undefined);
          if (!signal.aborted && Date.now() < deadline) await callback(() => closing);
        }
      }
      if (signal.aborted || state.broker !== link.broker || state.token !== link.token || state.signingKey !== link.signingKey || !canonicalKey(state.recoverySecret) || (["giftId", "room", "size", "sha256", "expiresAt"] as const).some(name => state!.archive[name] !== descriptor[name])) throw new GiftScreenError("unavailable");
      if (state.current.payload === credential.payload && state.current.signature === credential.signature && !state.pending) {
        // A pending initial claim can be retried, including after a lost response.
        const controller = new AbortController(), abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, Math.max(1, Math.min(15_000, descriptor.expiresAt * 1000 - Date.now())));
        try {
          if (signal.aborted) throw new GiftScreenError("unavailable");
          const response = await (options.fetch ?? fetch)(new URL(`/recovery-claim/${descriptor.room}`, link.broker), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...credential, recoverySecret: state.recoverySecret }), credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal });
          try { if (response.status !== 204 || controller.signal.aborted) throw new GiftScreenError("unavailable"); }
          finally { await response.body?.cancel(); }
        } finally { clearTimeout(timer); controller.abort(); signal.removeEventListener("abort", abort); }
      }
      const protocol = createExperimentalRecoveryPeer({ ...options, ...(trusted.connectivity ? { iceServers: trusted.connectivity.iceServers, iceTransportPolicy: trusted.connectivity.iceTransportPolicy } : {}), load: async giftId => {
        const loaded = await options.storage.loadOptional(giftId);
        if (!loaded) throw new GiftScreenError("unavailable"); return loaded;
      }, compareAndSwap: options.storage.compareAndSwap });
      await receiveRecoveredGift(link, descriptor, signal, options.stages.recover, protocol);
    }
  };
}
