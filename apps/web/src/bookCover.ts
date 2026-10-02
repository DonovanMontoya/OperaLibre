import type { Book } from "./types";

export const MAX_COVER_BYTES = 8 * 1024 * 1024;
export const COVER_FILE_ACCEPT = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

export function coverFileError(file: Pick<File, "name" | "size" | "type">): string | null {
  if (file.size === 0) return "Choose an image that is not empty.";
  if (file.size > MAX_COVER_BYTES) return "The cover must be 8 MiB or smaller.";
  const supported = file.type
    ? ["image/jpeg", "image/png", "image/webp"].includes(file.type.toLowerCase())
    : /\.(jpe?g|png|webp)$/i.test(file.name);
  return supported ? null : "Choose a JPEG, PNG, or WebP image.";
}

/** Version only artwork storage, so replacing a cover never removes downloaded audio. */
export function coverRevision(book: Pick<Book, "coverArtUrl">): string | null {
  const query = book.coverArtUrl?.split("?")[1]?.split("#")[0];
  const revision = new URLSearchParams(query).get("v");
  return revision && /^[A-Za-z0-9_-]{1,128}$/.test(revision) ? revision : null;
}

export function coverMediaKind(book: Pick<Book, "coverArtUrl">): string {
  const revision = coverRevision(book);
  return revision ? `cover:${revision}` : "cover";
}

/** Edit responses must not overwrite playback or local copies changed during the request. */
export function mergeBookEdit(current: Book, updated: Book, kind: "metadata" | "cover"): Book {
  if (kind === "cover") {
    return { ...current, coverArtUrl: updated.coverArtUrl,
      coverArtContentType: updated.coverArtContentType, hasCoverOverride: updated.hasCoverOverride };
  }
  return { ...current, title: updated.title, author: updated.author, narrator: updated.narrator,
    description: updated.description, genres: updated.genres, tags: updated.tags,
    publishedDate: updated.publishedDate, asin: updated.asin, metadata: updated.metadata };
}
