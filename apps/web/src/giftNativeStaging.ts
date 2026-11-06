import { Capacitor, registerPlugin } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type { GiftChunkSink } from "./giftChunkReceiver";

export type GiftStagedPrefix = { offset: number; prefixSha256: string };
type Verifier = { prepareArchive(input: { giftId: string }): Promise<void>; verifyArchive(input: { giftId: string; size: number; sha256: string }): Promise<void>; inspectArchive(input: { giftId: string; maximumSize: number }): Promise<GiftStagedPrefix> };
type Staging = GiftChunkSink & { close(): Promise<void> };
type StagingBackend = Verifier & { append(giftId: string, bytes: Uint8Array): Promise<void> };
const verifier = registerPlugin<Verifier>("GiftImport");
const MAX_ARCHIVE = 25 * 1024 ** 3;

function base64(bytes: Uint8Array) {
  let result = "";
  for (let i = 0; i < bytes.length; i += 0x8000) result += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(result);
}

/** The lock covers inspection, negotiation and all writes in this JS context.
 * Native verification of the complete archive remains mandatory. */
export function createGiftStagingManager(backend: StagingBackend, available: () => boolean) {
  const active = new Set<string>();
  function lock(giftId: string) {
    if (!available() || !/^[A-Za-z0-9_-]{16,128}$/.test(giftId)) throw new Error("Native gift staging unavailable.");
    if (active.has(giftId)) throw new Error("Gift transfer already active.");
    active.add(giftId);
  }
  async function inspect(giftId: string, maximumSize: number): Promise<GiftStagedPrefix> {
    if (!Number.isSafeInteger(maximumSize) || maximumSize < 0 || maximumSize > MAX_ARCHIVE) throw new Error("Invalid archive size.");
    const result = await backend.inspectArchive({ giftId, maximumSize });
    if (!Number.isSafeInteger(result.offset) || result.offset < 0 || result.offset > maximumSize || !/^[a-f0-9]{64}$/.test(result.prefixSha256)) throw new Error("Invalid staged gift prefix.");
    return { offset: result.offset, prefixSha256: result.prefixSha256 };
  }
  function sink(giftId: string, initialOffset: number): Staging {
    let offset = initialOffset, closing = false;
    let closed: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    function track<T>(operation: Promise<T>): Promise<T> {
      pending.add(operation);
      void operation.finally(() => pending.delete(operation)).catch(() => undefined);
      return operation;
    }
    return {
      async append(position, bytes) {
        if (closing || pending.size || position !== offset) throw new Error("Unexpected staging offset.");
        await track(backend.append(giftId, bytes));
        offset += bytes.length;
      },
      async finish(size, sha256) {
        if (closing || pending.size || offset !== size) throw new Error("Incomplete archive.");
        await track(backend.verifyArchive({ giftId, size, sha256 }));
      },
      close() {
        if (!closed) {
          closing = true;
          closed = Promise.allSettled([...pending]).then(() => { active.delete(giftId); });
        }
        return closed;
      }
    };
  }
  return {
    async inspect(giftId: string, maximumSize: number) {
      lock(giftId);
      try { return await inspect(giftId, maximumSize); } finally { active.delete(giftId); }
    },
    async create(giftId: string): Promise<Staging> {
      lock(giftId);
      try { await backend.prepareArchive({ giftId }); return sink(giftId, 0); }
      catch (error) { active.delete(giftId); throw error; }
    },
    /** Holds the lock until closed. The caller must negotiate this exact prefix
     * with an authenticated sender before accepting resumed frames. */
    async recover(giftId: string, maximumSize: number): Promise<{ prefix: GiftStagedPrefix; staging: Staging }> {
      lock(giftId);
      try { const prefix = await inspect(giftId, maximumSize); return { prefix, staging: sink(giftId, prefix.offset) }; }
      catch (error) { active.delete(giftId); throw error; }
    }
  };
}

const native = createGiftStagingManager({
  prepareArchive: input => verifier.prepareArchive(input),
  inspectArchive: input => verifier.inspectArchive(input),
  verifyArchive: input => verifier.verifyArchive(input),
  async append(giftId, bytes) { await Filesystem.appendFile({ path: `gift-incoming/${giftId}.zip`, directory: Directory.Data, data: base64(bytes) }); }
}, () => Capacitor.isNativePlatform());

export const inspectNativeGiftStaging = native.inspect;
export const createNativeGiftStaging = native.create;
export const recoverNativeGiftStaging = native.recover;
