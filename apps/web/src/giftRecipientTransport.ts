import { GiftScreenError } from "./GiftScreen";
import type { GiftDetails, GiftLink, GiftTransport } from "./ExperimentalGiftRoute";
import { GiftChunkReceiver, type GiftChunkSink } from "./giftChunkReceiver";
import { createNativeGiftStaging } from "./giftNativeStaging";

export type VerifiedRecipientDetails = GiftDetails & { transfer: { room: string; size: number; sha256: string; expiresAt: number } };
type Capability = { payload: string; signature: string };
type Signal = { sequence: number; kind: "offer" | "ice"; message: string };
type Staging = GiftChunkSink & { close(): void | Promise<void> };

/** No verifier is supplied by default: a caller must authenticate the preview
 * and bind its archive digest, size, room and selection before returning it. */
export type VerifiedPreviewSource = (link: GiftLink, signal: AbortSignal) => Promise<VerifiedRecipientDetails>;

function capability(token: string, expected: VerifiedRecipientDetails["transfer"]): Capability {
  try {
    const normalized = token.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4))) as Capability;
    const claim = JSON.parse(decoded.payload) as { room: string; role: string; expiresAt: number };
    if (!/^[a-f0-9]{64}$/.test(decoded.signature) || claim.role !== "recipient" || claim.room !== expected.room || claim.expiresAt !== expected.expiresAt || claim.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error();
    return decoded;
  } catch { throw new GiftScreenError("unavailable"); }
}

async function responseBytes(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > limit) { await reader.cancel(); throw new GiftScreenError("unavailable"); } parts.push(value); }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(size); let at = 0;
  for (const part of parts) { output.set(part, at); at += part.length; }
  return output;
}

async function brokerPost(link: GiftLink, route: string, body: unknown, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(route, link.broker), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal });
  } catch (error) { if (signal.aborted) throw error; throw new GiftScreenError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "unavailable"); }
  if (!response.ok) throw new GiftScreenError(response.status === 410 ? "expired" : "unavailable");
  const bytes = await responseBytes(response, 160 * 1024);
  return bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : null;
}

function waitForGathering(peer: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (peer.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => { peer.removeEventListener("icegatheringstatechange", change); signal.removeEventListener("abort", abort); };
    const change = () => { if (peer.iceGatheringState === "complete") { cleanup(); resolve(); } };
    const abort = () => { cleanup(); reject(new GiftScreenError("unavailable")); };
    peer.addEventListener("icegatheringstatechange", change); signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else change();
  });
}

/** The caller supplies owner-controlled ICE servers; no public TURN service is
 * configured implicitly. Resume is deliberately unavailable until the sender
 * and broker negotiate and authenticate the offset. */
export function createExperimentalRecipientTransport(
  verifiedPreview: VerifiedPreviewSource,
  options: { iceServers?: RTCIceServer[]; stage?: (giftId: string) => Promise<Staging>; peer?: (configuration: RTCConfiguration) => RTCPeerConnection } = {}
): GiftTransport {
  return {
    async preview(link, signal) { return verifiedPreview(link, signal); },
    async receive(link, details, outerSignal) {
      const transfer = (details as Partial<VerifiedRecipientDetails>).transfer;
      if (!transfer || !/^[A-Za-z0-9_-]{16,128}$/.test(transfer.room) || !Number.isSafeInteger(transfer.size) || transfer.size <= 0 || transfer.size > 25 * 1024 ** 3 || !/^[a-f0-9]{64}$/.test(transfer.sha256) || !Number.isSafeInteger(transfer.expiresAt)) throw new GiftScreenError("unavailable");
      if (transfer.expiresAt <= Math.floor(Date.now() / 1000)) throw new GiftScreenError("expired");
      const credential = capability(link.token, transfer);
      const controller = new AbortController();
      const abort = () => controller.abort();
      outerSignal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, Math.max(1, (transfer.expiresAt * 1000) - Date.now()));
      let peer: RTCPeerConnection | null = null; let stage: Staging | null = null; let receiver: GiftChunkReceiver | null = null; let monitoring = true;
      try {
        if (outerSignal.aborted) throw new GiftScreenError("unavailable");
        await brokerPost(link, `/claim/${transfer.room}`, credential, controller.signal);
        stage = await (options.stage ?? createNativeGiftStaging)(details.giftId);
        receiver = new GiftChunkReceiver(stage, transfer.size, transfer.sha256);
        const activeReceiver = receiver;
        peer = (options.peer ?? (config => new RTCPeerConnection(config)))({ iceServers: options.iceServers ?? [] });
        const connection = peer;
        const finished = new Promise<void>((resolve, reject) => {
          const fail = () => reject(new GiftScreenError("unavailable"));
          controller.signal.addEventListener("abort", fail, { once: true });
          connection.addEventListener("datachannel", event => {
            const channel = event.channel; channel.binaryType = "arraybuffer";
            channel.addEventListener("message", message => {
              if (!(message.data instanceof ArrayBuffer)) { channel.close(); fail(); return; }
              const frame = new Uint8Array(message.data);
              const final = frame.length > frame[0] + 9 && frame[frame[0] + 9] === 1;
              void activeReceiver.receive(frame).then(() => { if (final) resolve(); }).catch(() => { channel.close(); fail(); });
            });
            channel.addEventListener("error", fail, { once: true });
            channel.addEventListener("close", fail, { once: true });
          }, { once: true });
        });
        // Attach an early rejection handler while offer/answer negotiation runs.
        void finished.catch(() => undefined);
        let cursor = 0; let offer: string | null = null;
        while (!offer) {
          const signals = await brokerPost(link, `/poll/${transfer.room}`, { ...credential, after: cursor }, controller.signal) as Signal[];
          if (!Array.isArray(signals) || signals.length > 32) throw new GiftScreenError("unavailable");
          for (const item of signals) {
            if (!Number.isSafeInteger(item.sequence) || item.sequence <= cursor || item.sequence > 32 || typeof item.message !== "string" || item.message.length > 4096) throw new GiftScreenError("unavailable");
            cursor = item.sequence;
            if (item.kind === "offer") { offer = item.message; break; }
            throw new GiftScreenError("unavailable");
          }
          if (!offer) await new Promise<void>((resolve, reject) => { const wait = setTimeout(resolve, 250); controller.signal.addEventListener("abort", () => { clearTimeout(wait); reject(new GiftScreenError("unavailable")); }, { once: true }); });
        }
        await connection.setRemoteDescription(JSON.parse(offer));
        await connection.setLocalDescription(await connection.createAnswer());
        await waitForGathering(connection, controller.signal);
        await brokerPost(link, `/send/${transfer.room}`, { ...credential, sequence: 1, kind: "answer", message: JSON.stringify(connection.localDescription) }, controller.signal);
        // Revocation is observed on the next broker poll; queued bytes cannot
        // be recalled. Denial or network loss fails closed.
        const monitor = async () => {
          while (monitoring && !controller.signal.aborted) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            if (!monitoring) break;
            try { await brokerPost(link, `/poll/${transfer.room}`, { ...credential, after: cursor }, controller.signal); } catch { controller.abort(); break; }
          }
        };
        void monitor();
        await finished;
      } finally {
        monitoring = false; clearTimeout(timer); controller.abort(); peer?.close(); await receiver?.close(); await stage?.close(); outerSignal.removeEventListener("abort", abort);
      }
    }
  };
}
