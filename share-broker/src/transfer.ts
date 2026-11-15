export const MAX_CHUNK_BYTES = 64 * 1024;
export const MAX_TRANSFER_BYTES = 25 * 1024 * 1024 * 1024;

export type Chunk = { assetId: string; offset: number; final: boolean; data: Uint8Array };

export function encodeChunk(chunk: Chunk): Uint8Array {
  if (!chunk.assetId || chunk.offset < 0 || chunk.data.byteLength > MAX_CHUNK_BYTES) throw new Error("invalid chunk");
  const id = new TextEncoder().encode(chunk.assetId);
  if (id.byteLength > 255) throw new Error("asset id too long");
  const output = new Uint8Array(1 + id.byteLength + 8 + 1 + 4 + chunk.data.byteLength);
  const view = new DataView(output.buffer);
  output[0] = id.byteLength; output.set(id, 1);
  const at = 1 + id.byteLength; view.setBigUint64(at, BigInt(chunk.offset)); output[at + 8] = chunk.final ? 1 : 0;
  view.setUint32(at + 9, chunk.data.byteLength); output.set(chunk.data, at + 13);
  return output;
}

export function decodeChunk(input: Uint8Array): Chunk {
  if (input.byteLength < 14) throw new Error("chunk too small");
  const idLength = input[0]; const header = 1 + idLength;
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const length = view.getUint32(header + 9);
  if (header + 13 + length !== input.byteLength || length > MAX_CHUNK_BYTES) throw new Error("invalid chunk length");
  return { assetId: new TextDecoder().decode(input.subarray(1, header)), offset: Number(view.getBigUint64(header)), final: input[header + 8] === 1, data: input.slice(header + 13) };
}

export function acceptChunk(expectedOffset: number, totalReceived: number, chunk: Chunk, maxBytes: number) {
  if (chunk.offset !== expectedOffset) throw new Error("unexpected resume offset");
  const next = totalReceived + chunk.data.byteLength;
  if (next > Math.min(maxBytes, MAX_TRANSFER_BYTES)) throw new Error("transfer quota exceeded");
  return next;
}
