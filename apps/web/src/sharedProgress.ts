import type { SharedProgress } from "./types";

/** Names shown inline on a library row before the rest collapse into "+n". */
const ROW_NAME_LIMIT = 2;

export type SharedProgressSummary = {
  finished: number;
  reading: number;
  /** Compact text for the library row, e.g. "Elena, Sam +2". */
  label: string;
  /** Full sentence for the row's tooltip and screen-reader label. */
  detail: string;
};

export function readerPercentLabel(entry: SharedProgress): string | null {
  if (entry.status === "finished") return null;
  if (entry.percentComplete === null || !Number.isFinite(entry.percentComplete)) {
    return null;
  }
  // Round toward the nearest whole percent but never to 0% or 100%: a reader
  // who has only just started is still reading, and one at 99.6% has not
  // finished until the book says so.
  const clamped = Math.min(99, Math.max(1, Math.round(entry.percentComplete)));
  return `${clamped}%`;
}

export function readerStatusLabel(entry: SharedProgress): string {
  if (entry.status === "finished") return "finished";
  return readerPercentLabel(entry) ?? "reading";
}

export function summarizeSharedProgress(
  entries: SharedProgress[] | undefined
): SharedProgressSummary | null {
  const readers = (entries ?? []).filter((entry) => entry.status !== "notStarted");
  if (readers.length === 0) return null;

  const finished = readers.filter((entry) => entry.status === "finished").length;
  const reading = readers.length - finished;

  const names = readers.map((entry) => entry.username);
  const shown = names.slice(0, ROW_NAME_LIMIT);
  const hidden = names.length - shown.length;
  const label = hidden > 0 ? `${shown.join(", ")} +${hidden}` : shown.join(", ");

  const parts: string[] = [];
  if (finished > 0) parts.push(`${finished} finished`);
  if (reading > 0) parts.push(`${reading} reading`);
  const detail = `${parts.join(" · ")}: ${readers
    .map((entry) => `${entry.username} (${readerStatusLabel(entry)})`)
    .join(", ")}`;

  return { finished, reading, label, detail };
}
