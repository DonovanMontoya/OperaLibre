import { registerPlugin } from "@capacitor/core";
import { isSupportedAudioFileName } from "./mediaFiles.ts";
import { publishGiftIndex, recoverGiftIndex } from "./giftLibraryIndex.ts";
import { assertGiftMetadataProjection, emptyGiftMetadataSummary, GIFT_ALIGNMENT_IMPORT_ENABLED, MAX_GIFT_METADATA_BYTES, parseGiftMetadata, type GiftMetadata } from "./giftMetadata.ts";
import { readNativeGiftAsset, readVerifiedGiftAsset, type GiftAssetReader } from "./giftLocalAssets.ts";
import { bindGiftLocalSyncMap } from "./giftLocalSync.ts";
import type { Book, Track } from "./types";
export type { GiftMetadata } from "./giftMetadata.ts";

export type NativeGiftAsset = { name: string; size: number; sha256: string; kind: "ebook" | "audio" | "cover" | "metadata" | "alignment" };
type NativeGiftPlugin = { extract(input: { giftId: string; assets: NativeGiftAsset[] }): Promise<{ directory: string; metadataJson?: string }> };
type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const IMPORT_JOURNAL = "operalibre.giftExtractionJournal.v1";
const nativeGift = registerPlugin<NativeGiftPlugin>("GiftImport");
const activeImports = new WeakSet<JournalStorage>();
// Standalone entry/import remain disabled pending platform delivery validation.
const GIFT_IMPORT_ENABLED = false;
export { GIFT_ALIGNMENT_IMPORT_ENABLED } from "./giftMetadata.ts";

function buildImportBase(giftId: string, assets: NativeGiftAsset[], metadata: GiftMetadata): Book {
  const alignment = assets.filter(asset => asset.kind === "alignment");
  if (assets.length > 256 || alignment.length > 1 || (alignment.length > 0 && assets.filter(asset => asset.kind === "metadata").length !== 1)) throw new Error("Invalid gift alignment dependencies.");
  if (!GIFT_ALIGNMENT_IMPORT_ENABLED && assets.some(asset => asset.kind === "alignment")) throw new Error("Read-along gift import is not available yet.");
  // Base indexing never advertises sentence sync. Only receipt-checked map
  // parsing below can bind syncFile/localSyncMap to this local text/timeline.
  const { alignment: _alignment, ...base } = metadata;
  return buildGiftDeviceBook(giftId, assets.filter(asset => asset.kind !== "alignment"), base);
}

