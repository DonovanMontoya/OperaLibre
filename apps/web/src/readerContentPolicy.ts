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
  // Filter the HTML the iframe will interpret, after resource substitution.
  // XML comments and CDATA can become active elements during HTML parsing.
  book.spine.hooks.serialize.register((_output: string, section: Section) => {
    const document = new DOMParser().parseFromString(section.output, "text/html");
    document.querySelectorAll("*").forEach((element) => {
      const name = element.localName.toLowerCase();
      if (name === "iframe" || name === "frame") {
        // Chromium preconnects before CSP blocks navigation. Keep the nodes
        // for reading CFIs, but neutralize their navigation.
        Array.from(element.attributes).forEach((attribute) => {
          if (/^(src|srcdoc)$/i.test(attribute.name)) element.removeAttributeNode(attribute);
        });
      } else if (name === "link") {
        // CSP does not govern connection hints. Keep only stylesheet links.
        const attributes = Array.from(element.attributes).filter((attribute) => attribute.name.toLowerCase() === "rel");
        const rel = attributes.flatMap((attribute) => attribute.value.toLowerCase().split(/\s+/))
          .filter((token) => token === "stylesheet" || token === "alternate");
        if (rel.includes("stylesheet")) {
          attributes.forEach((attribute) => element.removeAttributeNode(attribute));
          element.setAttribute("rel", rel.join(" "));
        } else element.remove();
      }
    });
    section.output = policy + document.documentElement.outerHTML;
  });
}
