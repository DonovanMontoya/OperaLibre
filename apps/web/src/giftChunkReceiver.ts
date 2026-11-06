/** A native staging sink must persist chunks in order and verify SHA-256 in
 * `finish` without loading the complete archive into JavaScript memory. */
export type GiftChunkSink = {
  append(offset: number, bytes: Uint8Array): Promise<void>;
  finish(size: number, sha256: string): Promise<void>;
};

const MAX_CHUNK = 64 * 1024;
const MAX_PENDING = 256 * 1024;
const MAX_ARCHIVE = 25 * 1024 * 1024 * 1024;

/** Bounded, ordered receiver for the server's experimental data-channel frames. */
export class GiftChunkReceiver {
  private offset: number;
  private pending = 0;
  private ended = false;
  private failed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly sink: GiftChunkSink;
  private readonly size: number;
  private readonly sha256: string;
  constructor(sink: GiftChunkSink, size: number, sha256: string, offset = 0) {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ARCHIVE || !Number.isSafeInteger(offset) || offset < 0 || offset > size || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid archive descriptor.");
    this.offset = offset;
    this.sink = sink;
    this.size = size;
    this.sha256 = sha256;
  }

  /** Stop accepting frames and wait for already queued writes before the
   * staging file can be inspected or reopened. */
  async close(): Promise<void> {
    this.failed = true;
    try { await this.tail; } catch { /* transfer failure is reported by receive */ }
  }

  /** Frame processing is serialized; excess incoming data fails closed. */
  receive(frame: Uint8Array): Promise<void> {
    try {
      if (this.failed || this.ended || frame.byteLength < 14) throw new Error("Unexpected transfer frame.");
      const idLength = frame[0], header = idLength + 1;
      if (!idLength || frame.byteLength < header + 13) throw new Error("Truncated transfer frame.");
      const id = new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(1, header));
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      const position = view.getBigUint64(header), marker = frame[header + 8], length = view.getUint32(header + 9);
      if (id !== "archive" || position > BigInt(Number.MAX_SAFE_INTEGER) || Number(position) !== this.offset || marker > 1 || length > MAX_CHUNK || frame.byteLength !== header + 13 + length) throw new Error("Invalid transfer frame.");
      if (marker === 1) {
        if (length !== 0 || this.offset !== this.size) throw new Error("Incomplete transfer.");
        this.ended = true;
        this.tail = this.tail.then(() => this.sink.finish(this.size, this.sha256));
      } else {
        if (!length || this.offset + length > this.size || this.pending + length > MAX_PENDING) throw new Error("Transfer limit exceeded.");
        const offset = this.offset;
        const chunk = frame.slice(header + 13);
        this.offset += length;
        this.pending += length;
        this.tail = this.tail.then(async () => { try { await this.sink.append(offset, chunk); } finally { this.pending -= length; } });
      }
      this.tail = this.tail.catch(error => { this.failed = true; throw error; });
      return this.tail;
    } catch (error) {
      this.failed = true;
      return Promise.reject(error);
    }
  }
}
