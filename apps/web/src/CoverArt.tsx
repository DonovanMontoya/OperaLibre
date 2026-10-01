import { Capacitor } from "@capacitor/core";
import { Headphones } from "lucide-react";
import { useEffect, useState } from "react";
import { getServerStorageKey, mediaUrl } from "./api";
import { getOfflineCoverUrl, releaseOfflineMediaUrl } from "./offline";
import type { Book, LibationBook } from "./types";

export function DownloadRing({ fraction }: { fraction: number | null }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const filled = fraction === null ? 0.28 : Math.max(0.02, Math.min(1, fraction));
  return (
    <svg
      className={`download-ring ${fraction === null ? "indeterminate" : ""}`}
      viewBox="0 0 14 14"
      width={14}
      height={14}
      role="img"
      aria-label={fraction === null ? "Preparing download" : `Downloading, ${Math.round(fraction * 100)}%`}
    >
      <circle className="download-ring-track" cx="7" cy="7" r={radius} />
      <circle
        className="download-ring-fill"
        cx="7"
        cy="7"
        r={radius}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - filled)}
      />
    </svg>
  );
}

export function CoverArt({ book, size }: { book: Book; size: "small" | "large" }) {
  const className = size === "small" ? "cover-mark" : "large-cover";
  const key = `${getServerStorageKey()}:${book.id}:${book.coverArtUrl}:${book.coverArtContentType}:${book.localCoverPath}`;
  const [offline, setOffline] = useState<{ key: string; current: string | null; fallback: string | null } | null>(null);
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    const resolvedUrls: (string | null)[] = [];
    setFailed([]);
    if (Capacitor.isNativePlatform()) {
      void Promise.all([getOfflineCoverUrl(book, false), getOfflineCoverUrl(book, true)]).then(([current, fallback]) => {
        resolvedUrls.push(current, fallback);
        if (active) setOffline({ key, current, fallback });
        else resolvedUrls.forEach(releaseOfflineMediaUrl);
      }).catch(() => undefined);
    }
    return () => {
      active = false;
      resolvedUrls.forEach(releaseOfflineMediaUrl);
    };
  }, [book, key]);
  const local = offline?.key === key ? offline : null;
  const primary = local?.current ?? (book.coverArtUrl ? mediaUrl(book.coverArtUrl) : null);
  const fallback = local?.fallback;
  const coverSrc = primary && !failed.includes(primary) ? primary
    : fallback && !failed.includes(fallback) ? fallback : null;
  if (coverSrc) {
    return (
      <img
        className={className}
        src={coverSrc}
        alt=""
        loading={size === "small" ? "lazy" : "eager"}
        decoding="async"
        fetchPriority={size === "large" ? "high" : "auto"}
        onError={() => setFailed(previous => [...previous, coverSrc])}
      />
    );
  }
  return (
    <span className={className} aria-hidden="true">
      <Headphones size={size === "small" ? 22 : 42} strokeWidth={1.25} />
    </span>
  );
}

export function LibationCoverArt({ book }: { book: LibationBook }) {
  const [loadFailed, setLoadFailed] = useState(false);
  if (book.coverArtUrl && !loadFailed) {
    return (
      <img
        className="audible-cover"
        src={mediaUrl(book.coverArtUrl)}
        alt=""
        loading="lazy"
        onError={() => setLoadFailed(true)}
      />
    );
  }
  return (
    <span className="audible-cover placeholder" aria-hidden="true">
      <Headphones size={22} strokeWidth={1.25} />
    </span>
  );
}
