import type { BookTag, MetadataSummary } from "./types";
import type { NativeGiftAsset } from "./giftDeviceImport.ts";

export const MAX_GIFT_METADATA_BYTES = 256 * 1024;
// Receiver capability inside the independently disabled gift entry/import and
// native-plugin gates. A receipt-bound map must still validate before indexing.
export const GIFT_ALIGNMENT_IMPORT_ENABLED = true;
export const MAX_GIFT_TIMELINE_SECONDS = 366 * 24 * 60 * 60;
export type GiftTrackMetadata = {
  fileName: string; index: number; title: string; durationSeconds: number | null;
  chapters: { title: string; startSeconds: number; endSeconds: number | null }[];
};
export type GiftAlignmentMetadata = { assetName: string; ebookAssetName: string; audioAssetNames: string[]; timeline: "book"; precision: "sentence" };
export type GiftMetadata = {
  title: string; author?: string | null; narrator?: string | null; description?: string | null;
  genres?: string[]; tags?: BookTag[]; publishedDate?: string | null; asin?: string | null;
  version?: 0 | 1; metadata?: MetadataSummary; tracks?: GiftTrackMetadata[]; alignment?: GiftAlignmentMetadata;
};
const invalid = () => new Error("Invalid gift indexing metadata.");
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw invalid();
}
function text(value: unknown, max: number, required = false): string | null {
  if (value == null && !required) return null;
  if (typeof value !== "string" || Array.from(value).length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || (required && !value.trim())) throw invalid();
  return value;
}
function strings(value: unknown, maximum = 64): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw invalid();
  return value.map(item => text(item, 256, true)!);
}
function time(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_GIFT_TIMELINE_SECONDS;
}
export function emptyGiftMetadataSummary(): MetadataSummary {
  return { album: null, subtitle: null, publisher: null, publishedDate: null, description: null, language: null, series: null, seriesPosition: null, genres: [], rawFields: [] };
}
function summary(value: unknown): MetadataSummary {
  const input = record(value), result = emptyGiftMetadataSummary();
  keys(input, [...Object.keys(result)]);
  // Arbitrary source tags can contain paths and private fields. They do not
  // belong in a gift's safe metadata projection.
  if (input.rawFields !== undefined && (!Array.isArray(input.rawFields) || input.rawFields.length)) throw invalid();
  for (const key of ["album", "subtitle", "publisher", "publishedDate", "description", "language", "series", "seriesPosition"] as const) {
    result[key] = text(input[key], key === "description" ? 32000 : 1024);
  }
  if (input.genres !== undefined) result.genres = strings(input.genres);
  return result;
}

