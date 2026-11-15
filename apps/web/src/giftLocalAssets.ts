import { Capacitor } from "@capacitor/core";
import { Directory, Filesystem } from "@capacitor/filesystem";
import type { NativeGiftAsset } from "./giftDeviceImport.ts";

export type GiftAssetReader = (path: string, maximumBytes: number, signal?: AbortSignal) => Promise<Uint8Array>;
export const MAX_GIFT_SYNC_BYTES = 16 * 1024 * 1024;
const invalid = () => new Error("The verified local gift asset is unavailable or changed.");
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw new Error("Gift asset read cancelled."); };

/** A bounded stream reader: neither a false Content-Length nor a file growing
 * after stat may cause an unbounded arrayBuffer()/text() allocation. */
export async function readBoundedGiftResponse(response: Response, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_GIFT_SYNC_BYTES || !response.ok || !response.body) throw invalid();
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) { await response.body.cancel(); throw invalid(); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  let total = 0;
  try {
    for (;;) {
      checkAbort(signal);
      const { value, done } = await reader.read();
      checkAbort(signal);
      if (done) break;
      total += value.length;
      if (total > maximumBytes) throw invalid();
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export const readNativeGiftAsset: GiftAssetReader = async (path, maximumBytes, signal) => {
  if (!Capacitor.isNativePlatform() || !/^device-library\/gift-[A-Za-z0-9_-]{16,128}\/[^\\/\x00-\x1f\x7f]+$/.test(path) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_GIFT_SYNC_BYTES) throw invalid();
  checkAbort(signal);
  const stat = await Filesystem.stat({ path, directory: Directory.Data });
  if (stat.type !== "file" || !Number.isSafeInteger(stat.size) || stat.size < 1 || stat.size > maximumBytes) throw invalid();
  const { uri } = await Filesystem.getUri({ path, directory: Directory.Data });
  if (!uri.startsWith("file://")) throw invalid();
  const url = new URL(Capacitor.convertFileSrc(uri)), local = new URL(window.location.href);
  if (url.protocol !== local.protocol || url.host !== local.host || !url.pathname.startsWith("/_capacitor_file_/")) throw invalid();
  // A URL obtained from the Data directory only: never a sender URL, server
  // origin, redirect, cookie, bearer token or active-server dependency.
  const response = await fetch(url.href, { signal, credentials: "omit", redirect: "error", cache: "no-store" });
  return readBoundedGiftResponse(response, maximumBytes, signal);
};

export async function readVerifiedGiftAsset(giftId: string, asset: NativeGiftAsset, maximumBytes: number, read: GiftAssetReader, signal?: AbortSignal): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(giftId) || !asset.name || asset.name === "." || asset.name === ".." || asset.name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(asset.name) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maximumBytes || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw invalid();
  checkAbort(signal);
  const bytes = await read(`device-library/gift-${giftId}/${asset.name}`, asset.size, signal);
  checkAbort(signal);
  if (bytes.length !== asset.size) throw invalid();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)));
  checkAbort(signal);
  const hex = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== asset.sha256) throw invalid();
  return bytes;
}
