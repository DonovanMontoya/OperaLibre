import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import {
  NativeAudioStateSynchronizer,
  refreshDeclinedTrackChange,
  type NativeAudioTrackChange
} from "./nativeAudioState";

type NativeAudioState = {
  positionSeconds: number;
  durationSeconds: number;
  isPlaying: boolean;
  /** The queue track the clock belongs to, once the native side reports it. */
  trackId?: string;
};

export type NativeAudioRecoveryState = {
  trackId: string;
  positionSeconds: number;
  bookPositionSeconds: number;
  durationSeconds?: number;
  updatedAt: number;
};

export type NativeAudioQueueTrack = {
  url: string;
  trackId: string;
  bookOffsetSeconds: number;
  title: string;
  artist: string;
  album: string;
  chapters: Array<{
    title: string;
    startSeconds: number;
    durationSeconds: number;
  }>;
};

type NativeAudioRecoveryIdentity = {
  scopeKey: string;
  trackId: string;
  bookOffsetSeconds: number;
  queue: () => NativeAudioQueueTrack[];
  /**
   * Read at load time rather than captured: the attachment effect runs before
   * the effect that syncs the gain, so a value captured at attach would be the
   * previous book's and the first seconds would play at the wrong level.
   */
  gain: () => number;
  /**
   * Native `stop()` disarms its sleep timer so a countdown can never outlive
   * the session that armed it — but the attachment cleanup also calls stop()
   * on every track change, so each attach re-arms the timer from the seconds
   * React still holds.
   */
  sleepTimerSeconds: () => number;
};

