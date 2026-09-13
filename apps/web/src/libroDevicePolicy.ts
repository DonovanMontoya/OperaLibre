import type { LibroAccountStatus } from "./types.ts";

export function libroDownloadURL(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Libro.fm returned an invalid download address.");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      !(url.hostname === "libro.fm" || [".libro.fm", ".amazonaws.com", ".cloudfront.net"].some(suffix => url.hostname.endsWith(suffix)))) {
    throw new Error("Libro.fm returned an unsupported download address.");
  }
  return url.href;
}

export function libroPage(value: unknown): { pages: number; books: LibroAccountStatus["books"] } {
  const page = value as { total_pages?: unknown; audiobooks?: unknown };
  if (!page || !Number.isInteger(page.total_pages) || Number(page.total_pages) < 0 || Number(page.total_pages) > 200 || !Array.isArray(page.audiobooks)) {
    throw new Error("Libro.fm returned an unexpected library response.");
  }
  const books = page.audiobooks.map((raw, index) => {
    // Report schema facts only: never echo provider values or signed URLs.
    const kind = (value: unknown) => value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    const invalid = (detail: string): never => {
      throw new Error(`Libro.fm returned an unexpected book record (${index + 1}: ${detail}).`);
    };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid(`record is ${kind(raw)}`);
    if (typeof raw.isbn !== "string") invalid(`ISBN is ${kind(raw.isbn)}`);
    if (!/^[0-9X]{10,13}$/.test(raw.isbn)) {
      invalid(`ISBN format: ${raw.isbn.length} characters, ${/^[0-9X]+$/.test(raw.isbn) ? "digits/X only" : "other characters"}`);
    }
    if (typeof raw.title !== "string") invalid(`title is ${kind(raw.title)}`);
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
    return {
      isbn: raw.isbn, title: raw.title, authors: strings(raw.authors),
      cover_url: typeof raw.cover_url === "string" && raw.cover_url.startsWith("https://") ? raw.cover_url : null,
      audiobook_info: { narrators: strings(raw.audiobook_info?.narrators), duration: typeof raw.audiobook_info?.duration === "number" ? raw.audiobook_info.duration : null },
      description: typeof raw.description === "string" ? raw.description : "", localBookId: null
    };
  });
  return { pages: Number(page.total_pages), books };
}
