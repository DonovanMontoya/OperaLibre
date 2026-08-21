import type { MetadataField } from "./types";

/**
 * Reads embedded audiobook tags — title, author, narrator, description, cover
 * art and chapters — straight out of an audio file.
 *
 * The server does this with `lofty` while scanning the library, but a book
 * imported from the device file picker never reaches the server, so the app has
 * to read the same tags itself or the shelf shows a bare file name.
 *
 * Everything here works through {@link ByteSource} rather than a whole-file
 * buffer: an audiobook is routinely a gigabyte in one `.m4b`, and the tags all
 * live in a `moov` box that is a few hundred kilobytes at one end of it.
 */

export type ByteSource = {
  /** Total file length, once known. Range reads learn it from the response. */
  readonly size: number | null;
  /** Reads up to `length` bytes; a short read means end of file. */
  read(offset: number, length: number): Promise<Uint8Array>;
};

export type EmbeddedCover = {
  bytes: Uint8Array;
  contentType: string;
};

export type EmbeddedChapter = {
  title: string;
  startSeconds: number;
};

export type AudioFileTags = {
  title: string | null;
  album: string | null;
  subtitle: string | null;
  author: string | null;
  narrator: string | null;
  description: string | null;
  publisher: string | null;
  publishedDate: string | null;
  language: string | null;
  series: string | null;
  seriesPosition: string | null;
  asin: string | null;
  genres: string[];
  trackNumber: number | null;
  durationSeconds: number | null;
  cover: EmbeddedCover | null;
  chapters: EmbeddedChapter[];
  rawFields: MetadataField[];
};

/** Refuse to buffer a metadata box larger than this; no real book needs it. */
const MAX_METADATA_BYTES = 64 * 1024 * 1024;
/** The most this will hold in memory when it cannot read a file in parts. */
const MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
/** Chapter lists longer than this are a parse gone wrong, not an audiobook. */
const MAX_CHAPTERS = 2_000;
const MAX_RAW_FIELD_CHARS = 400;

export function emptyAudioFileTags(): AudioFileTags {
  return {
    title: null,
    album: null,
    subtitle: null,
    author: null,
    narrator: null,
    description: null,
    publisher: null,
    publishedDate: null,
    language: null,
    series: null,
    seriesPosition: null,
    asin: null,
    genres: [],
    trackNumber: null,
    durationSeconds: null,
    cover: null,
    chapters: [],
    rawFields: []
  };
}

/** A {@link ByteSource} over bytes already in memory. */
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      const start = Math.max(0, Math.min(offset, bytes.length));
      return bytes.subarray(start, Math.min(start + Math.max(0, length), bytes.length));
    }
  };
}

/**
 * A {@link ByteSource} over an HTTP(S) or `capacitor://` URL.
 *
 * WKWebView's local file server answers range requests (that is what makes
 * seeking work during playback), so a read normally costs one small 206. When
 * a server ignores `Range` we stream the body and stop reading as soon as the
 * requested slice has arrived, so a whole audiobook never lands in memory.
 */
export function rangeSource(url: string, knownSize: number | null = null): ByteSource {
  let size = knownSize;
  return {
    get size() {
      return size;
    },
    async read(offset: number, length: number) {
      if (length <= 0) return new Uint8Array(0);
      const end = offset + length - 1;
      const response = await fetch(url, { headers: { Range: `bytes=${offset}-${end}` } });
      if (!response.ok) throw new Error(`Could not read the audio file (${response.status}).`);
      const range = /bytes\s+(\d+)-\d+\/(\d+|\*)/i.exec(response.headers.get("Content-Range") ?? "");
      if (range && range[2] !== "*") size = Number(range[2]);
      // Where the body really starts: a file server that ignores the range can
      // still answer 206, and then the body is the whole audiobook from zero.
      const bodyStart = range ? Number(range[1]) : 0;
      const bodyLength = Number(response.headers.get("Content-Length") ?? NaN);
      // Only ever buffer a body that is provably no bigger than what was asked
      // for. Reading a gigabyte of audio into an ArrayBuffer costs the WebView
      // its content process, which fails every request in flight.
      if (bodyStart === offset && Number.isFinite(bodyLength) && bodyLength <= length) {
        return new Uint8Array(await response.arrayBuffer());
      }
      if (!response.body) {
        if ((size ?? Number.MAX_SAFE_INTEGER) > MAX_BUFFERED_BYTES) {
          throw new Error("The audio file is too large to read without range requests.");
        }
        const whole = new Uint8Array(await response.arrayBuffer());
        size = whole.length;
        return whole.subarray(offset - bodyStart, offset - bodyStart + length);
      }
      return readSliceFromStream(response.body, offset - bodyStart, length);
    }
  };
}