interface NativeAudioPlugin {
  load(options: {
    url: string;
    positionSeconds: number;
    rate: number;
    volume: number;
    gain: number;
    autoplay: boolean;
    recoveryScopeKey: string;
    recoveryTrackId: string;
    recoveryBookOffsetSeconds: number;
    queue: NativeAudioQueueTrack[];
  }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { positionSeconds: number }): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  setGain(options: { gain: number }): Promise<void>;
  setSleepTimer(options: { seconds: number }): Promise<void>;
  getSleepTimer(): Promise<{ remainingSeconds: number }>;
  setNowPlaying(options: {
    title: string;
    artist: string;
    album: string;
    artworkUrl?: string;
    chapterStartSeconds?: number;
    chapterDurationSeconds?: number;
    chapters: Array<{
      title: string;
      startSeconds: number;
      durationSeconds: number;
    }>;
  }): Promise<void>;
  getRecoveryState(options: { scopeKey: string }): Promise<Partial<NativeAudioRecoveryState>>;
  /**
   * Tears the player down. `releaseSession` (default true) also gives up the
   * audio session so other apps' audio can resume; the attach cleanup passes
   * false because a track change re-attaches moments later and a released
   * session would hand the lock screen to whatever was playing before.
   */
  stop(options?: { releaseSession?: boolean }): Promise<void>;
  addListener(eventName: "state", listener: (state: NativeAudioState) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "ended", listener: (state: Partial<NativeAudioState>) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "sleepTimerEnded", listener: () => void): Promise<PluginListenerHandle>;
  addListener(
    eventName: "trackChanged",
    listener: (event: {
      trackId: string;
      positionSeconds: number;
      bookPositionSeconds: number;
      isPlaying: boolean;
    }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: "intentionalSeek",
    listener: (event: { positionSeconds: number }) => void
  ): Promise<PluginListenerHandle>;
  addListener(eventName: "error", listener: (event: { message: string }) => void): Promise<PluginListenerHandle>;
}

const NativeAudio = registerPlugin<NativeAudioPlugin>("NativeAudio");

/**
 * `volume` stays the device level; this is the multiplier AVPlayer applies on
 * top of it, for the book currently loaded.
 */
export function setNativeAudioGain(gain: number) {
  if (!usesNativeAudioPlayer()) return Promise.resolve();
  return NativeAudio.setGain({ gain });
}

export function usesNativeAudioPlayer() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

/**
 * Gives the audio session up once the player has closed for good. The
 * attach cleanup never releases it (a track change re-attaches at once), so
 * the app calls this when a session ends with nothing to follow.
 */
export function releaseNativeAudioSession() {
  if (!usesNativeAudioPlayer()) return Promise.resolve();
  return NativeAudio.stop({ releaseSession: true }).catch(() => undefined);
}

export function updateNativeAudioNowPlaying(options: {
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  chapterStartSeconds?: number;
  chapterDurationSeconds?: number;
  chapters: Array<{
    title: string;
    startSeconds: number;
    durationSeconds: number;
  }>;
}) {
  if (!usesNativeAudioPlayer()) return Promise.resolve();
  return NativeAudio.setNowPlaying(options);
}

export function playNativeAudio() {
  return NativeAudio.play();
}

export function pauseNativeAudio() {
  return NativeAudio.pause();
}

export function setNativeAudioSleepTimer(seconds: number) {
  if (!usesNativeAudioPlayer()) return Promise.resolve();
  return NativeAudio.setSleepTimer({ seconds: Math.max(0, seconds) });
}

/**
 * AVPlayer's countdown only advances during playback, while the web timer is
 * wall-clock, so after any pause the app did not observe (lock screen,
 * interruption) the native value is the authoritative one.
 */
export function getNativeAudioSleepTimer(): Promise<number> {
  if (!usesNativeAudioPlayer()) return Promise.resolve(0);
  return NativeAudio.getSleepTimer().then((result) => Math.max(0, result.remainingSeconds));
}

export function seekNativeAudio(positionSeconds: number) {
  return NativeAudio.seek({ positionSeconds });
}

export async function getNativeAudioRecovery(scopeKey: string): Promise<NativeAudioRecoveryState | null> {
  if (!usesNativeAudioPlayer()) return null;
  const state = await NativeAudio.getRecoveryState({ scopeKey });
  return typeof state.trackId === "string"
    && Number.isFinite(state.positionSeconds)
    && Number.isFinite(state.bookPositionSeconds)
    && Number.isFinite(state.updatedAt)
    ? state as NativeAudioRecoveryState
    : null;
}

/**
 * Keep the existing HTML media element as OperaLibre's control/UI clock, but
 * make AVPlayer the only audible engine on iOS. This preserves the mature web
 * player behavior while AVFoundation supplies its voice-specific time/pitch
 * processing for accelerated playback.
 */
export function attachNativeAudioPlayer(
  audio: HTMLAudioElement,
  onError: (message: string) => void,
  onFallback: () => void,
  recovery: NativeAudioRecoveryIdentity,
  /** Returns false when React declined the change and still owns this track. */
  onTrackChanged: (
    trackId: string,
    positionSeconds: number,
    bookPositionSeconds: number,
    isPlaying: boolean
  ) => boolean | void,
  onIntentionalSeek: () => void,
  onSleepTimerEnded: () => void
) {
  if (!usesNativeAudioPlayer()) return () => undefined;

  let disposed = false;
  let endedFromNative = false;
  let nativeIsPlaying = false;
  let fellBack = false;
  // The queue track AVPlayer is on, as far as this attachment knows. After an
  // accepted trackChanged, React remounts the media element and re-attaches
  // for the new track; until then this element still represents the previous
  // file, and a trailing `state` tick from the new one must not seek it.
  let activeNativeTrackId = recovery.trackId;
  // The last trackChanged React declined. Swift has already moved its
  // recovery track to that item and stamps every state payload with it, so
  // until React accepts the change every tick would be dropped below and the
  // UI clock would freeze while native audio plays on. Nothing re-emits
  // trackChanged when startup becomes ready; the tick re-offers it instead.
  let declinedTrackChange: NativeAudioTrackChange | null = null;
  const listenerHandles: PluginListenerHandle[] = [];
  const nativeStateSynchronizer = new NativeAudioStateSynchronizer(audio);

  const offerTrackChange = (change: NativeAudioTrackChange) => {
    const accepted = onTrackChanged(
      change.trackId,
      change.positionSeconds,
      change.bookPositionSeconds,
      change.isPlaying
    ) !== false;
    if (accepted) {
      activeNativeTrackId = change.trackId;
      declinedTrackChange = null;
    } else {
      declinedTrackChange = change;
    }
    return accepted;
  };

  const failOverToWebAudio = (message: string) => {
    if (disposed || fellBack) return;
    fellBack = true;
    nativeStateSynchronizer.clear();
    const shouldResume = nativeIsPlaying;
    audio.muted = false;
    onError(message);
    onFallback();
    void NativeAudio.stop().catch(() => undefined);
    if (shouldResume) {
      void audio.play().catch(() => undefined);
    }
  };

  const safely = (operation: Promise<void>) => {
    void operation.catch((error) => {
      const message = error instanceof Error ? error.message : "Native audio playback failed.";
      failOverToWebAudio(message);
    });
  };

  const load = () => {
    const url = audio.currentSrc;
    if (!url) return;
    nativeStateSynchronizer.clear();
    endedFromNative = false;
    const configuredQueue = recovery.queue();
    const queue = configuredQueue.length > 0
      ? configuredQueue.map((track, index) => index === 0 ? { ...track, url } : track)
      : [{
          url,
          trackId: recovery.trackId,
          bookOffsetSeconds: recovery.bookOffsetSeconds,
          title: "OperaLibre",
          artist: "Audiobook",
          album: "",
          chapters: []
        }];
    safely(NativeAudio.load({
      url,
      positionSeconds: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      rate: audio.playbackRate,
      volume: audio.volume,
      gain: recovery.gain(),
      autoplay: nativeIsPlaying,
      recoveryScopeKey: recovery.scopeKey,
      recoveryTrackId: recovery.trackId,
      recoveryBookOffsetSeconds: recovery.bookOffsetSeconds,
      queue
    }));
  };
  const rateChange = () => safely(NativeAudio.setRate({ rate: audio.playbackRate }));
  const volumeChange = () => safely(NativeAudio.setVolume({ volume: audio.volume }));
  const emptied = () => {
    nativeStateSynchronizer.clear();
    safely(NativeAudio.stop({ releaseSession: false }));
  };
  const seeked = () => {
    nativeIsPlaying = nativeStateSynchronizer.afterSeek(nativeIsPlaying);
  };

  audio.muted = true;
  // Unconditional: passing 0 also disarms a timer left behind by a WebView
  // reload, where the detach cleanup (and its stop()) never ran.
  void NativeAudio.setSleepTimer({
    seconds: Math.max(0, recovery.sleepTimerSeconds())
  }).catch(() => undefined);
  audio.addEventListener("loadedmetadata", load);
  audio.addEventListener("ratechange", rateChange);
  audio.addEventListener("volumechange", volumeChange);
  audio.addEventListener("emptied", emptied);
  audio.addEventListener("seeked", seeked);
  audio.addEventListener("operalibre-native-queue-change", load);

  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) load();

