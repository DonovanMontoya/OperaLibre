import { Headphones } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { getServerStorageKey, mediaUrl } from "./api";
import { displayCoverPath } from "./bookCover";
import { coverRetryDelay, coverRetrySignal } from "./coverRetry";
import { cacheShelfCover } from "./offline";
import type { Book, LibationBook } from "./types";
import { useOfflineCover } from "./useOfflineCover";

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

/**
 * Image sources that failed to load, each tried again after a short wait and
 * all of them again when the network returns or the app is foregrounded.
 */
function useFailedCovers(resetKey: string) {
  const generation = useSyncExternalStore(coverRetrySignal.subscribe, coverRetrySignal.generation, () => 0);
  const scope = `${generation}:${resetKey}`;
  const [state, setState] = useState<{ scope: string; sources: string[] }>({ scope, sources: [] });
  const failures = useRef(new Map<string, number>());
  const timers = useRef(new Set<number>());
  // Read by `reset`, which stays stable so a wake does not redo local cover lookups.
  const currentScope = useRef(scope);
  currentScope.current = scope;
  useEffect(() => {
    const pending = timers.current;
    failures.current.clear();
    return () => {
      pending.forEach(timer => window.clearTimeout(timer));
      pending.clear();
    };
  }, [scope]);
  const markFailed = useCallback((source: string) => {
    setState(previous => ({ scope, sources: [...(previous.scope === scope ? previous.sources : []), source] }));
    const count = (failures.current.get(source) ?? 0) + 1;
    failures.current.set(source, count);
    const delay = coverRetryDelay(count);
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setState(previous => previous.scope === scope
        ? { scope, sources: previous.sources.filter(failed => failed !== source) }
        : previous);
    }, delay);
    timers.current.add(timer);
  }, [scope]);
  const reset = useCallback(() => {
    failures.current.clear();
    setState({ scope: currentScope.current, sources: [] });
  }, []);
  return { failed: state.scope === scope ? state.sources : [], markFailed, reset };
}

function CoverImage({ source, className, small, onLoad, onError }: {
  source: string; className: string; small: boolean; onLoad?: () => void; onError: () => void;
}) {
  const [loaded, setLoaded] = useState<{ source: string; ratio: number } | null>(null);
  const ready = loaded?.source === source;
  const style: CSSProperties & { "--cover-art-ratio": number } = { "--cover-art-ratio": ready ? loaded.ratio : 1 };
  return (
    <span className={`${className} cover-art-frame${ready ? " is-loaded" : ""}`}
      style={style} aria-hidden="true">
      <Headphones className="cover-art-placeholder" size={small ? 22 : 42} strokeWidth={1.25} />
      <img className="cover-art-image" src={source} alt=""
        loading={small ? "lazy" : "eager"} decoding="async" fetchPriority={small ? "auto" : "high"}
        onLoad={event => {
          const image = event.currentTarget;
          setLoaded({ source, ratio: image.naturalWidth / image.naturalHeight || 1 });
          onLoad?.();
        }} onError={onError} />
    </span>
  );
}

export function CoverArt({ book, size }: { book: Book; size: "small" | "large" }) {
  const className = size === "small" ? "cover-mark" : "large-cover";
  const key = JSON.stringify([getServerStorageKey(), book.id, book.coverArtUrl,
    book.coverArtContentType, book.localCoverPath, book.hasCoverOverride, book.source]);
  const { pending, local } = useOfflineCover(book, key);
  const { failed, markFailed, reset } = useFailedCovers(key);
  useEffect(() => {
    reset();
  }, [key, reset]);
  const primary = pending ? null : local?.current ?? (book.coverArtUrl ? mediaUrl(displayCoverPath(book.coverArtUrl)) : null);
  const fallback = local?.fallback;
  const coverSrc = primary && !failed.includes(primary) ? primary
    : fallback && !failed.includes(fallback) ? fallback : null;
  // Keep a successfully displayed remote cover when the disk lookup missed.
  const [loaded, setLoaded] = useState<string | null>(null);
  const remote = local && !local.current && coverSrc === primary ? coverSrc : null;
  const latestBook = useRef(book);
  latestBook.current = book;
  useEffect(() => {
    if (remote && loaded === remote) void cacheShelfCover(latestBook.current, remote);
  }, [key, remote, loaded]);
  if (coverSrc) {
    return (
      <CoverImage
        className={className}
        source={coverSrc}
        small={size === "small"}
        onLoad={() => setLoaded(coverSrc)}
        onError={() => markFailed(coverSrc)}
      />
    );
  }
  return (
    <span className={`${className}${pending ? " cover-art-pending" : ""}`} aria-hidden="true">
      <Headphones size={size === "small" ? 22 : 42} strokeWidth={1.25} />
    </span>
  );
}

export function LibationCoverArt({ book }: { book: LibationBook }) {
  const source = book.coverArtUrl ? mediaUrl(book.coverArtUrl) : null;
  const { failed, markFailed } = useFailedCovers(source ?? "");
  if (source && !failed.includes(source)) {
    return (
      <CoverImage
        className="audible-cover"
        source={source}
        small
        onError={() => markFailed(source)}
      />
    );
  }
  return (
    <span className="audible-cover placeholder" aria-hidden="true">
      <Headphones size={22} strokeWidth={1.25} />
    </span>
  );
}
