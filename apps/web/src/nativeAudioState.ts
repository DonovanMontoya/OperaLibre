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
