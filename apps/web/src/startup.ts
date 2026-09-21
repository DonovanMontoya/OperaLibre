export const NATIVE_STARTUP_SETTLE_MS = 350;

/** Downloaded media needs the persisted account session, not a media URL token. */
export function canRestoreCachedNativeSession(
  native: boolean,
  authToken: string | null,
  hasCachedUser: boolean
) {
  return native && !!authToken && hasCachedUser;
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
