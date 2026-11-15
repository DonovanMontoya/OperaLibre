import { encodeChunk, MAX_CHUNK_BYTES } from "./transfer.js";

/** Browser-side sender primitive. Signaling and capability issuance remain
 * owner-controlled; this class never contacts a provider or stores secrets. */
export async function sendAssetOverDataChannel(
  channel: RTCDataChannel,
  assetId: string,
  bytes: AsyncIterable<Uint8Array>,
  startOffset = 0,
): Promise<number> {
  let offset = startOffset;
  for await (const block of bytes) {
    for (let at = 0; at < block.byteLength; at += MAX_CHUNK_BYTES) {
      const data = block.slice(at, at + MAX_CHUNK_BYTES);
      while (channel.bufferedAmount > 4 * MAX_CHUNK_BYTES) {
        await new Promise<void>(resolve => {
          const wake = () => { channel.removeEventListener("bufferedamountlow", wake); resolve(); };
          channel.bufferedAmountLowThreshold = 2 * MAX_CHUNK_BYTES;
          channel.addEventListener("bufferedamountlow", wake, { once: true });
        });
      }
      channel.send(encodeChunk({ assetId, offset, final: false, data }) as unknown as ArrayBuffer);
      offset += data.byteLength;
    }
  }
  channel.send(encodeChunk({ assetId, offset, final: true, data: new Uint8Array() }) as unknown as ArrayBuffer);
  return offset;
}
