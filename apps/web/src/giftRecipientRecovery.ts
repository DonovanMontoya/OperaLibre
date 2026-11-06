import { GiftChunkReceiver, type GiftChunkSink } from "./giftChunkReceiver.ts";
import type { GiftStagedPrefix } from "./giftNativeStaging";
import type { GiftLink } from "./ExperimentalGiftRoute";

type Staging = GiftChunkSink & { close(): void | Promise<void> };
export type RecoveryBinding = GiftStagedPrefix & { giftId: string; room: string; size: number; sha256: string; expiresAt: number };

/** Trusted protocol adapter: it must securely obtain and persist a successor,
 * resolve ambiguous broker rotation, authenticate the sender against the link's
 * pinned key, and authenticate the sender's agreement to the entire binding.
 * Frames must come from that authenticated connection. It must observe abort
 * and close pending reads. No such adapter is provided by the application. */
export type RecipientRecoveryProtocol = {
  open(link: GiftLink, binding: Readonly<RecoveryBinding>, signal: AbortSignal): Promise<{
    binding: RecoveryBinding;
    next(signal: AbortSignal): Promise<Uint8Array | null>;
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
      if (final) return;
    }
    throw new Error("Recovery interrupted.");
  } finally {
    try { await session?.close(); } finally { try { await receiver?.close(); } finally { await staging.close(); } }
  }
}
