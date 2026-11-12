import { openRecipientRecoverySignaling, type RecipientRecoveryProtocol, type RecipientRecoverySignalingOptions } from "./giftRecipientRecovery.ts";

const MAX_FRAME = 64 * 1024 + 21;
const MAX_QUEUED = 256 * 1024;
const GATHER_WAIT_MS = 2500;
const unavailable = () => new Error("Recovery peer unavailable.");

function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    const abort = () => { cleanup(); reject(unavailable()); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** Opt-in peer adapter. No application default enables recovery or supplies a
 * successor: its caller must configure confidential delivery and durable CAS.
 * Signaling uses complete gathered SDP, not unauthenticated trickle messages. */
export function createExperimentalRecoveryPeer(options: RecipientRecoverySignalingOptions & {
  iceServers?: RTCIceServer[];
  iceTransportPolicy?: RTCIceTransportPolicy;
  peer?: (configuration: RTCConfiguration) => RTCPeerConnection;
  gatherWaitMs?: number;
}): RecipientRecoveryProtocol {
  return { async open(link, binding, outerSignal) {
    link = { ...link }; binding = Object.freeze({ ...binding });
    const controller = new AbortController();
    const abort = () => controller.abort();
    outerSignal.addEventListener("abort", abort, { once: true });
    if (outerSignal.aborted) controller.abort();
    let timer = setTimeout(abort, Math.max(1, Math.min(30_000, binding.expiresAt * 1000 - Date.now())));
    let peer: RTCPeerConnection | undefined, channel: RTCDataChannel | undefined;
    let failed = false, closed = false, completing = false, confirmed = false;
    let queued = 0, reading = false;
    let persisted = binding.offset;
    const frames: Uint8Array[] = [];
    let wake: (() => void) | undefined;
    const live = () => { if (closed || failed || controller.signal.aborted) throw unavailable(); };
    const close = () => {
      if (closed) return;
      closed = true; clearTimeout(timer); controller.abort();
      outerSignal.removeEventListener("abort", abort);
      frames.length = 0; queued = 0;
      channel?.close(); peer?.close(); wake?.();
    };
    const fail = () => { failed = true; close(); };
    controller.signal.addEventListener("abort", fail, { once: true });
    try {
      live();
      const signaling = await openRecipientRecoverySignaling(link, binding, controller.signal, options);
      live();
      peer = (options.peer ?? (configuration => new RTCPeerConnection(configuration)))({ iceServers: options.iceServers ?? [], iceTransportPolicy: options.iceTransportPolicy ?? "all" });
      const connection = peer;
      connection.addEventListener("connectionstatechange", () => {
        if (connection.connectionState === "failed" || connection.connectionState === "closed") fail();
      });
      connection.addEventListener("datachannel", event => {
        const incoming = event.channel;
        if (closed || channel || incoming.label !== "operalibre-share" || !incoming.ordered || incoming.maxRetransmits !== null || incoming.maxPacketLifeTime !== null || incoming.negotiated || incoming.protocol) { incoming.close(); fail(); return; }
        channel = incoming; incoming.binaryType = "arraybuffer";
        incoming.addEventListener("error", fail, { once: true });
        incoming.addEventListener("close", () => { if (!confirmed) fail(); }, { once: true });
        incoming.addEventListener("message", event => {
          try {
            live();
            if (typeof event.data === "string") {
              if (!completing || confirmed || event.data.length > 512) throw unavailable();
              const receipt = JSON.parse(event.data);
              if (!receipt || Object.keys(receipt).sort().join(",") !== "sha256,size,type" || receipt.type !== "receipt-confirmed" || receipt.size !== binding.size || receipt.sha256 !== binding.sha256) throw unavailable();
              confirmed = true; wake?.(); return;
            }
            if (completing || !(event.data instanceof ArrayBuffer) || event.data.byteLength < 21 || event.data.byteLength > MAX_FRAME || frames.length >= 32 || queued + event.data.byteLength > MAX_QUEUED) throw unavailable();
            const frame = new Uint8Array(event.data).slice();
            queued += frame.length; frames.push(frame); wake?.();
          } catch { fail(); }
        });
      });
      let offer: string | null = null;
      while (offer === null) {
        offer = await signaling.receiveOffer(); live();
        if (offer === null) await pause(250, controller.signal);
      }
      await connection.setRemoteDescription(JSON.parse(offer)); live();
      await connection.setLocalDescription(await connection.createAnswer()); live();
      // Gathering can outlast the connection attempt, for example while a STUN
      // server goes unanswered on one interface. After a short wait, answer
      // with the addresses found so far; the sender learns any other working
      // address from the connection checks themselves.
      const gatherUntil = Date.now() + (options.gatherWaitMs ?? GATHER_WAIT_MS);
      while (connection.iceGatheringState !== "complete" && !(Date.now() >= gatherUntil && connection.localDescription?.sdp.includes("a=candidate:"))) await pause(50, controller.signal);
      const answer = JSON.stringify(connection.localDescription);
      if (!answer) throw unavailable();
      await signaling.answer(answer); live();
      clearTimeout(timer);
      timer = setTimeout(abort, Math.max(1, binding.expiresAt * 1000 - Date.now()));
      // Monitor generation as well as revoke/expiry; a competing rotation must
      // stop this attempt. Already in-flight frames cannot be recalled.
      void (async () => {
        try { while (!closed) { await pause(1000, controller.signal); await signaling.check(); } }
        catch { if (!closed) fail(); }
      })();
      async function wait(signal: AbortSignal) {
        live();
        if (signal.aborted) { fail(); throw unavailable(); }
        await new Promise<void>(resolve => {
          const notify = () => { signal.removeEventListener("abort", interrupted); if (wake === notify) wake = undefined; resolve(); };
          const interrupted = () => { fail(); notify(); };
          wake = notify; signal.addEventListener("abort", interrupted, { once: true });
          if (signal.aborted) interrupted();
        });
        live();
      }
      return {
        binding: { ...binding },
        async next(signal) {
          live();
          if (reading || completing) throw unavailable();
          reading = true;
          try {
            while (!frames.length) await wait(signal);
            if (signal.aborted) { fail(); throw unavailable(); }
            const frame = frames.shift()!; queued -= frame.length;
            return frame;
          } finally { reading = false; }
        },
        async persisted(offset, signal) {
          live();
          if (signal.aborted || completing || !channel || channel.readyState !== "open" || !Number.isSafeInteger(offset) || offset <= persisted || offset > binding.size || offset - persisted > 64 * 1024) { fail(); throw unavailable(); }
          try { channel.send(JSON.stringify({ type: "persisted", offset })); persisted = offset; }
          catch { fail(); throw unavailable(); }
        },
        async complete(signal) {
          live();
          if (reading || completing || frames.length || persisted !== binding.size || !channel || channel.readyState !== "open") throw unavailable();
          completing = true;
          await signaling.check(); live();
          channel.send(JSON.stringify({ type: "verified", size: binding.size, sha256: binding.sha256 }));
          while (!confirmed) await wait(signal);
          if (signal.aborted) { fail(); throw unavailable(); }
          live();
        },
        close,
      };
    } catch { fail(); throw unavailable(); }
  } };
}
