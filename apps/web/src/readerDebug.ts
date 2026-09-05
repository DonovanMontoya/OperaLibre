/**
 * A short, persistent trace of how the reader restores the page, for
 * diagnosing a remembered place that comes back wrong on a device where no
 * console is attached.
 *
 * TEMPORARY: on for every install while the remembered place is being
 * diagnosed on a device. Remove this module and its calls before merging.
 */
const READER_DEBUG_LOG = "operalibre.readerDebugLog";
const MAX_ENTRIES = 200;

/** A CFI shortened to the part that says which page it is. */
export function shortCfi(value: string | null | undefined): string {
  if (!value) return "none";
  return value.replace(/^epubcfi\(/, "").replace(/\)$/, "");
}

export function readerDebugLog(entry: string): void {
  try {
    const stamp = Math.round(performance.now());
    const existing = window.localStorage.getItem(READER_DEBUG_LOG) ?? "";
    const lines = existing ? existing.split("\n") : [];
    lines.push(`${stamp} ${entry}`);
    window.localStorage.setItem(READER_DEBUG_LOG, lines.slice(-MAX_ENTRIES).join("\n"));
  } catch {
    // A full or blocked storage is not worth breaking the reader over.
  }
}
