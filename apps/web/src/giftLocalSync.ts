import { MAX_GIFT_TIMELINE_SECONDS, parseGiftMetadata, type GiftMetadata } from "./giftMetadata.ts";
import { MAX_GIFT_SYNC_BYTES, readNativeGiftAsset, readVerifiedGiftAsset, type GiftAssetReader } from "./giftLocalAssets.ts";
import type { NativeGiftAsset } from "./giftDeviceImport.ts";
import type { Book, SyncMap } from "./types";

const invalid = () => new Error("Gift alignment does not match its selected text and audio timeline.");
/** Progress changes must not reload a map; changed local dependencies must. */
export function giftLocalSyncCacheKey(book: Pick<Book, "id" | "source" | "localSyncMap" | "readingFile" | "companions" | "tracks">): string {
  if (book.source !== "device" || !book.localSyncMap) return book.id;
  return `${book.id}:${JSON.stringify([book.localSyncMap, book.readingFile, book.companions?.map(file => [file.id, file.localFilePath, file.sizeBytes]), book.tracks.map(track => [track.id, track.index, track.localFilePath, track.durationSeconds])])}`;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function finite(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}
function href(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 2048 || /[\\\x00-\x20\x7f:?]/.test(value) || value.startsWith("/")) return false;
  try {
    const path = decodeURIComponent(value.split("#")[0]);
    return !!path && !path.startsWith("/") && !/[\\:]/.test(path) && !path.split("/").some(part => part === ".." || part === "." || !part);
  } catch { return false; }
}

/** Validate the existing v1/v2 sentence-map format, including UTF-16 word spans.
 * The sender separately validates these exact map bytes against EPUB text;
 * metadata binds the selected EPUB and the complete ordered audio timeline. */
export function parseGiftSyncMap(value: unknown, durationSeconds: number): SyncMap {
  const map = object(value);
  if (![1, 2].includes(map.version as number) || (map.version === 1 ? map.precision != null && map.precision !== "sentence" : map.precision !== "sentence") || !finite(durationSeconds, MAX_GIFT_TIMELINE_SECONDS) || durationSeconds <= 0 || !Array.isArray(map.fragments) || !map.fragments.length || map.fragments.length > 100000) throw invalid();
  let previous = 0, wordCount = 0;
  const fragments = map.fragments.map(value => {
    const fragment = object(value);
    if (!finite(fragment.startSeconds, durationSeconds + 0.05) || !finite(fragment.endSeconds, durationSeconds + 0.05) || fragment.endSeconds <= fragment.startSeconds || fragment.startSeconds < previous || !href(fragment.href) || typeof fragment.text !== "string" || !fragment.text.trim() || new TextEncoder().encode(fragment.text).length > 64 * 1024 || /\0/.test(fragment.text)) throw invalid();
    previous = fragment.startSeconds;
    let wordTime = fragment.startSeconds, wordOffset = 0;
    let words: [number, number, number, number][] | undefined;
    if (fragment.words !== undefined) {
      if (!Array.isArray(fragment.words) || (wordCount += fragment.words.length) > 1000000) throw invalid();
      words = fragment.words.map(value => {
        if (!Array.isArray(value) || value.length !== 4) throw invalid();
        const [start, end, offset, length] = value;
        if (!finite(start, (fragment.endSeconds as number) + 0.05) || start < wordTime || !finite(end, (fragment.endSeconds as number) + 0.05) || end <= start || !Number.isSafeInteger(offset) || offset < wordOffset || !Number.isSafeInteger(length) || length < 1 || offset + length > (fragment.text as string).length) throw invalid();
        // An offset inside a surrogate pair is not a JavaScript text boundary.
        const text = fragment.text as string;
        const splitsPair = (at: number) => at > 0 && at < text.length && /[\ud800-\udbff]/.test(text[at - 1]) && /[\udc00-\udfff]/.test(text[at]);
        if (splitsPair(offset) || splitsPair(offset + length)) throw invalid();
        wordTime = start; wordOffset = offset + length;
        return [start, end, offset, length];
      });
    }
    return { startSeconds: fragment.startSeconds, endSeconds: fragment.endSeconds, href: fragment.href, text: fragment.text, ...(words ? { words } : {}) };
  });
  if (map.recoveryGaps !== undefined && (!Array.isArray(map.recoveryGaps) || map.recoveryGaps.length > 100000)) throw invalid();
  const recoveryGaps = (map.recoveryGaps as unknown[] | undefined)?.map(value => {
    const gap = object(value);
    if (!finite(gap.startSeconds, durationSeconds + 0.05) || !finite(gap.endSeconds, durationSeconds + 0.05) || gap.endSeconds <= gap.startSeconds) throw invalid();
    return { startSeconds: gap.startSeconds, endSeconds: gap.endSeconds };
  });
  // Preserve no unvalidated generator/URL/extra fields from arbitrary JSON.
  return { version: map.version as number, precision: "sentence", fragments, ...(recoveryGaps ? { recoveryGaps } : {}) };
}

