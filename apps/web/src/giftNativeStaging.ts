import { Capacitor, registerPlugin } from "@capacitor/core";
import type { GiftChunkSink } from "./giftChunkReceiver";

export type GiftStagedPrefix = { offset: number; prefixSha256: string };
type Verifier = { prepareArchive(input: { giftId: string }): Promise<void>; verifyArchive(input: { giftId: string; size: number; sha256: string }): Promise<void>; inspectArchive(input: { giftId: string; maximumSize: number }): Promise<GiftStagedPrefix> };
type Staging = GiftChunkSink & { close(): Promise<void> };
type StagingBackend = Verifier & { append(giftId: string, bytes: Uint8Array): Promise<void>; release?(giftId: string): Promise<void> };
export type NativeGiftStagingBackend = {
  acquireArchive(input: { giftId: string; create: boolean; maximumSize: number }): Promise<GiftStagedPrefix & { lease: string }>;
  appendArchive(input: { giftId: string; lease: string; offset: number; data: string }): Promise<{ offset: number }>;
  verifyArchive(input: { giftId: string; lease: string; size: number; sha256: string }): Promise<void>;
  releaseArchive(input: { giftId: string; lease: string }): Promise<void>;
  cleanupArchive(input: { giftId: string }): Promise<void>;
};
const verifier = registerPlugin<NativeGiftStagingBackend>("GiftImport");
const MAX_ARCHIVE = 25 * 1024 ** 3;
const MAX_CHUNK = 64 * 1024;
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const validId = (value: string) => /^[A-Za-z0-9_-]{16,128}$/.exec(value)?.[0] === value;

function base64(bytes: Uint8Array) {
  let result = "";
  for (let i = 0; i < bytes.length; i += 0x8000) result += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(result);
}

/** Injection seam for bounded sinks. The application uses the native lease
 * adapter below; the JS context lock alone is insufficient for native staging. */
export function createGiftStagingManager(backend: StagingBackend, available: () => boolean) {
  const active = new Set<string>();
  function lock(giftId: string) {
    if (!available() || !validId(giftId)) throw new Error("Native gift staging unavailable.");
    if (active.has(giftId)) throw new Error("Gift transfer already active.");
    active.add(giftId);
  }
  async function inspect(giftId: string, maximumSize: number): Promise<GiftStagedPrefix> {
    if (!Number.isSafeInteger(maximumSize) || maximumSize < 0 || maximumSize > MAX_ARCHIVE) throw new Error("Invalid archive size.");
    const result = await backend.inspectArchive({ giftId, maximumSize });
    if (!Number.isSafeInteger(result.offset) || result.offset < 0 || result.offset > maximumSize || /^[a-f0-9]{64}$/.exec(result.prefixSha256)?.[0] !== result.prefixSha256) throw new Error("Invalid staged gift prefix.");
    return { offset: result.offset, prefixSha256: result.prefixSha256 };
  }
  function sink(giftId: string, initialOffset: number): Staging {
    let offset = initialOffset, closing = false, finished = false;
    let closed: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>();
    function track<T>(operation: Promise<T>): Promise<T> {
      pending.add(operation);
      void operation.finally(() => pending.delete(operation)).catch(() => undefined);
      return operation;
    }
    return {
      async append(position, bytes) {
        if (closing || finished || pending.size || position !== offset || !bytes.length || bytes.length > MAX_CHUNK) throw new Error("Unexpected staging offset.");
        const length = bytes.length;
        await track(backend.append(giftId, bytes));
        offset += length;
      },
      async finish(size, sha256) {
        if (closing || finished || pending.size || offset !== size) throw new Error("Incomplete archive.");
        await track(backend.verifyArchive({ giftId, size, sha256 }));
        finished = true;
      },
      close() {
        if (!closed) {
          closing = true;
          closed = Promise.allSettled([...pending]).then(async () => {
            try { await backend.release?.(giftId); } finally { active.delete(giftId); }
          });
        }
        return closed;
      }
    };
  }
  return {
    async inspect(giftId: string, maximumSize: number) {
      lock(giftId);
      try { return await inspect(giftId, maximumSize); }
      finally { try { await backend.release?.(giftId); } finally { active.delete(giftId); } }
    },
    async create(giftId: string): Promise<Staging> {
      lock(giftId);
      try { await backend.prepareArchive({ giftId }); return sink(giftId, 0); }
      catch (error) { try { await backend.release?.(giftId); } finally { active.delete(giftId); } throw error; }
    },
    /** Holds the lock until closed. The caller must negotiate this exact prefix
     * with an authenticated sender before accepting resumed frames. */
    async recover(giftId: string, maximumSize: number): Promise<{ prefix: GiftStagedPrefix; staging: Staging }> {
      lock(giftId);
      try { const prefix = await inspect(giftId, maximumSize); return { prefix, staging: sink(giftId, prefix.offset) }; }
      catch (error) { try { await backend.release?.(giftId); } finally { active.delete(giftId); } throw error; }
    }
  };
}

/** Native acquire holds the OS lock through inspection, negotiation, every
 * append, verification and release. Tokens belong to the native plugin owner;
 * no file writes pass through the generic Filesystem plugin. */
export function createNativeGiftStagingManager(backend: NativeGiftStagingBackend, available: () => boolean = () => Capacitor.isNativePlatform()) {
  const leases = new Map<string, { token: string; offset: number }>();
  function lease(giftId: string) {
    const value = leases.get(giftId);
    if (!value) throw new Error("Native gift lease unavailable.");
    return value;
  }
  async function acquire(giftId: string, create: boolean, maximumSize: number) {
    const result = await backend.acquireArchive({ giftId, create, maximumSize });
    if (typeof result.lease !== "string" || /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.exec(result.lease)?.[0] !== result.lease) throw new Error("Invalid native gift lease.");
    leases.set(giftId, { token: result.lease, offset: result.offset });
    return result;
  }
  const manager = createGiftStagingManager({
    async prepareArchive({ giftId }) {
      const result = await acquire(giftId, true, MAX_ARCHIVE);
      if (result.offset !== 0 || result.prefixSha256 !== EMPTY_SHA256) throw new Error("Invalid fresh gift prefix.");
    },
    inspectArchive: ({ giftId, maximumSize }) => acquire(giftId, false, maximumSize),
    async append(giftId, bytes) {
      const held = lease(giftId), expected = held.offset + bytes.length;
      const result = await backend.appendArchive({ giftId, lease: held.token, offset: held.offset, data: base64(bytes) });
      if (result.offset !== expected) throw new Error("Invalid native gift offset.");
      held.offset = expected;
    },
    async verifyArchive({ giftId, size, sha256 }) { await backend.verifyArchive({ giftId, lease: lease(giftId).token, size, sha256 }); },
    async release(giftId) {
      const held = leases.get(giftId);
      if (held) {
        try { await backend.releaseArchive({ giftId, lease: held.token }); } finally { leases.delete(giftId); }
      }
    }
  }, available);
  return {
    ...manager,
    async cleanup(giftId: string) {
      if (!available() || !validId(giftId)) throw new Error("Native gift staging unavailable.");
      await backend.cleanupArchive({ giftId });
    }
  };
}

const native = createNativeGiftStagingManager(verifier);

export const inspectNativeGiftStaging = native.inspect;
export const createNativeGiftStaging = native.create;
export const recoverNativeGiftStaging = native.recover;
export const cleanupNativeGiftStaging = native.cleanup;
