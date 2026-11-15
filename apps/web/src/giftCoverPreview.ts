export type GiftCoverPreview = {
  mimeType: "image/png" | "image/jpeg";
  dataBase64: string;
  width: number;
  height: number;
};

const MAX_BYTES = 32 * 1024;
const MAX_BASE64 = 4 * Math.ceil(MAX_BYTES / 3);
const MAX_SIDE = 256;
const invalid = () => new Error("Invalid gift cover preview.");

function dimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_SIDE ** 2) throw invalid();
  return { width, height };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 45 || [137, 80, 78, 71, 13, 10, 26, 10].some((byte, index) => bytes[index] !== byte)) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, chunks = 0, imageData = false, palette = false;
  let result: { width: number; height: number } | undefined;
  let color = -1;
  while (offset + 12 <= bytes.length && ++chunks <= 128) {
    const length = view.getUint32(offset), end = offset + 12 + length;
    if (end > bytes.length) throw invalid();
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) throw invalid();
    if (kind === "IHDR") {
      if (result || offset !== 8 || length !== 13) throw invalid();
      result = dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12));
      const depth = bytes[offset + 16]; color = bytes[offset + 17];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) throw invalid();
    } else if (!result) throw invalid();
    else if (kind === "PLTE") {
      if (palette || imageData || !length || length > 768 || length % 3 !== 0 || color === 0 || color === 4) throw invalid();
      palette = true;
    } else if (kind === "tRNS") {
      if (imageData || ![0, 2, 3].includes(color) || !length || length > 256 || (color === 3 && !palette)) throw invalid();
    } else if (kind === "IDAT") {
      if (!length || (color === 3 && !palette)) throw invalid();
      imageData = true;
    } else if (kind === "IEND") {
      if (length !== 0 || !imageData || end !== bytes.length) throw invalid();
      return result;
    } else {
      // Normalized thumbnails need no external metadata or animation chunks.
      throw invalid();
    }
    offset = end;
  }
  throw invalid();
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2, segments = 0, components = 0, tables = false, huffman = false;
  let result: { width: number; height: number } | undefined;
  while (offset + 4 <= bytes.length && ++segments <= 128) {
    if (bytes[offset++] !== 0xff) throw invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (![0xe0, 0xdb, 0xc4, 0xc0, 0xdd, 0xda].includes(marker) || offset + 2 > bytes.length) throw invalid();
    const length = view.getUint16(offset), end = offset + length;
    if (length < 2 || end > bytes.length) throw invalid();
    if (marker === 0xc0) {
      if (result || length < 11 || bytes[offset + 2] !== 8) throw invalid();
      result = dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3));
      components = bytes[offset + 7];
      if (![1, 3].includes(components) || length !== 8 + 3 * components) throw invalid();
      for (let channel = 0; channel < components; channel++) {
        const sampling = bytes[offset + 9 + channel * 3];
        if ((sampling >>> 4) < 1 || (sampling >>> 4) > 4 || (sampling & 15) < 1 || (sampling & 15) > 4 || bytes[offset + 10 + channel * 3] > 3) throw invalid();
      }
    } else if (marker === 0xdb) tables = true;
    else if (marker === 0xc4) huffman = true;
    else if (marker === 0xda) {
      if (!result || !tables || !huffman || bytes[offset + 2] !== components || length !== 6 + 2 * components) throw invalid();
      if (bytes[end - 3] !== 0 || bytes[end - 2] !== 63 || bytes[end - 1] !== 0) throw invalid();
      let entropy = false;
      for (let index = end; index < bytes.length; index++) {
        if (bytes[index] !== 0xff) { entropy = true; continue; }
        while (bytes[index + 1] === 0xff) index++;
        const next = bytes[++index];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) continue;
        if (next === 0xd9 && entropy && index + 1 === bytes.length) return result;
        throw invalid();
      }
      throw invalid();
    }
    offset = end;
  }
  throw invalid();
}

/** Call only after authenticating the encrypted preview's signature and checking
 * that a cover was selected. These are bounded container/header checks, not a
 * replacement for the server's raster decoding and metadata-free re-encoding. */
export function parseGiftCoverPreview(value: unknown): GiftCoverPreview | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "dataBase64,height,mimeType,width"
    || !["image/png", "image/jpeg"].includes(record.mimeType as string)
    || typeof record.dataBase64 !== "string" || !record.dataBase64.length || record.dataBase64.length > MAX_BASE64) throw invalid();
  const size = dimensions(record.width as number, record.height as number);
  let binary: string;
  try { binary = atob(record.dataBase64); } catch { throw invalid(); }
  if (!binary.length || binary.length > MAX_BYTES || btoa(binary) !== record.dataBase64) throw invalid();
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  const actual = record.mimeType === "image/png" ? pngDimensions(bytes) : jpegDimensions(bytes);
  if (actual.width !== size.width || actual.height !== size.height) throw invalid();
  return { mimeType: record.mimeType as GiftCoverPreview["mimeType"], dataBase64: record.dataBase64, ...size };
}

/** Produces only an inline raster URL. No input URI is accepted or fetched. */
export function giftCoverPreviewDataUrl(value: unknown): string | null {
  const cover = parseGiftCoverPreview(value);
  return cover ? `data:${cover.mimeType};base64,${cover.dataBase64}` : null;
}