  void NativeAudio.addListener("state", (state) => {
    if (disposed || fellBack) return;
    // A clock for another queue track belongs to the element React is about
    // to mount for it, not to this one. Prefer the payload's own track id;
    // fall back to the last accepted trackChanged when the native side does
    // not report one.
    if (typeof state.trackId === "string" && state.trackId) {
      if (state.trackId !== recovery.trackId) {
        // Re-offer a declined change with this tick's live clock. Whether or
        // not React takes it now, the tick itself is still dropped: on
        // acceptance React remounts the element for that track, and seeking
        // this one to the new track's clock would let the synthetic
        // timeupdate persist the old track at the wrong position.
        if (declinedTrackChange?.trackId === state.trackId) {
          offerTrackChange(refreshDeclinedTrackChange(declinedTrackChange, state));
        }
        return;
      }
    } else if (activeNativeTrackId !== recovery.trackId) {
      return;
    }
    // AVPlayer remains the only running decoder. Reflect its state through
    // synthetic media events so React's existing UI stays current without
    // starting or stopping the muted HTML decoder during app transitions.
    // AVPlayer is authoritative. Apply its clock before a synthetic pause can
    // make React persist the stale pre-background HTML position.
    nativeIsPlaying = nativeStateSynchronizer.receive(state, nativeIsPlaying);
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  });

  void NativeAudio.addListener("ended", (state) => {
    if (disposed || fellBack || endedFromNative) return;
    endedFromNative = true;
    nativeStateSynchronizer.clear();
    nativeIsPlaying = false;
    if (Number.isFinite(state.positionSeconds)) {
      const finalPosition = Number.isFinite(audio.duration)
        ? Math.min(audio.duration, Math.max(0, state.positionSeconds!))
        : Math.max(0, state.positionSeconds!);
      audio.currentTime = finalPosition;
      audio.dispatchEvent(new Event("timeupdate"));
    }
    audio.pause();
    audio.dispatchEvent(new Event("ended"));
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  });

  void NativeAudio.addListener("trackChanged", (event) => {
    if (disposed || fellBack || !event.trackId || event.trackId === recovery.trackId) return;
    offerTrackChange({
      trackId: event.trackId,
      positionSeconds: event.positionSeconds,
      bookPositionSeconds: event.bookPositionSeconds,
      isPlaying: event.isPlaying
    });
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  });

  void NativeAudio.addListener("intentionalSeek", (event) => {
    if (disposed || fellBack || !Number.isFinite(event.positionSeconds)) return;
    audio.currentTime = Math.max(0, event.positionSeconds);
    onIntentionalSeek();
    audio.dispatchEvent(new Event("timeupdate"));
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  });

  void NativeAudio.addListener("sleepTimerEnded", () => {
    if (disposed || fellBack) return;
    nativeIsPlaying = false;
    // The follow-up state event compares against the flag just cleared and
    // will not dispatch the synthetic pause itself, so React only learns the
    // transport stopped from this event.
    audio.dispatchEvent(new Event("pause"));
    onSleepTimerEnded();
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  });

  void NativeAudio.addListener("error", ({ message }) => {
    failOverToWebAudio(message || "Native audio playback failed.");
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  });

  return () => {
    disposed = true;
    audio.removeEventListener("loadedmetadata", load);
    audio.removeEventListener("ratechange", rateChange);
    audio.removeEventListener("volumechange", volumeChange);
    audio.removeEventListener("emptied", emptied);
    audio.removeEventListener("seeked", seeked);
    audio.removeEventListener("operalibre-native-queue-change", load);
    nativeStateSynchronizer.clear();
    if (!fellBack) audio.pause();
    audio.muted = false;
    for (const handle of listenerHandles) void handle.remove();
    // Keep the audio session: this cleanup runs on every track change, and
    // the next attach is moments away. App.tsx releases it when the player
    // closes with nothing to follow.
    void NativeAudio.stop({ releaseSession: false }).catch(() => undefined);
  };
}
