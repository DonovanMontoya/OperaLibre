import { Capacitor, registerPlugin } from "@capacitor/core";
import { giftBrokerOrigin } from "./giftBrokerOrigin.ts";
import type { RecipientRecoveryState, RecoveryCapability } from "./giftRecipientRecovery";

export type NativeGiftRecoveryBackend = {
  loadRecoveryState(input: { giftId: string }): Promise<{ state: string | null }>;
  compareAndSwapRecoveryState(input: { giftId: string; previous: string | null; next: string }): Promise<{ swapped: boolean }>;
};

const native = registerPlugin<NativeGiftRecoveryBackend>("GiftImport");
const encoder = new TextEncoder();
const MAX_STATE_BYTES = 16 * 1024;
const unavailable = () => new Error("Native gift recovery storage unavailable.");
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.exec(value)?.[0] === value;
const validId = (value: unknown): value is string => matches(value, /^[A-Za-z0-9_-]{16,128}$/);
const validHash = (value: unknown): value is string => matches(value, /^[a-f0-9]{64}$/);

function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  const record = value as Record<string, unknown>;
  if (required.some(key => !Object.prototype.hasOwnProperty.call(record, key)) || Object.keys(record).some(key => !required.includes(key) && !optional.includes(key))) throw unavailable();
  return record;
}

function capability(value: unknown, archive: RecipientRecoveryState["archive"]): { value: RecoveryCapability; nonce: string; previousNonce?: string } {
  const record = object(value, ["payload", "signature"]);
  if (typeof record.payload !== "string" || encoder.encode(record.payload).length > 4096 || !validHash(record.signature)) throw unavailable();
  const claim = object(JSON.parse(record.payload), ["room", "role", "nonce", "expiresAt"], ["previousNonce"]);
  if (claim.role !== "recipient" || claim.room !== archive.room || claim.expiresAt !== archive.expiresAt || !validId(claim.nonce)
    || (claim.previousNonce !== undefined && (!validId(claim.previousNonce) || claim.previousNonce === claim.nonce))) throw unavailable();
  return { value: { payload: record.payload, signature: record.signature }, nonce: claim.nonce, previousNonce: claim.previousNonce as string | undefined };
}

/** Validate and copy only this version's bounded record. Signed payload strings
 * are preserved byte for byte; object property order does not affect CAS. */
function snapshot(giftId: string, value: unknown): RecipientRecoveryState {
  const record = object(value, ["version", "broker", "token", "signingKey", "archive", "current"], ["pending"]);
  const rawArchive = object(record.archive, ["giftId", "room", "size", "sha256", "expiresAt"]);
  if (record.version !== 1 || typeof record.broker !== "string" || record.broker.length > 512 || giftBrokerOrigin(record.broker) !== record.broker
    || !matches(record.token, /^[A-Za-z0-9_-]{32,4096}$/)
    || !matches(record.signingKey, /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/)
    || rawArchive.giftId !== giftId || !validId(rawArchive.room) || !Number.isSafeInteger(rawArchive.size) || (rawArchive.size as number) <= 0 || (rawArchive.size as number) > 25 * 1024 ** 3
    || !validHash(rawArchive.sha256) || !Number.isSafeInteger(rawArchive.expiresAt) || (rawArchive.expiresAt as number) <= 0) throw unavailable();
  const archive = { giftId, room: rawArchive.room, size: rawArchive.size as number, sha256: rawArchive.sha256, expiresAt: rawArchive.expiresAt as number };
  const current = capability(record.current, archive);
  const result: RecipientRecoveryState = { version: 1, broker: record.broker, token: record.token, signingKey: record.signingKey, archive, current: current.value };
  if (Object.prototype.hasOwnProperty.call(record, "pending")) {
    const pending = object(record.pending, ["successor", "generation"]);
    const successor = capability(pending.successor, archive);
    if (!Number.isSafeInteger(pending.generation) || (pending.generation as number) < 0 || (pending.generation as number) >= Number.MAX_SAFE_INTEGER
      || successor.previousNonce !== current.nonce || successor.nonce === current.nonce) throw unavailable();
    result.pending = { successor: successor.value, generation: pending.generation as number };
  }
  if (encoder.encode(JSON.stringify(result)).length > MAX_STATE_BYTES) throw unavailable();
  return result;
}

function scope(state: RecipientRecoveryState): string {
  return JSON.stringify([state.version, state.broker, state.token, state.signingKey, state.archive]);
}

/** The backend must compare and persist under a native lock, across WebViews.
 * No JS mutex or localStorage fallback can provide that guarantee. Seeding with
 * previous=null is only for a caller whose initial broker claim succeeded and
 * whose gift archive has already been staged. This module never claims a gift
 * or enables the experimental native plugin. Its native record lock does not
 * cover Filesystem.appendFile: transfer exclusion across WebViews/processes
 * still requires a native staging lease and serialized append before rollout. */
export function createNativeGiftRecoveryStorage(backend: NativeGiftRecoveryBackend, available: () => boolean = () => Capacitor.isNativePlatform()) {
  function check(giftId: string) {
    if (!available() || !validId(giftId)) throw unavailable();
  }
  return {
    async load(giftId: string): Promise<RecipientRecoveryState> {
      try {
        check(giftId);
        const result = await backend.loadRecoveryState({ giftId });
        if (typeof result.state !== "string" || encoder.encode(result.state).length > MAX_STATE_BYTES) throw unavailable();
        return snapshot(giftId, JSON.parse(result.state));
      } catch { throw unavailable(); }
    },
    async compareAndSwap(giftId: string, previous: RecipientRecoveryState | null, next: RecipientRecoveryState): Promise<boolean> {
      try {
        check(giftId);
        // Freeze both snapshots before the first asynchronous bridge call.
        const before = previous === null ? null : snapshot(giftId, previous);
        const after = snapshot(giftId, next);
        if (before && scope(before) !== scope(after)) throw unavailable();
        const result = await backend.compareAndSwapRecoveryState({ giftId, previous: before === null ? null : JSON.stringify(before), next: JSON.stringify(after) });
        if (typeof result.swapped !== "boolean") throw unavailable();
        return result.swapped;
      } catch { throw unavailable(); }
    }
  };
}

const storage = createNativeGiftRecoveryStorage(native);
export const loadNativeGiftRecoveryState = storage.load;
export const compareAndSwapNativeGiftRecoveryState = storage.compareAndSwap;
