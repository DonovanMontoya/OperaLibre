export function nativeStartupPosition(pending: number | undefined, current: number): number {
  const position = pending ?? current;
  return Number.isFinite(position) ? Math.max(0, position) : 0;
}

/** Native playback owns a stream URL without assigning it to the web element. */
export function hasPlaybackSource(
  audio: Pick<HTMLAudioElement, "getAttribute"> | null,
  native: boolean,
  streamUrl: string
): boolean {
  return !!audio && (native ? !!streamUrl : !!audio.getAttribute("src"));
}

/** Seed a replacement control element before loading the selected native track. */
export function applyNativePlaybackSettings(
  audio: Pick<HTMLAudioElement, "defaultPlaybackRate" | "playbackRate" | "volume">,
  settings: { rate: number; volume: number }
) {
  audio.defaultPlaybackRate = settings.rate;
  audio.playbackRate = settings.rate;
  audio.volume = settings.volume;
}
