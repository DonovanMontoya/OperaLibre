/**
 * Resolve every queued track independently. A complete download stays wholly
 * local even before the separate availability scan finishes; a missing or
 * unreadable local file falls back only for that track.
 */
export type LocalFirstSource = { url: string; local: boolean };

export function resolveLocalFirstSources<T>(
  items: readonly T[],
  localUrl: (item: T) => Promise<string | null>,
  remoteUrl: (item: T) => string
): Promise<LocalFirstSource[]> {
  return Promise.all(items.map(async (item) => {
    try {
      const local = await localUrl(item);
      return local
        ? { url: local, local: true }
        : { url: remoteUrl(item), local: false };
    } catch {
      return { url: remoteUrl(item), local: false };
    }
  }));
}

export async function resolveLocalFirstUrls<T>(
  items: readonly T[],
  localUrl: (item: T) => Promise<string | null>,
  remoteUrl: (item: T) => string
): Promise<string[]> {
  return (await resolveLocalFirstSources(items, localUrl, remoteUrl)).map(({ url }) => url);
}

export function canPublishNativeQueue(
  sources: readonly LocalFirstSource[],
  mediaCredentialReady: boolean
) {
  return mediaCredentialReady || sources.every(({ local }) => local);
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

/**
 * A native cold start learns the playback book before IndexedDB and AVPlayer
 * recovery have reconciled its saved track. Do not let that temporary state
 * build a queue from the book's first track: a fast local download can load
 * and publish that placeholder before progress restoration reaches React.
 */
export function nativeQueueIdentityAfterRestore(
  native: boolean,
  bookId: string | null,
  trackId: string | null,
  restoredBookId: string | null,
  downloaded: boolean,
  mediaCredentialReady: boolean
) {
  if (native && (!bookId || restoredBookId !== bookId)) return null;
  return nativeQueueIdentity(bookId, trackId, downloaded, mediaCredentialReady);
}

export function nativeQueueIsReady(
  native: boolean,
  requiredIdentity: string | null,
  resolvedIdentity: string | null
) {
  return !native || (!!requiredIdentity && requiredIdentity === resolvedIdentity);
}

/** A replacement queue for the active player must carry its play intent forward. */
export function nativeQueueRefreshShouldResume(
  native: boolean,
  playing: boolean,
  requiredIdentity: string | null,
  resolvedIdentity: string | null
) {
  return native && playing && !!requiredIdentity && !!resolvedIdentity
    && requiredIdentity !== resolvedIdentity;
}

/** The resolved queue owns the active source once it is ready. */
export function nativeQueueEntryUrl(
  queue: readonly { url: string }[],
  fallbackUrl: string
) {
  return queue[0]?.url ?? fallbackUrl;
}