async function readSliceFromStream(body: ReadableStream<Uint8Array>, offset: number, length: number) {
  const reader = body.getReader();
  const slice = new Uint8Array(length);
  let consumed = 0;
  let written = 0;
  try {
    while (written < length) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const chunkStart = Math.max(0, offset - consumed);
      if (chunkStart < value.length) {
        const wanted = value.subarray(chunkStart, chunkStart + (length - written));
        slice.set(wanted, written);
        written += wanted.length;
      }
      consumed += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return slice.subarray(0, written);
}

/**
 * Reads whatever tags the file carries, or `null` when it is in a container
 * this does not understand. Never throws for malformed input — a book with no
 * usable tags still has to import.
 */
export async function readAudioFileTags(source: ByteSource): Promise<AudioFileTags | null> {
  try {
    const head = await source.read(0, 16);
    if (head.length >= 10 && ascii(head, 0, 3) === "ID3") return await readId3Tags(source, head);
    if (head.length >= 8 && isMp4Signature(head)) return await readMp4Tags(source);
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function ascii(bytes: Uint8Array, start: number, end: number) {
  let text = "";
  for (let index = start; index < end && index < bytes.length; index += 1) {
    text += String.fromCharCode(bytes[index]);
  }
  return text;
}

function readUint32(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] << 24) >>> 0) +
    (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) +
    bytes[offset + 3]
  );
}

function readUint64(bytes: Uint8Array, offset: number) {
  return readUint32(bytes, offset) * 2 ** 32 + readUint32(bytes, offset + 4);
}

const utf8 = new TextDecoder("utf-8");

function decodeUtf8(bytes: Uint8Array) {
  return utf8.decode(bytes);
}

function decodeUtf16(bytes: Uint8Array, bigEndianDefault: boolean) {
  let start = 0;
  let bigEndian = bigEndianDefault;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    start = 2;
    bigEndian = false;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    start = 2;
    bigEndian = true;
  }
  let text = "";
  for (let index = start; index + 1 < bytes.length; index += 2) {
    text += String.fromCharCode(
      bigEndian ? (bytes[index] << 8) | bytes[index + 1] : (bytes[index + 1] << 8) | bytes[index]
    );
  }
  return text;
}

