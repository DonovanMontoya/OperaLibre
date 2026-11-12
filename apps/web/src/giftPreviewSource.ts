import { GiftScreenError } from "./GiftScreen";
import type { GiftLink } from "./ExperimentalGiftRoute";
import type { VerifiedPreviewSource } from "./giftRecipientTransport";
import { verifyEncryptedGiftPreview, type EncryptedGiftPreview } from "./giftSignedPreview";

/** Fetch only the encrypted preview. The capability is sent in the POST body;
 * fragment keys never leave the device. No archive endpoint is contacted. */
export const fetchVerifiedGiftPreview: VerifiedPreviewSource = async (link: GiftLink, signal: AbortSignal, authorization) => {
  link = { ...link };
  if (!link.previewKey || !link.signingKey || !/^[A-Za-z0-9_-]{32,4096}$/.test(link.token)) throw new GiftScreenError("unavailable");
  let credential: { payload: string; signature: string }, claim: { room: string; role: string; expiresAt: number };
  try {
    const raw = link.token.replace(/-/g, "+").replace(/_/g, "/");
    credential = JSON.parse(atob(raw + "=".repeat((4 - raw.length % 4) % 4)));
    claim = JSON.parse(credential.payload);
    if (!/^[a-f0-9]{64}$/.test(credential.signature) || claim.role !== "recipient" || !/^[A-Za-z0-9_-]{16,128}$/.test(claim.room) || !Number.isSafeInteger(claim.expiresAt)) throw new Error();
    if (authorization) {
      authorization = structuredClone(authorization);
      const refreshed = JSON.parse(authorization.capability.payload);
      if (!/^[a-f0-9]{64}$/.test(authorization.capability.signature) || authorization.capability.payload.length > 4096 || refreshed.role !== "recipient" || refreshed.room !== claim.room || refreshed.expiresAt !== claim.expiresAt || /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.exec(authorization.recoverySecret)?.[0] !== authorization.recoverySecret) throw new Error();
      credential = authorization.capability;
    }
  } catch { throw new GiftScreenError("unavailable"); }
  if (claim.expiresAt <= Math.floor(Date.now() / 1000)) throw new GiftScreenError("expired");
  let response: Response;
  try {
    const origin = new URL(link.broker);
    if (origin.protocol !== "https:" || origin.origin !== link.broker || origin.username || origin.password) throw new Error();
    response = await fetch(new URL(`/preview-read/${claim.room}`, origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...credential, ...(authorization ? { recoverySecret: authorization.recoverySecret } : {}) }), credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new GiftScreenError(typeof navigator !== "undefined" && !navigator.onLine ? "offline" : "unavailable");
  }
  if (!response.ok) throw new GiftScreenError(response.status === 410 ? "expired" : "unavailable");
  const reader = response.body?.getReader();
  if (!reader) throw new GiftScreenError("unavailable");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 180 * 1024) { await reader.cancel(); throw new GiftScreenError("unavailable"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as EncryptedGiftPreview;
    const verified = await verifyEncryptedGiftPreview(envelope, link.previewKey, link.signingKey);
    if (verified.transfer.room !== claim.room || verified.transfer.expiresAt !== claim.expiresAt || (link.giftId && link.giftId !== verified.giftId)) throw new Error();
    return verified;
  } catch { throw new GiftScreenError("unavailable"); }
};