export async function bindGiftLocalSyncMap(book: Book, assets: NativeGiftAsset[], metadata: GiftMetadata, read: GiftAssetReader, signal?: AbortSignal): Promise<Book> {
  metadata = parseGiftMetadata(metadata, assets);
  const alignment = metadata.alignment;
  if (!alignment || !metadata.tracks?.length || metadata.tracks.some(track => track.durationSeconds === null) || book.source !== "device" || !/^device:gift:[A-Za-z0-9_-]{16,128}$/.test(book.id)) throw invalid();
  const giftId = book.id.slice("device:gift:".length), directory = `device-library/gift-${giftId}`;
  const asset = assets.find(asset => asset.kind === "alignment" && asset.name === alignment.assetName)!;
  const ebook = assets.find(asset => asset.kind === "ebook" && asset.name === alignment.ebookAssetName)!;
  const audio = metadata.tracks.map(track => {
    const asset = assets.find(asset => asset.kind === "audio" && asset.name === track.fileName)!;
    return { name: asset.name, size: asset.size, sha256: asset.sha256, durationSeconds: track.durationSeconds! };
  });
  if (!book.readingFile || book.companions?.find(file => file.id === book.readingFile!.id)?.localFilePath !== `${directory}/${ebook.name}` || book.tracks.length !== audio.length || audio.some((asset, index) => book.tracks[index].localFilePath !== `${directory}/${asset.name}` || book.tracks[index].durationSeconds !== asset.durationSeconds)) throw invalid();
  const bytes = await readVerifiedGiftAsset(giftId, asset, MAX_GIFT_SYNC_BYTES, read, signal);
  parseGiftSyncMap(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), audio.reduce((sum, asset) => sum + asset.durationSeconds, 0));
  return { ...book, syncFile: { fileName: asset.name, source: "sidecar", url: "" }, localSyncMap: { asset: { name: asset.name, size: asset.size, sha256: asset.sha256 }, ebook: { name: ebook.name, size: ebook.size, sha256: ebook.sha256 }, audio } };
}

/** A restarted standalone shelf can load the exact validated map with no
 * server, authentication, cache scope or map-generation capability. */
export async function loadGiftLocalSyncMap(book: Book, read: GiftAssetReader = readNativeGiftAsset, signal?: AbortSignal): Promise<SyncMap | null> {
  const proof = book.localSyncMap;
  if (!proof || book.source !== "device") return null;
  if (!/^device:gift:[A-Za-z0-9_-]{16,128}$/.test(book.id) || !Array.isArray(proof.audio) || !proof.audio.length || proof.audio.length > 256) throw invalid();
  const giftId = book.id.slice("device:gift:".length), directory = `device-library/gift-${giftId}`;
  const companion = book.companions?.find(file => file.id === book.readingFile?.id);
  const assets: NativeGiftAsset[] = [{ ...proof.asset, kind: "alignment" }, { ...proof.ebook, kind: "ebook" }, ...proof.audio.map(asset => ({ name: asset.name, size: asset.size, sha256: asset.sha256, kind: "audio" as const }))];
  const metadata: GiftMetadata = { version: 1, title: book.title, tracks: proof.audio.map((asset, index) => ({ fileName: asset.name, index, title: book.tracks[index]?.title ?? "", durationSeconds: asset.durationSeconds, chapters: [] })), alignment: { assetName: proof.asset.name, ebookAssetName: proof.ebook.name, audioAssetNames: proof.audio.map(asset => asset.name), timeline: "book", precision: "sentence" } };
  parseGiftMetadata(metadata, assets);
  if (!book.readingFile || book.readingFile.extension !== "epub" || companion?.localFilePath !== `${directory}/${proof.ebook.name}` || companion.sizeBytes !== proof.ebook.size || book.tracks.length !== proof.audio.length || proof.audio.some((asset, index) => book.tracks[index].index !== index || book.tracks[index].localFilePath !== `${directory}/${asset.name}` || book.tracks[index].durationSeconds !== asset.durationSeconds)) throw invalid();
  const bytes = await readVerifiedGiftAsset(giftId, { ...proof.asset, kind: "alignment" }, MAX_GIFT_SYNC_BYTES, read, signal);
  return parseGiftSyncMap(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), proof.audio.reduce((sum, asset) => sum + asset.durationSeconds, 0));
}