/** ISO-8859-1, decoded by hand so this never depends on the platform's ICU data. */
function decodeLatin1(bytes: Uint8Array) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** Normalizes text shared by tags, raw fields, and chapter names. */
function cleanTagText(value: string) {
  return value
    .replace(/\0+$/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Description atoms may contain HTML, unlike the other tag values. */
function cleanDescriptionText(value: string | null) {
  if (value === null) return null;
  const decoded = cleanTagText(value);
  let text = "";
  let tag = "";
  let inTag = false;
  for (const character of decoded) {
    if (character === "<") {
      inTag = true;
      tag = "";
    } else if (character === ">" && inTag) {
      if (/^br\s*\/?$/i.test(tag) || /^\/p\s*$/i.test(tag)) text += "\n";
      inTag = false;
    } else if (character === ">") {
      // A malformed opening tag can leave a stray closing delimiter behind.
    } else if (inTag) {
      tag += character;
    } else {
      text += character;
    }
  }
  return text.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() || null;
}

function imageContentType(bytes: Uint8Array, declared?: string | null) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") return "image/png";
  if (bytes.length >= 6 && ascii(bytes, 0, 3) === "GIF") return "image/gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  const normalized = declared?.trim().toLowerCase();
  if (normalized?.startsWith("image/")) return normalized;
  if (normalized === "jpg" || normalized === "jpeg") return "image/jpeg";
  if (normalized === "png") return "image/png";
  return "application/octet-stream";
}

function splitGenres(value: string) {
  return value
    .split(/[;,/]/)
    .map((genre) => genre.trim())
    .filter((genre) => genre.length > 0);
}

/**
 * Converted audiobooks conventionally carry the narrator in the composer
 * field — that is what AAX rips and Libation write — so read it as one, but
 * only once another tag has named the author, since a file that has nothing
 * but a composer means it as the author.
 */
function composerNarrator(composer: string | null, author: string | null) {
  if (!composer || !author || composer.toLowerCase() === author.toLowerCase()) return null;
  return composer;
}

function normalizeAsin(value: string | null | undefined) {
  const trimmed = value?.trim().replace(/\0/g, "") ?? "";
  return /^B[0-9A-Za-z]{9}$/.test(trimmed) ? trimmed.toUpperCase() : null;
}

/** A collector that keeps the first non-empty value seen for each tag name. */
class TagValues {
  private readonly values = new Map<string, string>();
  readonly rawFields: MetadataField[] = [];

  add(key: string, value: string, description: string | null = null) {
    const cleaned = cleanTagText(value);
    if (!cleaned) return;
    const name = key.toLowerCase();
    if (!this.values.has(name)) this.values.set(name, cleaned);
    this.rawFields.push({
      key,
      value: cleaned.length > MAX_RAW_FIELD_CHARS ? `${cleaned.slice(0, MAX_RAW_FIELD_CHARS)}…` : cleaned,
      description
    });
  }

  first(...keys: string[]) {
    for (const key of keys) {
      const value = this.values.get(key.toLowerCase());
      if (value) return value;
    }
    return null;
  }

  /** The first value whose tag name mentions one of `needles` (freeform tags). */
  firstMatching(...needles: string[]) {
    for (const [key, value] of this.values) {
      if (needles.some((needle) => key.includes(needle))) return value;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// MPEG-4 (.m4b / .m4a / .mp4)
// ---------------------------------------------------------------------------

const MP4_TOP_LEVEL_TYPES = new Set(["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot", "styp"]);

function isMp4Signature(head: Uint8Array) {
  return MP4_TOP_LEVEL_TYPES.has(ascii(head, 4, 8));
}

/** A box's payload bounds within the buffer it was found in. */
type Box = {
  type: string;
  start: number;
  end: number;
};

// Box types are printable ASCII, plus the 0xA9 (©) that marks an iTunes atom.
const BOX_TYPE_PATTERN = /^[\x20-\x7e\xa9]{4}$/;

function boxHeaderAt(bytes: Uint8Array, offset: number, limit: number): Box | null {
  if (offset + 8 > limit) return null;
  let size = readUint32(bytes, offset);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > limit) return null;
    size = readUint64(bytes, offset + 8);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < headerSize || offset + size > limit) return null;
  const type = ascii(bytes, offset + 4, offset + 8);
  if (!BOX_TYPE_PATTERN.test(type)) return null;
  return { type, start: offset + headerSize, end: offset + size };
}

/** True when a real box header — not tag payload — starts at `offset`. */
function looksLikeBoxHeader(bytes: Uint8Array, offset: number, limit: number) {
  if (offset + 8 > limit) return false;
  const size = readUint32(bytes, offset);
  return size >= 8 && offset + size <= limit && BOX_TYPE_PATTERN.test(ascii(bytes, offset + 4, offset + 8));
}

function* childBoxes(bytes: Uint8Array, start: number, end: number): Generator<Box> {
  let offset = start;
  while (offset + 8 <= end) {
    const box = boxHeaderAt(bytes, offset, end);
    if (!box) return;
    yield box;
    offset = box.end > offset ? box.end : offset + 8;
  }
}

function findBox(bytes: Uint8Array, start: number, end: number, type: string) {
  for (const box of childBoxes(bytes, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

function findPath(bytes: Uint8Array, box: Box | null, ...types: string[]) {
  let current = box;
  for (const type of types) {
    if (!current) return null;
    current = findBox(bytes, current.start, current.end, type);
  }
  return current;
}

/**
 * Walks the top-level boxes of the file to find one, reading only the 16 byte
 * headers. `moov` sits at the end of any file that was not written for
 * streaming, so this has to be able to skip a gigabyte of `mdat` cheaply.
 */
async function findTopLevelBox(source: ByteSource, type: string) {
  let offset = 0;
  for (let guard = 0; guard < 1_000; guard += 1) {
    const header = await source.read(offset, 16);
    if (header.length < 8) return null;
    const boxType = ascii(header, 4, 8);
    if (!BOX_TYPE_PATTERN.test(boxType)) return null;
    let size = readUint32(header, 0);
    let headerSize = 8;
    if (size === 1) {
      if (header.length < 16) return null;
      size = readUint64(header, 8);
      headerSize = 16;
    } else if (size === 0) {
      size = (source.size ?? Number.MAX_SAFE_INTEGER) - offset;
    }
    if (size < headerSize) return null;
    if (boxType === type) return { start: offset + headerSize, size: size - headerSize };
    offset += size;
    if (source.size !== null && offset >= source.size) return null;
  }
  return null;
}

async function readMp4Tags(source: ByteSource): Promise<AudioFileTags | null> {
  const moov = await findTopLevelBox(source, "moov");
  if (!moov || moov.size > MAX_METADATA_BYTES) return null;
  const bytes = await source.read(moov.start, moov.size);
  const tags = emptyAudioFileTags();
  const root: Box = { type: "moov", start: 0, end: bytes.length };

  tags.durationSeconds = readMovieDuration(bytes, root);

  const values = new TagValues();
  const meta = findMetaBox(bytes, findBox(bytes, root.start, root.end, "udta"));
  const ilst = meta ? findBox(bytes, meta.start, meta.end, "ilst") : null;
  if (ilst) readIlst(bytes, ilst, values, tags);

  tags.title = values.first("©nam", "titl");
  tags.album = values.first("©alb");
  tags.subtitle = values.first("©st3", "subtitle");
  tags.author = values.first("©aut", "author", "©ART", "aART", "©wrt");
  tags.narrator =
    values.first("©prf", "©con", "narrator", "narratedby") ??
    values.firstMatching("narrat") ??
    composerNarrator(values.first("©wrt", "composer"), tags.author);
  tags.description = cleanDescriptionText(values.first("ldes", "desc", "©des", "©cmt", "description", "comment"));
  tags.publisher = values.first("©pub", "publisher", "©lab", "label");
  tags.publishedDate = values.first("©day", "rldt", "releasedate", "year");
  tags.language = values.first("©lan", "language");
  tags.series = values.first("series", "©mvn", "movementname", "show");
  tags.seriesPosition = values.first("series-part", "seriespart", "©mvi", "movementnumber");
  tags.asin = normalizeAsin(values.first("asin", "cdek")) ?? normalizeAsin(values.firstMatching("asin"));
  const genre = values.first("©gen", "genre");
  tags.genres = genre ? splitGenres(genre) : [];
  tags.rawFields = values.rawFields;

  tags.chapters = readNeroChapters(bytes, root);
  if (!tags.chapters.length) tags.chapters = await readQuickTimeChapters(source, bytes, root);
  return tags;
}

function readMovieDuration(bytes: Uint8Array, root: Box) {
  const mvhd = findBox(bytes, root.start, root.end, "mvhd");
  if (!mvhd) return null;
  const version = bytes[mvhd.start];
  const [timescale, duration] =
    version === 1
      ? [readUint32(bytes, mvhd.start + 20), readUint64(bytes, mvhd.start + 24)]
      : [readUint32(bytes, mvhd.start + 12), readUint32(bytes, mvhd.start + 16)];
  if (!timescale || !Number.isFinite(duration) || duration <= 0) return null;
  return duration / timescale;
}

/**
 * `meta` is a full box (version and flags before its children) in ISO files but
 * a plain container in QuickTime ones, and audiobook tools write both. Decide
 * by looking for a box header at each candidate offset.
 */
function findMetaBox(bytes: Uint8Array, udta: Box | null) {
  const meta = udta ? findBox(bytes, udta.start, udta.end, "meta") : null;
  if (!meta) return null;
  if (looksLikeBoxHeader(bytes, meta.start, meta.end)) return meta;
  return { ...meta, start: meta.start + 4 };
}

/** The `data` box payload of an iTunes metadata item, with its type indicator. */
function itemData(bytes: Uint8Array, item: Box) {
  const data = findBox(bytes, item.start, item.end, "data");
  if (!data || data.start + 8 > data.end) return null;
  // 1 byte version + 3 byte type indicator, then a 4 byte locale.
  const type = readUint32(bytes, data.start) & 0x00ffffff;
  return { type, bytes: bytes.subarray(data.start + 8, data.end) };
}

function decodeItemText(type: number, payload: Uint8Array) {
  if (type === 2) return decodeUtf16(payload, true);
  if (type === 21 || type === 22) {
    // Big-endian integer of 1, 2, 4 or 8 bytes.
    let value = 0;
    for (const byte of payload.subarray(0, 8)) value = value * 256 + byte;
    return String(value);
  }
  return decodeUtf8(payload);
}

function readIlst(bytes: Uint8Array, ilst: Box, values: TagValues, tags: AudioFileTags) {
  for (const item of childBoxes(bytes, ilst.start, ilst.end)) {
    if (item.type === "covr") {
      const data = itemData(bytes, item);
      if (data && data.bytes.length && !tags.cover) {
        tags.cover = {
          bytes: data.bytes.slice(),
          contentType: imageContentType(data.bytes, data.type === 14 ? "image/png" : "image/jpeg")
        };
        values.rawFields.push({ key: "covr", value: `<${data.bytes.length} bytes>`, description: null });
      }
      continue;
    }
    if (item.type === "trkn") {
      const data = itemData(bytes, item);
      // trkn is 2 reserved bytes then the track number as a big-endian u16.
      if (data && data.bytes.length >= 4) tags.trackNumber = (data.bytes[2] << 8) + data.bytes[3] || null;
      continue;
    }
    if (item.type === "----") {
      const name = findBox(bytes, item.start, item.end, "name");
      const mean = findBox(bytes, item.start, item.end, "mean");
      const data = itemData(bytes, item);
      if (!name || !data) continue;
      // `name` and `mean` are full boxes: 4 bytes of version and flags first.
      const label = decodeUtf8(bytes.subarray(name.start + 4, name.end)).trim();
      const vendor = mean ? decodeUtf8(bytes.subarray(mean.start + 4, mean.end)).trim() : null;
      if (label) values.add(label, decodeItemText(data.type, data.bytes), vendor || null);
      continue;
    }
    const data = itemData(bytes, item);
    if (!data) continue;
    // Box types are read byte by byte, so the 0xA9 that prefixes an iTunes
    // atom already reads as ©.
    values.add(item.type, decodeItemText(data.type, data.bytes));
  }
}

/** Nero-style chapters, written into `udta/chpl` by ffmpeg and friends. */
function readNeroChapters(bytes: Uint8Array, root: Box) {
  const chpl = findPath(bytes, root, "udta", "chpl");
  if (!chpl) return [];
  const version = bytes[chpl.start];
  // Version 1 adds a 4 byte field before the count; both then use a u8 count.
  let offset = chpl.start + 4 + (version === 1 ? 4 : 0);
  const count = bytes[offset];
  offset += 1;
  const chapters: EmbeddedChapter[] = [];
  for (let index = 0; index < count && index < MAX_CHAPTERS; index += 1) {
    if (offset + 9 > chpl.end) break;
    const start = readUint64(bytes, offset);
    const titleLength = bytes[offset + 8];
    offset += 9;
    if (offset + titleLength > chpl.end) break;
    chapters.push({
      title: cleanTagText(decodeUtf8(bytes.subarray(offset, offset + titleLength))),
      // Nero timestamps are in 100-nanosecond units.
      startSeconds: start / 10_000_000
    });
    offset += titleLength;
  }
  return chapters;
}

/**
 * QuickTime chapters: a text track referenced by the audio track's `tref/chap`,
 * whose samples are the chapter titles and whose sample durations give their
 * start times. This is what Audible and iTunes audiobooks carry.
 */
async function readQuickTimeChapters(source: ByteSource, bytes: Uint8Array, root: Box) {
  const traks = [...childBoxes(bytes, root.start, root.end)].filter((box) => box.type === "trak");
  let chapterTrackId: number | null = null;
  for (const trak of traks) {
    const chap = findPath(bytes, trak, "tref", "chap");
    if (chap && chap.start + 4 <= chap.end) {
      chapterTrackId = readUint32(bytes, chap.start);
      break;
    }
  }
  if (chapterTrackId === null) return [];

  const chapterTrack = traks.find((trak) => trackId(bytes, trak) === chapterTrackId);
  const mdia = chapterTrack ? findBox(bytes, chapterTrack.start, chapterTrack.end, "mdia") : null;
  const mdhd = mdia ? findBox(bytes, mdia.start, mdia.end, "mdhd") : null;
  const stbl = findPath(bytes, mdia, "minf", "stbl");
  if (!mdhd || !stbl) return [];
  const timescale =
    bytes[mdhd.start] === 1 ? readUint32(bytes, mdhd.start + 20) : readUint32(bytes, mdhd.start + 12);
  if (!timescale) return [];

  const samples = sampleTable(bytes, stbl);
  if (!samples.length) return [];

  const chapters: EmbeddedChapter[] = [];
  for (const sample of samples.slice(0, MAX_CHAPTERS)) {
    // Each sample is a 16-bit length followed by the title text; anything after
    // that (an `encd` atom naming the encoding) is not part of the title.
    const raw = await source.read(sample.offset, Math.min(sample.size, 4 + 1_024));
    if (raw.length < 2) continue;
    const length = Math.min((raw[0] << 8) + raw[1], raw.length - 2);
    const text = raw.subarray(2, 2 + length);
    const title =
      text.length >= 2 && ((text[0] === 0xfe && text[1] === 0xff) || (text[0] === 0xff && text[1] === 0xfe))
        ? decodeUtf16(text, true)
        : decodeUtf8(text);
    chapters.push({ title: cleanTagText(title), startSeconds: sample.startTicks / timescale });
  }
  return chapters;
}

function trackId(bytes: Uint8Array, trak: Box) {
  const tkhd = findBox(bytes, trak.start, trak.end, "tkhd");
  if (!tkhd) return null;
  // Version 1 widens the creation and modification times to 64 bits.
  return bytes[tkhd.start] === 1 ? readUint32(bytes, tkhd.start + 20) : readUint32(bytes, tkhd.start + 12);
}

type SampleLocation = { offset: number; size: number; startTicks: number };

/** Resolves a chapter track's sample table into file offsets and start times. */
function sampleTable(bytes: Uint8Array, stbl: Box): SampleLocation[] {
  const stts = findBox(bytes, stbl.start, stbl.end, "stts");
  const stsz = findBox(bytes, stbl.start, stbl.end, "stsz");
  const stsc = findBox(bytes, stbl.start, stbl.end, "stsc");
  const stco = findBox(bytes, stbl.start, stbl.end, "stco");
  const co64 = findBox(bytes, stbl.start, stbl.end, "co64");
  if (!stsz || !stsc || (!stco && !co64)) return [];

  const sizes: number[] = [];
  const uniformSize = readUint32(bytes, stsz.start + 4);
  const sampleCount = readUint32(bytes, stsz.start + 8);
  for (let index = 0; index < sampleCount && index < MAX_CHAPTERS; index += 1) {
    sizes.push(uniformSize || readUint32(bytes, stsz.start + 12 + index * 4));
  }

  const chunkOffsets: number[] = [];
  if (co64) {
    const count = readUint32(bytes, co64.start + 4);
    for (let index = 0; index < count; index += 1) chunkOffsets.push(readUint64(bytes, co64.start + 8 + index * 8));
  } else if (stco) {
    const count = readUint32(bytes, stco.start + 4);
    for (let index = 0; index < count; index += 1) chunkOffsets.push(readUint32(bytes, stco.start + 8 + index * 4));
  }

  const runs: { firstChunk: number; samplesPerChunk: number }[] = [];
  const runCount = readUint32(bytes, stsc.start + 4);
  for (let index = 0; index < runCount; index += 1) {
    const entry = stsc.start + 8 + index * 12;
    runs.push({
      firstChunk: readUint32(bytes, entry),
      samplesPerChunk: readUint32(bytes, entry + 4)
    });
  }

  const durations: number[] = [];
  if (stts) {
    const entries = readUint32(bytes, stts.start + 4);
    for (let index = 0; index < entries; index += 1) {
      const entry = stts.start + 8 + index * 8;
      const count = readUint32(bytes, entry);
      const delta = readUint32(bytes, entry + 4);
      for (let repeat = 0; repeat < count && durations.length < sizes.length; repeat += 1) durations.push(delta);
    }
  }

  const samples: SampleLocation[] = [];
  let sampleIndex = 0;
  let startTicks = 0;
  for (let chunk = 0; chunk < chunkOffsets.length && sampleIndex < sizes.length; chunk += 1) {
    const run = runs.filter((candidate) => candidate.firstChunk <= chunk + 1).pop();
    const perChunk = run?.samplesPerChunk ?? 1;
    let offset = chunkOffsets[chunk];
    for (let inChunk = 0; inChunk < perChunk && sampleIndex < sizes.length; inChunk += 1) {
      samples.push({ offset, size: sizes[sampleIndex], startTicks });
      offset += sizes[sampleIndex];
      startTicks += durations[sampleIndex] ?? 0;
      sampleIndex += 1;
    }
  }
  return samples;
}

// ---------------------------------------------------------------------------
// ID3v2 (.mp3)
// ---------------------------------------------------------------------------

function syncSafeSize(bytes: Uint8Array, offset: number) {
  return (
    ((bytes[offset] & 0x7f) << 21) |
    ((bytes[offset + 1] & 0x7f) << 14) |
    ((bytes[offset + 2] & 0x7f) << 7) |
    (bytes[offset + 3] & 0x7f)
  );
}

async function readId3Tags(source: ByteSource, head: Uint8Array): Promise<AudioFileTags> {
  const major = head[3];
  const flags = head[5];
  const size = syncSafeSize(head, 6);
  const tags = emptyAudioFileTags();
  if (size <= 0 || size > MAX_METADATA_BYTES) return tags;

  let bytes = await source.read(10, size);
  // Unsynchronisation hides 0xFF bytes behind an inserted 0x00; undo it before
  // frame offsets are read, or every frame after the first lands short.
  if (flags & 0x80) bytes = removeUnsynchronisation(bytes);

  const values = new TagValues();
  const idSize = major <= 2 ? 3 : 4;
  const headerSize = major <= 2 ? 6 : 10;
  // An extended header sits before the frames. v2.4 writes a sync-safe size
  // that counts itself; v2.3 a plain size that does not.
  let offset = flags & 0x40 ? (major >= 4 ? syncSafeSize(bytes, 0) : readUint32(bytes, 0) + 4) : 0;
  while (offset + headerSize <= bytes.length) {
    const id = ascii(bytes, offset, offset + idSize);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const frameSize =
      major <= 2
        ? (bytes[offset + 3] << 16) + (bytes[offset + 4] << 8) + bytes[offset + 5]
        : major >= 4
          ? syncSafeSize(bytes, offset + 4)
          : readUint32(bytes, offset + 4);
    const start = offset + headerSize;
    const end = start + frameSize;
    if (frameSize <= 0 || end > bytes.length) break;
    readId3Frame(id, bytes.subarray(start, end), values, tags);
    offset = end;
  }

  tags.title = values.first("TIT2", "TT2");
  tags.album = values.first("TALB", "TAL");
  tags.subtitle = values.first("TIT3", "TT3", "subtitle");
  tags.author = values.first("TPE1", "TP1", "author", "TCOM", "TCM", "TPE2", "TP2");
  tags.narrator =
    values.first("TPE3", "TP3", "narrator", "narratedby") ??
    values.firstMatching("narrat") ??
    composerNarrator(values.first("TCOM", "TCM"), tags.author);
  tags.description = cleanDescriptionText(values.first("COMM", "COM", "description", "TDES"));
  tags.publisher = values.first("TPUB", "TPB", "publisher");
  tags.publishedDate = values.first("TDRL", "TDRC", "TYER", "TYE", "TDAT");
  tags.language = values.first("TLAN", "TLA");
  tags.series = values.first("series", "TIT1", "TT1", "album-sort");
  tags.seriesPosition = values.first("series-part", "seriespart", "part");
  tags.asin = normalizeAsin(values.first("asin")) ?? normalizeAsin(values.firstMatching("asin"));
  const genre = values.first("TCON", "TCO");
  tags.genres = genre ? splitGenres(genre.replace(/^\((\d+)\)/, "")) : [];
  const trackNumber = Number.parseInt(values.first("TRCK", "TRK") ?? "", 10);
  tags.trackNumber = Number.isFinite(trackNumber) ? trackNumber : null;
  const lengthMs = Number.parseInt(values.first("TLEN", "TLE") ?? "", 10);
  tags.durationSeconds = Number.isFinite(lengthMs) && lengthMs > 0 ? lengthMs / 1_000 : null;
  tags.rawFields = values.rawFields;
  return tags;
}

function removeUnsynchronisation(bytes: Uint8Array) {
  const output = new Uint8Array(bytes.length);
  let written = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    output[written] = bytes[index];
    written += 1;
    if (bytes[index] === 0xff && bytes[index + 1] === 0x00) index += 1;
  }
  return output.subarray(0, written);
}

function decodeId3Text(encoding: number, bytes: Uint8Array) {
  if (encoding === 1) return decodeUtf16(bytes, false);
  if (encoding === 2) return decodeUtf16(bytes, true);
  if (encoding === 3) return decodeUtf8(bytes);
  return decodeLatin1(bytes);
}

/** Splits a NUL-terminated string off the front of a frame payload. */
function splitTerminated(encoding: number, bytes: Uint8Array) {
  const wide = encoding === 1 || encoding === 2;
  for (let index = 0; index + (wide ? 1 : 0) < bytes.length; index += wide ? 2 : 1) {
    if (bytes[index] !== 0 || (wide && bytes[index + 1] !== 0)) continue;
    return {
      value: decodeId3Text(encoding, bytes.subarray(0, index)),
      rest: bytes.subarray(index + (wide ? 2 : 1))
    };
  }
  return { value: decodeId3Text(encoding, bytes), rest: new Uint8Array(0) };
}

function readId3Frame(id: string, payload: Uint8Array, values: TagValues, tags: AudioFileTags) {
  if (id === "APIC" || id === "PIC") {
    if (tags.cover || payload.length < 4) return;
    const encoding = payload[0];
    let rest = payload.subarray(1);
    let declared: string;
    if (id === "PIC") {
      declared = ascii(rest, 0, 3);
      rest = rest.subarray(3);
    } else {
      const mime = splitTerminated(0, rest);
      declared = mime.value;
      rest = mime.rest;
    }
    // Picture type byte, then a description in the frame's own encoding.
    rest = splitTerminated(encoding, rest.subarray(1)).rest;
    if (!rest.length) return;
    tags.cover = { bytes: rest.slice(), contentType: imageContentType(rest, declared) };
    values.rawFields.push({ key: id, value: `<${rest.length} bytes>`, description: null });
    return;
  }
  if (id === "TXXX" || id === "TXX") {
    const encoding = payload[0];
    const { value: description, rest } = splitTerminated(encoding, payload.subarray(1));
    if (description) values.add(description, decodeId3Text(encoding, rest), "TXXX");
    return;
  }
  if (id === "COMM" || id === "COM") {
    if (payload.length < 5) return;
    const encoding = payload[0];
    // Three byte language code, then a short description before the comment.
    const { value: description, rest } = splitTerminated(encoding, payload.subarray(4));
    values.add(id, decodeId3Text(encoding, rest), description || null);
    return;
  }
  if (id.startsWith("T")) {
    // A v2.4 text frame can hold several NUL-separated values; the first wins.
    values.add(id, decodeId3Text(payload[0], payload.subarray(1)).split("\0")[0]);
  }
}
