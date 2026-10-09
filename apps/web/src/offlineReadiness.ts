import type { Book, CompanionFile, SyncMap } from "./types";

export type OfflineAvailability = "available" | "missing" | "not-present" | "unsupported" | "needs-ebook";
export type OfflineReadiness = {
  audio: boolean;
  ebook: OfflineAvailability;
  sentenceSync: OfflineAvailability;
  missingFiles: string[];
};

/** Older servers supplied the primary reading file without a companion list. */
export function offlineCompanions(book: Pick<Book, "companions" | "readingFile">): CompanionFile[] {
  const companions = book.companions ?? [];
  if (!book.readingFile || companions.some((file) => file.id === book.readingFile!.id)) return companions;
  return [...companions, { ...book.readingFile, kind: "book", sizeBytes: 0 }];
}

export function hasSentenceTimings(map: SyncMap | null) {
  return !!map && (map.precision ?? "sentence") === "sentence"
    && Array.isArray(map.fragments) && map.fragments.length > 0;
}

/** Inspect durable files, rather than trusting a completed transfer or an old badge. */
export async function inspectOfflineReadiness(
  book: Book,
  audio: boolean,
  exists: (kind: string) => Promise<boolean>,
  readSync: () => Promise<SyncMap | null>,
  coverKind: string
): Promise<OfflineReadiness> {
  const companions = offlineCompanions(book);
  const stored = new Map(await Promise.all(companions.map(async (file) =>
    [file.id, await exists(`companion:${file.id}`)] as const)));
  const ebook = companions.find((file) => file.id === book.readingFile?.id)
    ?? companions.find((file) => file.kind === "book");
  const ebookState: OfflineAvailability = !ebook ? "not-present"
    : ebook.extension.toLowerCase() !== "epub" || ebook.unreadable ? "unsupported"
    : stored.get(ebook.id) ? "available" : "missing";
  const map = book.syncFile ? await readSync() : null;
  const mapPresent = hasSentenceTimings(map);
  const sentenceSync: OfflineAvailability = ebookState === "unsupported" || ebookState === "not-present"
    ? "unsupported" : !book.syncFile ? "not-present"
    : map && (map.precision ?? "sentence") !== "sentence" ? "unsupported"
    : !mapPresent ? "missing" : ebookState !== "available" ? "needs-ebook" : "available";
  const missingFiles = companions.filter((file) => !stored.get(file.id)).map((file) => `companion:${file.id}`);
  if (book.coverArtUrl && !(await exists(coverKind))) missingFiles.push(coverKind);
  if (book.syncFile && ebookState !== "not-present" && ebookState !== "unsupported"
    && !mapPresent && (!map || (map.precision ?? "sentence") === "sentence")) missingFiles.push("sync");
  return { audio, ebook: ebookState, sentenceSync, missingFiles };
}

const labels: Record<OfflineAvailability, string> = {
  available: "ready", missing: "missing", "not-present": "not provided",
  unsupported: "not supported", "needs-ebook": "needs ebook"
};

export function offlineReadinessSummary(readiness?: OfflineReadiness) {
  if (!readiness) return "Checking offline files…";
  return `Audio: ${readiness.audio ? "ready" : "missing"} · Ebook: ${labels[readiness.ebook]} · Sentence sync: ${labels[readiness.sentenceSync]}`;
}

export function offlineDownloadMessage(title: string, readiness: OfflineReadiness) {
  return `${title} — ${offlineReadinessSummary(readiness)}${readiness.missingFiles.length ? ". Retry missing files when connected." : ""}`;
}

export function offlineMissingFileLabels(book: Book, readiness?: OfflineReadiness): string[] {
  return (readiness?.missingFiles ?? []).map((kind) => {
    if (kind === "cover" || kind.startsWith("cover:")) return "cover art";
    if (kind === "sync") return "follow-along timing";
    return offlineCompanions(book).find((file) => `companion:${file.id}` === kind)?.fileName ?? "companion file";
  });
}
