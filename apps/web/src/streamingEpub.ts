import type { Book } from "epubjs";
import type Archive from "epubjs/types/archive";

/** Keep the original media token and reverse-proxy prefix on every member URL. */
export function epubEntryUrl(source: string, path: string): string {
  const url = new URL(source, globalThis.location?.href);
  const member = decodeURIComponent(path.replace(/^\//, ""));
  if (member.split("/").some((part) => part === "..") || member.includes("\\")) {
    throw new Error("Invalid EPUB entry path");
  }
  url.pathname += `/entries/${member.split("/").map(encodeURIComponent).join("/")}`;
  url.hash = "";
  return url.href;
}

export function supportsStreamingEpub(source: string): boolean {
  try {
    return /\/api\/books\/[^/]+\/companions\/[^/]+$/.test(new URL(source, globalThis.location?.href).pathname);
  } catch {
    return false;
  }
}

/** epub.js's archive interface backed by individual authenticated ZIP members.
 * Resource URLs are cheap to create: images/fonts are fetched by the browser
 * only when displayed. epub.js still rewrites stylesheet-relative resources.
 */
export function streamingArchive(source: string, signal: AbortSignal, container: string) {
  const getText = async (path: string): Promise<string> => {
    signal.throwIfAborted();
    if (path === "/META-INF/container.xml") return container;
    const response = await fetch(epubEntryUrl(source, path), { credentials: "include", signal });
    if (!response.ok) throw new Error(`EPUB entry request failed with ${response.status}`);
    return response.text();
  };
  return {
    getText,
    async request(path: string, type?: string) {
      const text = await getText(path);
      const extension = type || path.split(".").pop();
      if (extension === "json") return JSON.parse(text);
      if (["xml", "opf", "ncx", "xhtml", "html", "htm"].includes(extension ?? "")) {
        const mime = extension === "xhtml" ? "application/xhtml+xml"
          : extension === "html" || extension === "htm" ? "text/html" : "text/xml";
        return new DOMParser().parseFromString(text, mime);
      }
      return text;
    },
    async createUrl(path: string) { return epubEntryUrl(source, path); },
    revokeUrl() {},
    destroy() {}
  };
}

/** Probe before changing epub.js state so older servers retain whole-file loading. */
export async function prepareStreamingEpub(source: string, signal: AbortSignal) {
  if (!supportsStreamingEpub(source)) return null;
  const response = await fetch(epubEntryUrl(source, "META-INF/container.xml"), {
    credentials: "include", signal
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`EPUB request failed with ${response.status}`);
  return streamingArchive(source, signal, await response.text());
}

/** Preserve previously cached previews offline without downloading an archive
 * during a normal streaming open or concealing an access denial. */
export async function prepareEpubRead(
  source: ArrayBuffer | string,
  signal: AbortSignal,
  readCached?: () => Promise<ArrayBuffer | null>
) {
  signal.throwIfAborted();
  if (typeof source !== "string") return { data: source };
  try {
    const archive = await prepareStreamingEpub(source, signal);
    if (archive) return { archive };
    const response = await fetch(source, { credentials: "include", signal });
    if (!response.ok) throw new Error(`EPUB request failed with ${response.status}`);
    return { data: await response.arrayBuffer() };
  } catch (error) {
    signal.throwIfAborted();
    // Fetch uses TypeError for network failures. HTTP denials above remain
    // ordinary errors, so a revoked document never opens from this fallback.
    if (!(error instanceof TypeError) || !readCached) throw error;
    const data = await readCached().catch(() => null);
    signal.throwIfAborted();
    if (!data) throw error;
    return { data };
  }
}

export function attachStreamingArchive(book: Book, archive: ReturnType<typeof streamingArchive>) {
  // epub.js exposes unarchive as its extension point. Its normal open("binary")
  // establishes archive-relative paths, then uses this adapter for all reads.
  book.unarchive = async () => {
    book.archive = archive as unknown as Archive;
    return book.archive;
  };
}
