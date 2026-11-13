/** Experimental standalone import boundary. Not connected to share links. */
export type GiftEntry = { name: string; size: number; sha256: string; kind: "ebook" | "audio" | "cover" | "metadata" | "alignment" };
export type GiftManifest = { giftId: string; entries: GiftEntry[] };
export type GiftImportStore = {
  has(giftId: string): Promise<boolean>;
  begin(giftId: string): Promise<string>;
  write(staging: string, entry: GiftEntry, bytes: Uint8Array): Promise<void>;
  /** Atomically reject a second commit for the same gift ID. */
  commit(staging: string, manifest: GiftManifest): Promise<void>;
  rollback(staging: string): Promise<void>;
};

// This initial adapter intentionally supports only bounded STORE archives.
// Large audio, compressed entries and ZIP64 require a native streaming reader.
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_ENTRIES = 256;
const decoder = new TextDecoder("utf-8", { fatal: true });

function safeName(name: string) {
  return !!name && name !== "." && name !== ".." && !/[\\/\x00-\x1f\x7f]/.test(name);
}
function u16(view: DataView, offset: number) { return view.getUint16(offset, true); }
function u32(view: DataView, offset: number) { return view.getUint32(offset, true); }
function sameBytes(a: Uint8Array, b: Uint8Array) { return a.length === b.length && a.every((byte, i) => byte === b[i]); }

/** Parse central/local headers before extracting any bytes or mutating storage. */
export function inspectGiftArchive(bytes: Uint8Array, manifest: GiftManifest): Map<string, Uint8Array> {
  if (bytes.length < 22 || bytes.length > MAX_ARCHIVE || !/^[A-Za-z0-9_-]{16,128}$/.test(manifest.giftId) || !manifest.entries.length || manifest.entries.length > MAX_ENTRIES) throw new Error("Invalid or oversized gift archive.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(view, i) === 0x06054b50 && i + 22 + u16(view, i + 20) === bytes.length) { eocd = i; break; }
  }
  if (eocd < 0 || u16(view, eocd + 4) !== 0 || u16(view, eocd + 6) !== 0) throw new Error("Unsupported ZIP directory.");
  const count = u16(view, eocd + 10), directorySize = u32(view, eocd + 12), directoryOffset = u32(view, eocd + 16);
  if (count !== manifest.entries.length || count !== u16(view, eocd + 8) || count > MAX_ENTRIES || directoryOffset + directorySize !== eocd) throw new Error("ZIP directory does not match the manifest.");
  const expected = new Map<string, GiftEntry>();
  for (const entry of manifest.entries) {
    if (!safeName(entry.name) || expected.has(entry.name) || !["ebook", "audio", "cover", "metadata", "alignment"].includes(entry.kind) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_ARCHIVE || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid gift manifest entry.");
    expected.set(entry.name, entry);
  }
  const kinds = new Set(manifest.entries.map(entry => entry.kind));
  if (kinds.has("alignment") && (!kinds.has("ebook") || !kinds.has("audio"))) throw new Error("Read-along data requires both ebook and audio.");
  const result = new Map<string, Uint8Array>();
  const ranges: Array<[number, number]> = [];
  let cursor = directoryOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > eocd || u32(view, cursor) !== 0x02014b50) throw new Error("Invalid ZIP entry.");
    const flags = u16(view, cursor + 8), method = u16(view, cursor + 10), compressed = u32(view, cursor + 20), size = u32(view, cursor + 24);
    const nameLen = u16(view, cursor + 28), extraLen = u16(view, cursor + 30), commentLen = u16(view, cursor + 32), local = u32(view, cursor + 42);
    const next = cursor + 46 + nameLen + extraLen + commentLen;
    if (next > eocd || (flags & ~0x0800) !== 0 || method !== 0 || compressed !== size || size === 0xffffffff || local === 0xffffffff) throw new Error("Unsupported ZIP entry.");
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLen), name = decoder.decode(nameBytes);
    const entry = expected.get(name);
    if (!entry || result.has(name) || entry.size !== size || local + 30 > directoryOffset || u32(view, local) !== 0x04034b50) throw new Error("ZIP contains an unselected or invalid file.");
    const localNameLen = u16(view, local + 26), localExtraLen = u16(view, local + 28), dataStart = local + 30 + localNameLen + localExtraLen, dataEnd = dataStart + size;
    if (u16(view, local + 6) !== flags || u16(view, local + 8) !== method || u32(view, local + 18) !== size || u32(view, local + 22) !== size || dataEnd > directoryOffset || !sameBytes(nameBytes, bytes.subarray(local + 30, local + 30 + localNameLen))) throw new Error("ZIP local entry differs from directory.");
    if (ranges.some(([start, end]) => local < end && start < dataEnd)) throw new Error("ZIP entries overlap.");
    ranges.push([local, dataEnd]);
    total += size;
    if (total > MAX_ARCHIVE) throw new Error("Gift contents are too large.");
    result.set(name, bytes.subarray(dataStart, dataEnd));
    cursor = next;
  }
  if (cursor !== eocd) throw new Error("Invalid ZIP directory size.");
  return result;
}

export async function importGiftArchive(bytes: Uint8Array, manifest: GiftManifest, store: GiftImportStore): Promise<"imported" | "duplicate"> {
  const entries = inspectGiftArchive(bytes, manifest);
  for (const entry of manifest.entries) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", Uint8Array.from(entries.get(entry.name)!)));
    const hex = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
    if (hex !== entry.sha256) throw new Error("Gift integrity check failed.");
  }
  if (await store.has(manifest.giftId)) return "duplicate";
  const staging = await store.begin(manifest.giftId);
  try {
    for (const entry of manifest.entries) await store.write(staging, entry, entries.get(entry.name)!);
    await store.commit(staging, manifest);
    return "imported";
  } catch (error) {
    await store.rollback(staging);
    throw error;
  }
}
