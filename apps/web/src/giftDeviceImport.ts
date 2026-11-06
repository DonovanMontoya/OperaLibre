import { registerPlugin } from "@capacitor/core";
import { isSupportedAudioFileName } from "./mediaFiles.ts";
import { publishGiftIndex, recoverGiftIndex } from "./giftLibraryIndex.ts";
import type { Book, MetadataSummary, Track } from "./types";

export type NativeGiftAsset = { name: string; size: number; sha256: string; kind: "ebook" | "audio" | "cover" | "metadata" | "alignment" };
type NativeGiftPlugin = { extract(input: { giftId: string; assets: NativeGiftAsset[] }): Promise<{ directory: string }> };
type GiftMetadata = { title: string; author?: string | null; description?: string | null };
type JournalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const IMPORT_JOURNAL = "operalibre.giftExtractionJournal.v1";
const nativeGift = registerPlugin<NativeGiftPlugin>("GiftImport");
const activeImports = new WeakSet<JournalStorage>();
// The app has no reviewed entry point or native crash recovery yet.
const GIFT_IMPORT_ENABLED = false;

export function buildGiftDeviceBook(giftId: string, assets: NativeGiftAsset[], metadata: GiftMetadata): Book {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(giftId) || !metadata.title?.trim() || !assets.length || assets.length > 256) throw new Error("Invalid gift metadata.");
  const names = new Set<string>();
  for (const asset of assets) {
    if (!asset.name || asset.name === "." || asset.name === ".." || /[\\/\x00-\x1f\x7f]/.test(asset.name) || names.has(asset.name) || !["ebook", "audio", "cover", "metadata", "alignment"].includes(asset.kind) || !Number.isSafeInteger(asset.size) || asset.size < 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error("Invalid gift asset.");
    names.add(asset.name);
  }
  // Offline sync-map integration for device books is not implemented yet.
  if (assets.some(asset => asset.kind === "alignment")) throw new Error("Read-along gift import is not available yet.");
  const ebooks = assets.filter(asset => asset.kind === "ebook");
  const covers = assets.filter(asset => asset.kind === "cover");
  if (ebooks.length > 1 || covers.length > 1 || ebooks.some(asset => !asset.name.toLowerCase().endsWith(".epub"))) throw new Error("Unsupported gift contents.");
  const audio = assets.filter(asset => asset.kind === "audio");
  if (!ebooks.length && !audio.length) throw new Error("Gift contains no book files.");
  if (audio.some(asset => !isSupportedAudioFileName(asset.name))) throw new Error("Unsupported gift audio.");
  const id = `device:gift:${giftId}`;
  const directory = `device-library/gift-${giftId}`;
  const empty: MetadataSummary = { album: null, subtitle: null, publisher: null, publishedDate: null, description: null, language: null, series: null, seriesPosition: null, genres: [], rawFields: [] };
  const tracks: Track[] = audio.map((asset, index) => ({ id: `${id}:track:${index + 1}`, title: asset.name.replace(/\.[^.]+$/, ""), fileName: asset.name, index, durationSeconds: null, streamUrl: "", chapters: [], metadata: empty, localFilePath: `${directory}/${asset.name}` }));
  const ebook = ebooks[0];
  const reading = ebook ? { id: `${id}:epub`, fileName: ebook.name, extension: "epub", contentType: "application/epub+zip", url: `/device-books/${encodeURIComponent(id)}/reading.epub` } : null;
  const cover = covers[0];
  const coverType = cover?.name.toLowerCase().endsWith(".png") ? "image/png" : cover?.name.toLowerCase().endsWith(".webp") ? "image/webp" : "image/jpeg";
  return { id, deviceBookId: id, source: "device", title: metadata.title.trim(), author: metadata.author ?? null, narrator: null, description: metadata.description ?? null, durationSeconds: null, trackCount: tracks.length, coverArtUrl: null, coverArtContentType: cover ? coverType : null, localCoverPath: cover ? `${directory}/${cover.name}` : undefined, genres: [], tags: [], publishedDate: null, asin: null, addedAt: new Date().toISOString(), readingFile: reading, companions: reading && ebook ? [{ ...reading, kind: "book", sizeBytes: ebook.size, localFilePath: `${directory}/${ebook.name}` }] : [], syncFile: null, chapters: [], metadata: empty, tracks, progress: null };
}

/** A retry must re-verify the already committed native directory. */
async function recoverExtraction(storage: JournalStorage, extract: NativeGiftPlugin["extract"]): Promise<"imported" | "duplicate" | null> {
  const raw = storage.getItem(IMPORT_JOURNAL);
  if (!raw) return null;
  const pending = JSON.parse(raw) as { giftId: string; assets: NativeGiftAsset[]; metadata: GiftMetadata };
  const book = buildGiftDeviceBook(pending.giftId, pending.assets, pending.metadata);
  const { directory } = await extract({ giftId: pending.giftId, assets: pending.assets });
  if (directory !== `device-library/gift-${pending.giftId}`) throw new Error("Unexpected gift destination.");
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

export async function recoverGiftExtraction(storage: JournalStorage, extract: NativeGiftPlugin["extract"]): Promise<"imported" | "duplicate" | null> {
  return withImportLock(storage, () => recoverExtraction(storage, extract));
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

export async function stageGiftImport(storage: JournalStorage, giftId: string, assets: NativeGiftAsset[], metadata: GiftMetadata, extract: NativeGiftPlugin["extract"]): Promise<"imported" | "duplicate"> {
  buildGiftDeviceBook(giftId, assets, metadata);
  return withImportLock(storage, async () => {
    if (storage.getItem(IMPORT_JOURNAL)) throw new Error("Recover the pending gift before importing another.");
    // Journal precedes native extraction. If the app dies after the native
    // directory rename, retry checks all committed files before publishing.
    storage.setItem(IMPORT_JOURNAL, JSON.stringify({ giftId, assets, metadata }));
    const result = await recoverExtraction(storage, extract);
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
