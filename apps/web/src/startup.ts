export const NATIVE_STARTUP_SETTLE_MS = 350;

/** Downloaded media needs the persisted account session, not a media URL token. */
export function canRestoreCachedNativeSession(
  native: boolean,
  authToken: string | null,
  hasCachedUser: boolean
) {
  return native && !!authToken && hasCachedUser;
}

/** A reconnect can upgrade an offline-restored session with its media credential. */
export function shouldRefreshMediaCredential(
  native: boolean,
  authToken: string | null,
  mediaToken: string | null,
  hasConfiguredServer: boolean,
  localMode: boolean,
  demoMode: boolean
) {
  return native && !!authToken && !mediaToken && hasConfiguredServer && !localMode && !demoMode;
}

/**
 * Whether the native launch cover has enough catalogue state to choose its
 * first screen. A cached shelf is conclusive when there is no saved playback
 * session: waiting for the live server in that case only hides usable offline
 * books behind the launch cover.
 */
export function canResolveStartupNavigation(
  restoredBookId: string | null,
  preferredBookId: string | null,
  preferredBookIsPresent: boolean,
  definitive: boolean
) {
  return !!restoredBookId || preferredBookIsPresent || definitive || !preferredBookId;
}

/**
 * AVPlayer can report a paused queue transition while the native player is
 * being rebuilt. Recovery already read its durable checkpoint, so only live
 * playback is allowed to change tracks before the startup overlay leaves.
 */
export function shouldAcceptNativeTrackChange(startupReady: boolean, isPlaying: boolean) {
  return startupReady || isPlaying;
}

export type StartupDestination = { tab: "reading" | "shelf"; reveal: boolean };

/**
 * Where a library load sends the native launch cover, or null to leave it.
 *
 * Once the Reading tab is chosen, the playback restore reveals the view. A
 * later listing can still drop that book before the restore finishes (the
 * cached shelf said in progress, the live one says finished elsewhere); the
 * restore is cancelled and never reveals, so this load has to: there is
 * nothing left to restore, and the Shelf is the useful place to land.
 */
export function startupDestinationAfterLoad(
  navigationResolved: boolean,
  viewReady: boolean,
  restoredBookId: string | null,
  preferredBookId: string | null,
  preferredBookIsPresent: boolean,
  definitive: boolean
): StartupDestination | null {
  if (viewReady) return null;
  if (navigationResolved) return restoredBookId ? null : { tab: "shelf", reveal: true };
  if (!canResolveStartupNavigation(restoredBookId, preferredBookId, preferredBookIsPresent, definitive)) {
    return null;
  }
  // A restored Reading tab still needs its saved track and position; the
  // restore reveals it once they are known.
  return restoredBookId ? { tab: "reading", reveal: false } : { tab: "shelf", reveal: true };
}
