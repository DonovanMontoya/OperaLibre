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

/** What a stored sync map offers: sentence timings, a coarser precision, or nothing usable. */
export type StoredSyncTimings = "sentence" | "other" | "none";

export function storedSyncTimings(map: SyncMap | null): StoredSyncTimings {
  if (map && (map.precision ?? "sentence") !== "sentence") return "other";
  return map && Array.isArray(map.fragments) && map.fragments.length > 0 ? "sentence" : "none";
}

/** Inspect durable files, rather than trusting a completed transfer or an old badge. */
export async function inspectOfflineReadiness(
  book: Book,
  audio: boolean,
  exists: (kind: string) => Promise<boolean>,
  readSync: () => Promise<StoredSyncTimings>,
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
  const timings = book.syncFile ? await readSync() : "none";
  const sentenceSync: OfflineAvailability = ebookState === "unsupported" || ebookState === "not-present"
    ? "unsupported" : !book.syncFile ? "not-present"
    : timings === "other" ? "unsupported"
    : timings === "none" ? "missing" : ebookState !== "available" ? "needs-ebook" : "available";
  const missingFiles = companions.filter((file) => !stored.get(file.id)).map((file) => `companion:${file.id}`);
  if (book.coverArtUrl && !(await exists(coverKind))) missingFiles.push(coverKind);
  if (book.syncFile && timings === "none") missingFiles.push("sync");
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
