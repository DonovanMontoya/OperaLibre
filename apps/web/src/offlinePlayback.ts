/**
 * Resolve every queued track independently. A complete download stays wholly
 * local even before the separate availability scan finishes; a missing or
 * unreadable local file falls back only for that track.
 */
export function resolveLocalFirstUrls<T>(
  items: readonly T[],
  localUrl: (item: T) => Promise<string | null>,
  remoteUrl: (item: T) => string
): Promise<string[]> {
  return Promise.all(items.map(async (item) => {
    try {
      return await localUrl(item) ?? remoteUrl(item);
    } catch {
      return remoteUrl(item);
    }
  }));
}

export function nativeQueueIdentity(
  bookId: string | null,
  trackId: string | null,
  downloaded: boolean,
  mediaCredentialReady: boolean
) {
  return bookId && trackId
    ? JSON.stringify([bookId, trackId, downloaded, mediaCredentialReady])
    : null;
}

export function nativeQueueIsReady(
  native: boolean,
  requiredIdentity: string | null,
  resolvedIdentity: string | null
) {
  return !native || (!!requiredIdentity && requiredIdentity === resolvedIdentity);
}
