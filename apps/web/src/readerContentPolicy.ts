import type { Book } from "epubjs";
import type Section from "epubjs/types/section";

/** What a page of book markup may load: only the book's own files, which
 * arrive as data: or blob: URLs or from the server streaming the EPUB. */
export function readerContentPolicy(streamedFrom?: string): string {
  const own = ["data:", "blob:"];
  if (streamedFrom) own.push(new URL(streamedFrom, globalThis.location?.href).origin);
  const sources = own.join(" ");
  return `default-src 'none'; img-src ${sources}; media-src ${sources}; font-src ${sources}; style-src 'unsafe-inline' ${sources}`;
}

/** Keep a book from contacting any other host when its pages are displayed.
 * Register after `book.opened`: epub.js's own serialize hook replaces the
 * page markup, so this one has to run after it.
 */
export function restrictEpubContent(book: Book, streamedFrom?: string) {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${readerContentPolicy(streamedFrom)}">`;
  // A content policy does not govern connection hints such as preconnect, so
  // the links a chapter declares are dropped unless they are stylesheets, and
  // a stylesheet link keeps no other relationship.
  book.spine.hooks.content.register((document: Document) => {
    document.querySelectorAll("link").forEach((link) => {
      const rel = (link.getAttribute("rel") ?? "").toLowerCase().split(/\s+/)
        .filter((token) => token === "stylesheet" || token === "alternate");
      if (rel.includes("stylesheet")) link.setAttribute("rel", rel.join(" "));
      else link.remove();
    });
  });
  // Ahead of the markup rather than inside its <head>: the HTML parser then
  // puts the policy in force before any element the book supplies, however
  // the chapter is formed.
  book.spine.hooks.serialize.register((_output: string, section: Section) => {
    section.output = policy + section.output;
  });
}
