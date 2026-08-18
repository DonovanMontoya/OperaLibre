import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { NativeAudioStateSynchronizer } from "./nativeAudioState";

type NativeAudioState = {
  positionSeconds: number;
  durationSeconds: number;
  isPlaying: boolean;
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
  stop(): Promise<void>;
  addListener(eventName: "state", listener: (state: NativeAudioState) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "ended", listener: (state: Partial<NativeAudioState>) => void): Promise<PluginListenerHandle>;
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
 * The per-book boost, kept here rather than threaded through every caller: the
 * plugin is a singleton and `load` has to restate the gain on every track, so
 * one module-level value is the whole story. `volume` stays the device level;
 * this is the multiplier AVPlayer applies on top of it.
 */
let boostGain = 1;

export function setNativeAudioGain(gain: number) {
  boostGain = gain;
  if (!usesNativeAudioPlayer()) return Promise.resolve();
  return NativeAudio.setGain({ gain });
}

export function usesNativeAudioPlayer() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
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
  onTrackChanged: (
    trackId: string,
    positionSeconds: number,
    bookPositionSeconds: number,
    isPlaying: boolean
  ) => void,
  onIntentionalSeek: () => void
) {
  if (!usesNativeAudioPlayer()) return () => undefined;

  let disposed = false;
  let endedFromNative = false;
  let nativeIsPlaying = false;
  let fellBack = false;
  const listenerHandles: PluginListenerHandle[] = [];
  const nativeStateSynchronizer = new NativeAudioStateSynchronizer(audio);

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
      gain: boostGain,
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
    safely(NativeAudio.stop());
  };
  const seeked = () => {
    nativeIsPlaying = nativeStateSynchronizer.afterSeek(nativeIsPlaying);
  };

  audio.muted = true;
  audio.addEventListener("loadedmetadata", load);
  audio.addEventListener("ratechange", rateChange);
  audio.addEventListener("volumechange", volumeChange);
  audio.addEventListener("emptied", emptied);
  audio.addEventListener("seeked", seeked);
  audio.addEventListener("operalibre-native-queue-change", load);

  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) load();

  void NativeAudio.addListener("state", (state) => {
    if (disposed || fellBack) return;
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
    onTrackChanged(
      event.trackId,
      event.positionSeconds,
      event.bookPositionSeconds,
      event.isPlaying
    );
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
    void NativeAudio.stop().catch(() => undefined);
  };
}
