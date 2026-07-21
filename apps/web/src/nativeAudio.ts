import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

type NativeAudioState = {
  positionSeconds: number;
  durationSeconds: number;
  isPlaying: boolean;
};

interface NativeAudioPlugin {
  load(options: {
    url: string;
    positionSeconds: number;
    rate: number;
    volume: number;
    autoplay: boolean;
  }): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(options: { positionSeconds: number }): Promise<void>;
  setRate(options: { rate: number }): Promise<void>;
  setVolume(options: { volume: number }): Promise<void>;
  setNowPlaying(options: {
    title: string;
    artist: string;
    album: string;
    artworkUrl?: string;
  }): Promise<void>;
  stop(): Promise<void>;
  addListener(eventName: "state", listener: (state: NativeAudioState) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "ended", listener: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "error", listener: (event: { message: string }) => void): Promise<PluginListenerHandle>;
}

const NativeAudio = registerPlugin<NativeAudioPlugin>("NativeAudio");

export function usesNativeAudioPlayer() {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "ios";
}

export function updateNativeAudioNowPlaying(options: {
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
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

/**
 * Keep the existing HTML media element as OperaLibre's control/UI clock, but
 * make AVPlayer the only audible engine on iOS. This preserves the mature web
 * player behavior while AVFoundation supplies its voice-specific time/pitch
 * processing for accelerated playback.
 */
export function attachNativeAudioPlayer(
  audio: HTMLAudioElement,
  onError: (message: string) => void
) {
  if (!usesNativeAudioPlayer()) return () => undefined;

  let disposed = false;
  let endedFromNative = false;
  let nativeIsPlaying = false;
  const listenerHandles: PluginListenerHandle[] = [];

  const failOverToWebAudio = (message: string) => {
    if (disposed) return;
    audio.muted = false;
    onError(message);
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
    safely(NativeAudio.load({
      url,
      positionSeconds: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      rate: audio.playbackRate,
      volume: audio.volume,
      autoplay: false
    }));
  };
  const rateChange = () => safely(NativeAudio.setRate({ rate: audio.playbackRate }));
  const volumeChange = () => safely(NativeAudio.setVolume({ volume: audio.volume }));
  const emptied = () => safely(NativeAudio.stop());

  audio.muted = true;
  audio.addEventListener("loadedmetadata", load);
  audio.addEventListener("ratechange", rateChange);
  audio.addEventListener("volumechange", volumeChange);
  audio.addEventListener("emptied", emptied);

  if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) load();

  void NativeAudio.addListener("state", (state) => {
    if (disposed) return;
    // AVPlayer remains the only running decoder. Reflect its state through
    // synthetic media events so React's existing UI stays current without
    // starting or stopping the muted HTML decoder during app transitions.
    if (nativeIsPlaying !== state.isPlaying) {
      nativeIsPlaying = state.isPlaying;
      audio.dispatchEvent(new Event(state.isPlaying ? "play" : "pause"));
    }
    if (audio.seeking || !Number.isFinite(state.positionSeconds)) return;
    // AVPlayer is authoritative. Correct meaningful drift without continually
    // seeking either decoder for harmless sub-second clock differences.
    if (Math.abs(audio.currentTime - state.positionSeconds) > 0.75) {
      audio.currentTime = state.positionSeconds;
    }
    audio.dispatchEvent(new Event("timeupdate"));
  }).then((handle) => {
    if (disposed) void handle.remove();
    else listenerHandles.push(handle);
  });

  void NativeAudio.addListener("ended", () => {
    if (disposed || endedFromNative) return;
    endedFromNative = true;
    audio.pause();
    audio.dispatchEvent(new Event("ended"));
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
    audio.pause();
    audio.muted = false;
    for (const handle of listenerHandles) void handle.remove();
    void NativeAudio.stop().catch(() => undefined);
  };
}
