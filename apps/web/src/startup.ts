export const NATIVE_STARTUP_SETTLE_MS = 350;

/**
 * AVPlayer can report a paused queue transition while the native player is
 * being rebuilt. Recovery already read its durable checkpoint, so only live
 * playback is allowed to change tracks before the startup overlay leaves.
 */
export function shouldAcceptNativeTrackChange(startupReady: boolean, isPlaying: boolean) {
  return startupReady || isPlaying;
}
