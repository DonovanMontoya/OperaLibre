import type { Book } from "epubjs";
import type Archive from "epubjs/types/archive";

/** Keep the original media token and reverse-proxy prefix on every member URL. */
export function epubEntryUrl(source: string, path: string): string {
  const url = new URL(source, globalThis.location?.href);
  const member = decodeURIComponent(path.replace(/^\//, ""));
  if (member.split("/").some((part) => part === "..") || member.includes("\\")) {
    throw new Error("Invalid EPUB entry path");
  }
  url.pathname += `/entries/${member.split("/").map((part) =>
    encodeURIComponent(part).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  ).join("/")}`;
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
  const stylesheetUrls = new Set<string>();
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
    createCssUrl(text: string) {
      const url = URL.createObjectURL(new Blob([text], { type: "text/css" }));
      stylesheetUrls.add(url);
      return url;
    },
    revokeUrl(url: string) {
      if (stylesheetUrls.delete(url)) URL.revokeObjectURL(url);
    },
    destroy() {
      stylesheetUrls.forEach((url) => URL.revokeObjectURL(url));
      stylesheetUrls.clear();
    }
  };
}

/** Probe before changing epub.js state so older servers retain whole-file loading. */
export async function prepareStreamingEpub(source: string, signal: AbortSignal) {
  if (!supportsStreamingEpub(source)) return null;
  const response = await fetch(epubEntryUrl(source, "META-INF/container.xml"), {
    credentials: "include", signal
  });
  if (response.status === 401 || response.status === 404) return null;
  if (!response.ok) throw new Error(`EPUB request failed with ${response.status}`);
  return streamingArchive(source, signal, await response.text());
}

/** Preserve previously cached previews offline without downloading an archive
 * during a normal streaming open or concealing an access denial. */
export async function prepareEpubRead(
  source: ArrayBuffer | string,
  signal: AbortSignal,
  readCached?: () => Promise<ArrayBuffer | null>,
  loadWholeFile?: (url: string, signal: AbortSignal) => Promise<ArrayBuffer>
) {
  signal.throwIfAborted();
  if (typeof source !== "string") return { data: source };
  try {
    const archive = await prepareStreamingEpub(source, signal);
    signal.throwIfAborted();
    if (archive) return { archive: cachedStreamingArchive(archive, signal, readCached) };
    if (loadWholeFile) {
      const data = await loadWholeFile(source, signal);
      signal.throwIfAborted();
      return { data };
    }
    const response = await fetch(source, { credentials: "include", signal });
    if (!response.ok) throw new Error(`EPUB request failed with ${response.status}`);
    const data = await response.arrayBuffer();
    signal.throwIfAborted();
    return { data };
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

function cachedStreamingArchive(
  streaming: ReturnType<typeof streamingArchive>,
  signal: AbortSignal,
  readCached?: () => Promise<ArrayBuffer | null>
) {
  let destroyed = false;
  let fallback: Archive | undefined;
  let recovery: Promise<Archive> | undefined;
  let openCached: ((data: ArrayBuffer) => Promise<Archive>) | undefined;
  const urls = new Set<string>();
  const checkActive = () => {
    signal.throwIfAborted();
    if (destroyed) throw new DOMException("EPUB archive destroyed", "AbortError");
  };
  const destroy = () => {
    destroyed = true;
    streaming.destroy();
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls.clear();
    fallback?.destroy();
    fallback = undefined;
    signal.removeEventListener("abort", destroy);
  };
  signal.addEventListener("abort", destroy, { once: true });
  const recover = (error: unknown) => {
    checkActive();
    if (!(error instanceof TypeError) || !readCached || !openCached) throw error;
    if (recovery) return recovery;
    const attempt = (async () => {
      const data = await readCached().catch(() => null);
      checkActive();
      if (!data) throw error;
      const archive = await openCached!(data);
      if (destroyed || signal.aborted) {
        archive.destroy();
        checkActive();
      }
      fallback = archive;
      return archive;
    })();
    recovery = attempt;
    // Without a local copy the failure belongs to this read alone. Later reads
    // must try the network again rather than replay a transient outage.
    attempt.catch(() => {
      if (recovery === attempt) recovery = undefined;
    });
    return attempt;
  };
  /** The recovered local archive, or undefined when none is open or opening one failed. */
  const recoveredArchive = async () => {
    const archive = recovery ? await recovery.catch(() => undefined) : undefined;
    checkActive();
    return archive;
  };
  const read = async <T>(online: () => Promise<T>, cached: (archive: Archive) => Promise<T>): Promise<T> => {
    checkActive();
    const recovered = await recoveredArchive();
    if (recovered) {
      const result = await cached(recovered);
      checkActive();
      return result;
    }
    try {
      const result = await online();
      checkActive();
      const recoveredDuringRead = await recoveredArchive();
      if (recoveredDuringRead) {
        const cachedResult = await cached(recoveredDuringRead);
        checkActive();
        return cachedResult;
      }
      return result;
    } catch (error) {
      const result = await cached(await recover(error));
      checkActive();
      return result;
    }
  };
  return {
    ...streaming,
    getText: (path: string) => read(() => streaming.getText(path), async (archive) => {
      const text = await archive.getText(path);
      if (text === undefined) throw new Error(`File not found in the epub: ${path}`);
      return text;
    }),
    request: (path: string, type?: string) => read<unknown>(
      () => streaming.request(path, type), (archive) => archive.request(path, type)
    ),
    async createUrl(path: string) {
      const recovered = await recoveredArchive();
      if (!recovered) return streaming.createUrl(path);
      const url = await recovered.createUrl(path, { base64: false });
      if (destroyed || signal.aborted) {
        URL.revokeObjectURL(url);
        checkActive();
      }
      urls.add(url);
      return url;
    },
    createCssUrl(text: string) {
      checkActive();
      return streaming.createCssUrl(text);
    },
    revokeUrl(url: string) {
      streaming.revokeUrl(url);
      if (urls.delete(url)) URL.revokeObjectURL(url);
    },
    destroy,
    hasFallback: () => !!fallback,
    setFallbackLoader(loader: (data: ArrayBuffer) => Promise<Archive>) { openCached = loader; }
  };
}

export function attachEpubReadArchive(book: Book, archive: ReturnType<typeof cachedStreamingArchive>) {
  const unarchive = book.unarchive;
  archive.setFallbackLoader(async (data) => {
    const holder = { archive: undefined as Archive | undefined };
    try {
      await unarchive.call(holder as Book, data as unknown as BinaryType);
      return holder.archive!;
    } catch (error) {
      holder.archive?.destroy();
      throw error;
    }
  });
  attachStreamingArchive(book, archive as ReturnType<typeof streamingArchive>);
  const streamingBook = book as unknown as {
    replacements(): Promise<unknown>;
    resources: { replacements(): Promise<unknown>; replaceCss(): Promise<unknown> };
  };
  const replacements = streamingBook.replacements.bind(book);
  let refreshed: Promise<unknown> | undefined;
  const refresh = () => {
    if (!archive.hasFallback()) return Promise.resolve();
    refreshed ??= streamingBook.resources.replacements().then(() => streamingBook.resources.replaceCss());
    return refreshed;
  };
  streamingBook.replacements = async () => {
    await replacements();
    await refresh();
  };
  book.spine.hooks.content.register(async () => {
    await book.opened;
    await refresh();
  });
}

export function attachStreamingArchive(book: Book, archive: ReturnType<typeof streamingArchive>) {
  // epub.js exposes unarchive as its extension point. Its normal open("binary")
  // establishes archive-relative paths, then uses this adapter for all reads.
  book.unarchive = async () => {
    book.archive = archive as unknown as Archive;
    return book.archive;
  };
  const streamingBook = book as unknown as {
    replacements(): Promise<unknown>;
    resources: {
      urls: string[];
      replacementUrls: string[];
      relativeTo(url: string): string[];
      substitute(content: string, url?: string): string;
      createCssFile(href: string): Promise<string | undefined>;
    };
  };
  const replacements = streamingBook.replacements.bind(book);
  streamingBook.replacements = () => {
    const resources = streamingBook.resources;
    const substitute = (content: string, urls: string[]) => {
      const substitutions = new Map<string, string>();
      urls.forEach((url, index) => {
        if (url && resources.replacementUrls[index]) {
          substitutions.set(url, resources.replacementUrls[index]);
        }
      });
      const patterns = [...substitutions.keys()]
        .sort((left, right) => right.length - left.length)
        .map((url) => url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      if (!patterns.length) return content;
      return content.replace(new RegExp(patterns.join("|"), "g"),
        (url) => substitutions.get(url)!);
    };
    resources.substitute = (content, url) =>
      substitute(content, url ? resources.relativeTo(url) : resources.urls);
    resources.createCssFile = async (href) => {
      const absolute = book.resolve(href);
      let text: string;
      try {
        text = await archive.getText(absolute);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        return undefined;
      }
      return archive.createCssUrl(substitute(text, resources.relativeTo(absolute)));
    };
    return replacements();
  };
}
