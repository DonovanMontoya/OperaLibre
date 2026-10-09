import { offlineMissingFileLabels, offlineReadinessSummary, type OfflineReadiness } from "./offlineReadiness";

import type { Book } from "./types";

export function OfflineBookReadiness({ book, readiness }: { book: Book; readiness?: OfflineReadiness }) {
  return <span className="offline-readiness">
    {offlineReadinessSummary(readiness).split(" · ").map((label) => (
      <span key={label} className={label.endsWith(": missing") || label.endsWith(": needs ebook") ? "is-missing" : ""}>
        {label}
      </span>
    ))}
    {readiness?.missingFiles.length ? <span className="is-missing">
      Missing: {offlineMissingFileLabels(book, readiness).join(", ")}
    </span> : null}
  </span>;
}
