type LocalFirstSource = { url: string; local: boolean };

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

export function playbackRestoreBookAfterAction(
  restoredBookId: string | null,
  actionBookId: string | null,
  interruptsRestore: boolean
) {
  return interruptsRestore && actionBookId ? actionBookId : restoredBookId;
}

export function nativeQueueIsReady(
  native: boolean,
  requiredIdentity: string | null,
  resolvedIdentity: string | null
) {
  return !native || (!!requiredIdentity && requiredIdentity === resolvedIdentity);
}

export function nativeQueueRefreshShouldResume(
  native: boolean,
  playing: boolean,
  requiredIdentity: string | null,
  resolvedIdentity: string | null
) {
  return native && playing && !!requiredIdentity && !!resolvedIdentity
    && requiredIdentity !== resolvedIdentity;
}

export function nativeQueueEntryUrl(
  queue: readonly { url: string }[],
  fallbackUrl: string
) {
  return queue[0]?.url ?? fallbackUrl;
}
