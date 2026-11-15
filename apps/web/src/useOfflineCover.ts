import { Capacitor } from "@capacitor/core";
import { useEffect, useRef, useState } from "react";
import { getOfflineCoverUrl, releaseOfflineMediaUrl } from "./offline";
import type { Book } from "./types";

/** Finish the disk lookup before starting a network image in the native app. */
export function useOfflineCover(book: Book, key: string) {
  const native = Capacitor.isNativePlatform();
  const latestBook = useRef(book);
  latestBook.current = book;
  const [resolved, setResolved] = useState<{
    key: string; current: string | null; fallback: string | null;
  } | null>(null);
  useEffect(() => {
    if (!native) return;
    // The key includes the artwork identity, so progress updates do not repeat
    // filesystem work or reset an image that has already loaded.
    const snapshot = latestBook.current;
    let active = true;
    const urls: string[] = [];
    const keep = (url: string | null) => {
      if (url) {
        if (active) urls.push(url);
        else releaseOfflineMediaUrl(url);
      }
      return url;
    };
    void getOfflineCoverUrl(snapshot, false).catch(() => null).then(async result => {
      const current = keep(result);
      if (!active) return;
      setResolved({ key, current, fallback: null });
      if (current) return;
      // An older downloaded cover must not delay the current server artwork.
      const fallback = keep(await getOfflineCoverUrl(snapshot, true).catch(() => null));
      if (active) setResolved({ key, current, fallback });
    });
    return () => {
      active = false;
      urls.forEach(releaseOfflineMediaUrl);
    };
  }, [key, native]);
  return {
    pending: native && resolved?.key !== key,
    local: resolved?.key === key ? resolved : null
  };
}