/** Parses only bibliographic fields, never a sender Book, URL, ID or progress. */
export function parseGiftMetadata(value: unknown, assets?: NativeGiftAsset[]): GiftMetadata {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_GIFT_METADATA_BYTES) throw invalid();
  const input = record(value);
  const fields = ["title", "author", "narrator", "description", "genres", "tags", "publishedDate", "asin"];
  keys(input, [...fields, "version", "metadata", "tracks", "alignment"]);
  const result: GiftMetadata = { title: text(input.title, 1024, true)!.trim() };
  for (const key of ["author", "narrator", "description", "publishedDate", "asin"] as const) {
    if (own(input, key)) result[key] = text(input[key], key === "description" ? 32000 : 1024);
  }
  if (own(input, "genres")) result.genres = strings(input.genres);
  if (own(input, "tags")) {
    if (!Array.isArray(input.tags) || input.tags.length > 64) throw invalid();
    result.tags = input.tags.map(item => {
      const tag = record(item); keys(tag, ["name", "position"]);
      return { name: text(tag.name, 256, true)!, position: text(tag.position, 128) };
    });
  }
  if (["metadata", "tracks", "alignment"].some(key => own(input, key)) && input.version !== 1) throw invalid();
  if (own(input, "version")) {
    if (input.version !== 0 && input.version !== 1) throw invalid();
    result.version = input.version;
  }
  if (own(input, "metadata")) result.metadata = summary(input.metadata);
  if (own(input, "tracks")) {
    if (!Array.isArray(input.tracks) || input.tracks.length > 256) throw invalid();
    const names = new Set<string>(); let chapterCount = 0, duration = 0;
    result.tracks = input.tracks.map(value => {
      const track = record(value); keys(track, ["fileName", "index", "title", "durationSeconds", "chapters"]);
      const fileName = text(track.fileName, 255, true)!;
      if (/[\\/]/.test(fileName) || names.has(fileName.toLowerCase()) || track.index !== names.size || (track.durationSeconds !== null && (!time(track.durationSeconds) || track.durationSeconds <= 0))) throw invalid();
      names.add(fileName.toLowerCase());
      duration += (track.durationSeconds as number | null) ?? 0;
      if (duration > MAX_GIFT_TIMELINE_SECONDS || !Array.isArray(track.chapters) || (chapterCount += track.chapters.length) > 4096) throw invalid();
      let previous = -1;
      const chapters = track.chapters.map(value => {
        const chapter = record(value); keys(chapter, ["title", "startSeconds", "endSeconds"]);
        if (!time(chapter.startSeconds) || chapter.startSeconds < previous || (track.durationSeconds !== null && chapter.startSeconds > (track.durationSeconds as number)) || (chapter.endSeconds !== null && (!time(chapter.endSeconds) || chapter.endSeconds < chapter.startSeconds || (track.durationSeconds !== null && chapter.endSeconds > (track.durationSeconds as number))))) throw invalid();
        previous = chapter.startSeconds;
        return { title: text(chapter.title, 1024, true)!, startSeconds: chapter.startSeconds, endSeconds: chapter.endSeconds as number | null };
      });
      return { fileName, index: track.index as number, title: text(track.title, 1024, true)!, durationSeconds: track.durationSeconds as number | null, chapters };
    });
    if (assets) {
      const audio = assets.filter(asset => asset.kind === "audio");
      if (audio.length !== result.tracks.length || result.tracks.some(track => !audio.some(asset => asset.name === track.fileName))) throw invalid();
    }
  }
  if (own(input, "alignment")) {
    const alignment = record(input.alignment); keys(alignment, ["assetName", "ebookAssetName", "audioAssetNames", "timeline", "precision"]);
    if (alignment.timeline !== "book" || alignment.precision !== "sentence" || !result.tracks?.length || result.tracks.some(track => track.durationSeconds === null)) throw invalid();
    const audioAssetNames = strings(alignment.audioAssetNames, 256);
    if (audioAssetNames.length !== result.tracks.length || audioAssetNames.some((name, index) => name !== result.tracks![index].fileName)) throw invalid();
    const assetName = text(alignment.assetName, 255, true)!, ebookAssetName = text(alignment.ebookAssetName, 255, true)!;
    if (/[\\/]/.test(assetName + ebookAssetName)) throw invalid();
    if (assets && (assets.filter(asset => asset.kind === "alignment").length !== 1 || !assets.some(asset => asset.kind === "alignment" && asset.name === assetName) || assets.filter(asset => asset.kind === "ebook").length !== 1 || !assets.some(asset => asset.kind === "ebook" && asset.name === ebookAssetName))) throw invalid();
    result.alignment = { assetName, ebookAssetName, audioAssetNames, timeline: "book", precision: "sentence" };
  }
  return result;
}

/** Small signed projection only; the full descriptor remains receipt-bound in
 * metadata.json, so chapters cannot displace a usable encrypted gift preview. */
export function parseGiftPreviewMetadata(value: unknown, fallback: GiftMetadata): GiftMetadata {
  if (value === undefined) return parseGiftMetadata(fallback);
  const metadata = parseGiftMetadata(value);
  if (metadata.version !== undefined || metadata.metadata || metadata.tracks || metadata.alignment || metadata.title !== fallback.title.trim() || (metadata.author ?? null) !== (fallback.author ?? null) || (metadata.description ?? null) !== (fallback.description ?? null)) throw invalid();
  return metadata;
}

export function assertGiftMetadataProjection(full: GiftMetadata, preview: GiftMetadata): void {
  for (const key of ["title", "author", "narrator", "description", "genres", "tags", "publishedDate", "asin"] as const) {
    if (own(preview, key) && JSON.stringify(full[key] ?? null) !== JSON.stringify(preview[key] ?? null)) throw new Error("Gift metadata does not match its authenticated preview.");
  }
}