export function buildGiftDeviceBook(giftId: string, assets: NativeGiftAsset[], metadata: GiftMetadata): Book {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(giftId) || !metadata.title?.trim() || !assets.length || assets.length > 256) throw new Error("Invalid gift metadata.");
  const names = new Set<string>();
  for (const asset of assets) {
    if (!asset.name || asset.name === "." || asset.name === ".." || asset.name.length > 255 || /[\\/\x00-\x1f\x7f]/.test(asset.name) || names.has(asset.name.toLowerCase()) || !["ebook", "audio", "cover", "metadata", "alignment"].includes(asset.kind) || !Number.isSafeInteger(asset.size) || asset.size < 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid gift asset.");
    names.add(asset.name.toLowerCase());
  }
  // Base indexing cannot promise follow-along. The staged path separately
  // binds a receipt-checked, compatible local map after native commit.
  if (assets.some(asset => asset.kind === "alignment")) throw new Error("Read-along gift import is not available yet.");
  metadata = parseGiftMetadata(metadata, assets);
  if (metadata.alignment) throw new Error("Read-along gift import is not available yet.");
  if (assets.filter(asset => asset.kind === "metadata").length > 1 || assets.some(asset => asset.kind === "metadata" && (asset.size < 1 || asset.size > MAX_GIFT_METADATA_BYTES))) throw new Error("Invalid gift metadata receipt.");
  const ebooks = assets.filter(asset => asset.kind === "ebook");
  const covers = assets.filter(asset => asset.kind === "cover");
  if (ebooks.length > 1 || covers.length > 1 || ebooks.some(asset => !asset.name.toLowerCase().endsWith(".epub")) || covers.some(asset => !/\.(?:png|jpe?g|webp)$/i.test(asset.name))) throw new Error("Unsupported gift contents.");
  const audio = assets.filter(asset => asset.kind === "audio");
  if (!ebooks.length && !audio.length) throw new Error("Gift contains no book files.");
  if (audio.some(asset => !isSupportedAudioFileName(asset.name))) throw new Error("Unsupported gift audio.");
  const id = `device:gift:${giftId}`;
  const directory = `device-library/gift-${giftId}`;
  const summary = metadata.metadata ?? { ...emptyGiftMetadataSummary(), description: metadata.description ?? null, publishedDate: metadata.publishedDate ?? null, genres: metadata.genres ?? [] };
  const ordered = metadata.tracks ? metadata.tracks.map(track => audio.find(asset => asset.name === track.fileName)!) : audio;
  const tracks: Track[] = ordered.map((asset, index) => {
    const details = metadata.tracks?.[index], trackId = `${id}:track:${index + 1}`;
    const durationSeconds = details?.durationSeconds ?? null;
    const chapters = details?.chapters.length ? details.chapters : [{ title: details?.title ?? asset.name.replace(/\.[^.]+$/, ""), startSeconds: 0, endSeconds: durationSeconds }];
    return { id: trackId, title: details?.title ?? asset.name.replace(/\.[^.]+$/, ""), fileName: asset.name, index, durationSeconds, streamUrl: "", chapters: chapters.map((chapter, chapterIndex) => ({ ...chapter, id: `${trackId}:chapter:${chapterIndex + 1}`, trackId, trackIndex: index, source: details?.chapters.length ? "gift-metadata" : "track-boundary" })), metadata: emptyGiftMetadataSummary(), localFilePath: `${directory}/${asset.name}` };
  });
  const knownDuration = tracks.length > 0 && tracks.every(track => track.durationSeconds !== null);
  let offset = 0;
  const chapters = knownDuration ? tracks.flatMap(track => {
    const result = track.chapters.map(chapter => ({ ...chapter, startSeconds: offset + chapter.startSeconds, endSeconds: chapter.endSeconds === null ? null : offset + chapter.endSeconds }));
    offset += track.durationSeconds!; return result;
  }) : [];
  const ebook = ebooks[0];
  const reading = ebook ? { id: `${id}:epub`, fileName: ebook.name, extension: "epub", contentType: "application/epub+zip", url: `/device-books/${encodeURIComponent(id)}/reading.epub` } : null;
  const cover = covers[0];
  const coverType = cover?.name.toLowerCase().endsWith(".png") ? "image/png" : cover?.name.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg";
  return { id, deviceBookId: id, source: "device", title: metadata.title.trim(), author: metadata.author ?? null, narrator: metadata.narrator ?? null, description: metadata.description ?? null, durationSeconds: knownDuration ? offset : null, trackCount: tracks.length, coverArtUrl: null, coverArtContentType: cover ? coverType : null, localCoverPath: cover ? `${directory}/${cover.name}` : undefined, genres: metadata.genres ?? [], tags: metadata.tags ?? [], publishedDate: metadata.publishedDate ?? null, asin: metadata.asin ?? null, addedAt: new Date().toISOString(), readingFile: reading, companions: reading && ebook ? [{ ...reading, kind: "book", sizeBytes: ebook.size, localFilePath: `${directory}/${ebook.name}` }] : [], syncFile: null, chapters, metadata: summary, tracks, progress: null };
}

