export type NativeAudioClockState = {
  positionSeconds: number;
  isPlaying: boolean;
};

type NativeAudioClock = Pick<HTMLAudioElement, "currentTime" | "seeking" | "dispatchEvent">;

/**
 * Mirror one native AVPlayer update into the muted HTML control clock.
 *
 * Position must be applied before play/pause is dispatched: React persists
 * progress from those media events, and the web clock may be minutes behind
 * after AVPlayer continued while WKWebView was suspended.
 */
export function reflectNativeAudioState(
  audio: NativeAudioClock,
  state: NativeAudioClockState,
  wasPlaying: boolean
) {
  const hasPosition = Number.isFinite(state.positionSeconds);
  if (hasPosition) {
    if (Math.abs(audio.currentTime - state.positionSeconds) > 0.75) {
      audio.currentTime = state.positionSeconds;
    }
  }
  if (wasPlaying !== state.isPlaying) {
    audio.dispatchEvent(new Event(state.isPlaying ? "play" : "pause"));
  }
  if (hasPosition) {
    audio.dispatchEvent(new Event("timeupdate"));
  }
  return state.isPlaying;
}

export type NativeAudioTrackChange = {
  trackId: string;
  positionSeconds: number;
  bookPositionSeconds: number;
  isPlaying: boolean;
};

/**
 * A trackChanged React declined (the startup settle window, while paused) is
 * re-offered from the next state tick for that track, because AVPlayer has
 * already moved on and nothing re-emits the event once startup is ready. The
 * tick carries the live clock, so the offer is rebuilt from it: the stored
 * position is seconds or minutes stale by then, and a pending seek to it
 * would yank native playback backwards once the new element loads.
 */
export function refreshDeclinedTrackChange(
  declined: NativeAudioTrackChange,
  tick: { positionSeconds: number; isPlaying: boolean }
): NativeAudioTrackChange {
  if (!Number.isFinite(tick.positionSeconds)) {
    return { ...declined, isPlaying: tick.isPlaying };
  }
  return {
    trackId: declined.trackId,
    positionSeconds: tick.positionSeconds,
    bookPositionSeconds: declined.bookPositionSeconds
      + (tick.positionSeconds - declined.positionSeconds),
    isPlaying: tick.isPlaying
  };
}

/** Keep a native update authoritative without fighting an in-flight web seek. */
export class NativeAudioStateSynchronizer {
  private pendingState: NativeAudioClockState | null = null;
  private readonly audio: NativeAudioClock;

  constructor(audio: NativeAudioClock) {
    this.audio = audio;
  }

  receive(state: NativeAudioClockState, wasPlaying: boolean) {
    if (this.audio.seeking) {
      // Several native ticks may arrive during a slow seek. Only the newest
      // clock/state pair matters once the media element settles.
      this.pendingState = state;
      return wasPlaying;
    }
    this.pendingState = null;
    return reflectNativeAudioState(this.audio, state, wasPlaying);
  }

  afterSeek(wasPlaying: boolean) {
    if (!this.pendingState || this.audio.seeking) return wasPlaying;
    const state = this.pendingState;
    this.pendingState = null;
    return reflectNativeAudioState(this.audio, state, wasPlaying);
  }

  clear() {
    this.pendingState = null;
  }
}

export const NATIVE_FOREGROUND_SYNC_TIMEOUT_MS = 5000;

/**
 * Prevent a foreground server refresh from beating the native player's
 * deferred foreground state. AVPlayer continues to own the audible clock
 * while WKWebView is suspended, so its first state event after a background
 * transition must be processed before an idle web session can adopt another
 * device's server checkpoint. The wait is bounded: a player that never
 * reports must not strand server adoption for the rest of the session.
 */
export class NativeForegroundSyncGate {
  private awaitingForeground = false;
  private deadlineMs: number | null = null;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(now: () => number = Date.now, timeoutMs = NATIVE_FOREGROUND_SYNC_TIMEOUT_MS) {
    this.now = now;
    this.timeoutMs = timeoutMs;
  }

  backgrounded() {
    this.awaitingForeground = true;
    this.deadlineMs = null;
  }

  /**
   * The grace period covers the WebView resume, not the background stay, which
   * may last hours. Start it only once the document is visible again.
   */
  foregrounded() {
    if (!this.awaitingForeground) return;
    this.awaitingForeground = false;
    this.deadlineMs = this.now() + this.timeoutMs;
  }

  shouldDeferServerAdoption() {
    if (this.awaitingForeground) return true;
    if (this.deadlineMs === null) return false;
    // A paused or idle AVPlayer may never emit a foreground state, and a
    // superseded seek can swallow the release its "seeked" handler owed.
    // Expire rather than deferring server adoption for the rest of the session.
    if (this.now() >= this.deadlineMs) {
      this.deadlineMs = null;
      return false;
    }
    return true;
  }

  /** Milliseconds left before the wait expires, for scheduling a retry. */
  msUntilDeadline() {
    if (!this.shouldDeferServerAdoption() || this.deadlineMs === null) return 0;
    return Math.max(0, this.deadlineMs - this.now());
  }

  nativeStateReceived() {
    const wasAwaiting = this.shouldDeferServerAdoption();
    this.awaitingForeground = false;
    this.deadlineMs = null;
    return wasAwaiting;
  }
}
