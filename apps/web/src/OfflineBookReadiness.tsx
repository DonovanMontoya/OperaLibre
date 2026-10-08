import { offlineReadinessSummary, type OfflineReadiness } from "./offlineReadiness";

export function OfflineBookReadiness({ readiness }: { readiness?: OfflineReadiness }) {
  return <span className="offline-readiness">
    {offlineReadinessSummary(readiness).split(" · ").map((label) => (
      <span key={label} className={label.endsWith(": missing") || label.endsWith(": needs ebook") ? "is-missing" : ""}>
        {label}
      </span>
    ))}
    {readiness?.missingFiles.length ? <span className="is-missing">
      {readiness.missingFiles.length} file{readiness.missingFiles.length === 1 ? "" : "s"} missing
    </span> : null}
  </span>;
}