/** A retry must re-verify the already committed native directory. */
async function recoverExtraction(storage: JournalStorage, extract: NativeGiftPlugin["extract"], readAsset?: GiftAssetReader): Promise<"imported" | "duplicate" | null> {
  const raw = storage.getItem(IMPORT_JOURNAL);
  if (!raw) return null;
  const pending = JSON.parse(raw) as { giftId: string; assets: NativeGiftAsset[]; metadata: GiftMetadata };
  buildImportBase(pending.giftId, pending.assets, pending.metadata);
  const { directory, metadataJson } = await extract({ giftId: pending.giftId, assets: pending.assets });
  if (directory !== `device-library/gift-${pending.giftId}`) throw new Error("Unexpected gift destination.");
  let metadata = parseGiftMetadata(pending.metadata);
  const descriptor = pending.assets.find(asset => asset.kind === "metadata");
  if (descriptor) {
    // Native returns this only while holding the staging guard, after bounded
    // no-follow reading and receipt verification. Recheck its exact UTF-8 bytes
    // here before interpreting JSON. The injected reader is for host tests.
    let reader = readAsset;
    if (metadataJson !== undefined) {
      if (typeof metadataJson !== "string" || metadataJson.length > MAX_GIFT_METADATA_BYTES) throw new Error("Invalid native gift metadata.");
      const bytes = new TextEncoder().encode(metadataJson);
      if (bytes.length > MAX_GIFT_METADATA_BYTES) throw new Error("Gift metadata exceeds its import limit.");
      reader = async () => bytes;
    }
    if (!reader) throw new Error("Native gift metadata is unavailable. Retry with a supported app.");
    const bytes = await readVerifiedGiftAsset(pending.giftId, descriptor, MAX_GIFT_METADATA_BYTES, reader);
    const full = parseGiftMetadata(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), pending.assets);
    assertGiftMetadataProjection(full, metadata);
    metadata = full;
  }
  let book = buildImportBase(pending.giftId, pending.assets, metadata);
  if (pending.assets.some(asset => asset.kind === "alignment")) {
    if (!descriptor || !metadata.alignment) throw new Error("Gift alignment has no verified metadata dependencies.");
    book = await bindGiftLocalSyncMap(book, pending.assets, metadata, readAsset ?? readNativeGiftAsset);
  }
  const result = publishGiftIndex(storage, pending.giftId, book);
  storage.removeItem(IMPORT_JOURNAL);
  return result;
}

/** Serialize journal operations within this app process. */
async function withImportLock<T>(storage: JournalStorage, action: () => Promise<T>): Promise<T> {
  if (activeImports.has(storage)) throw new Error("A gift import is already in progress.");
  activeImports.add(storage);
  try {
    return await action();
  } finally {
    activeImports.delete(storage);
  }
}

export async function recoverGiftExtraction(storage: JournalStorage, extract: NativeGiftPlugin["extract"], readAsset?: GiftAssetReader): Promise<"imported" | "duplicate" | null> {
  return withImportLock(storage, () => recoverExtraction(storage, extract, readAsset));
}

/** Removal must not race extraction or leave a journal that restores the book. */
export async function removeGiftImport(storage: JournalStorage, bookId: string, remove: () => Promise<void>): Promise<void> {
  if (!/^device:gift:[A-Za-z0-9_-]{16,128}$/.test(bookId)) throw new Error("Invalid gift book identity.");
  return withImportLock(storage, async () => {
    // Recover a committed publication so removal can still find its local files.
    recoverGiftIndex(storage);
    const raw = storage.getItem(IMPORT_JOURNAL);
    if (raw && `device:gift:${JSON.parse(raw).giftId}` === bookId) storage.removeItem(IMPORT_JOURNAL);
    await remove();
  });
}

export async function stageGiftImport(storage: JournalStorage, giftId: string, assets: NativeGiftAsset[], metadata: GiftMetadata, extract: NativeGiftPlugin["extract"], readAsset?: GiftAssetReader): Promise<"imported" | "duplicate"> {
  buildImportBase(giftId, assets, metadata);
  return withImportLock(storage, async () => {
    if (storage.getItem(IMPORT_JOURNAL)) throw new Error("Recover the pending gift before importing another.");
    // Journal precedes native extraction. If the app dies after the native
    // directory rename, retry checks all committed files before publishing.
    storage.setItem(IMPORT_JOURNAL, JSON.stringify({ giftId, assets, metadata }));
    const result = await recoverExtraction(storage, extract, readAsset);
    if (!result) throw new Error("Gift journal was lost.");
    return result;
  });
}

/** Unreachable while disabled; requires verified metadata and a native staged ZIP. */
export async function importNativeGift(giftId: string, assets: NativeGiftAsset[], metadata: GiftMetadata): Promise<"imported" | "duplicate"> {
  if (!GIFT_IMPORT_ENABLED) throw new Error("Gift import is not enabled.");
  return stageGiftImport(localStorage, giftId, assets, metadata, input => nativeGift.extract(input));
}

export async function recoverNativeGiftImport(): Promise<void> {
  if (!GIFT_IMPORT_ENABLED) return;
  await recoverGiftExtraction(localStorage, input => nativeGift.extract(input));
}
