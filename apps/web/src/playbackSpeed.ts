export const PLAYBACK_SPEED_MIN = 0.75;
export const PLAYBACK_SPEED_MAX = 2;
export const PLAYBACK_SPEED_STEP = 0.05;
export const PLAYBACK_SPEED_DEFAULT = 1;
export const PLAYBACK_SPEED_PRESETS = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
export const PLAYBACK_SPEED_VALUES = Array.from(
  { length: Math.round((PLAYBACK_SPEED_MAX - PLAYBACK_SPEED_MIN) / PLAYBACK_SPEED_STEP) + 1 },
  (_, index) => Number((PLAYBACK_SPEED_MIN + index * PLAYBACK_SPEED_STEP).toFixed(2))
);
export const PLAYBACK_SPEED_STORAGE_KEY = "operalibre.playbackSpeed";

type PlaybackSpeedStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function normalizePlaybackSpeed(value: number) {
  if (!Number.isFinite(value)) return PLAYBACK_SPEED_DEFAULT;

  const clamped = Math.min(PLAYBACK_SPEED_MAX, Math.max(PLAYBACK_SPEED_MIN, value));
  const stepsFromMinimum = Math.round((clamped - PLAYBACK_SPEED_MIN) / PLAYBACK_SPEED_STEP);
  return Number((PLAYBACK_SPEED_MIN + stepsFromMinimum * PLAYBACK_SPEED_STEP).toFixed(2));
}

export function stepPlaybackSpeed(value: number, direction: -1 | 1) {
  return normalizePlaybackSpeed(value + direction * PLAYBACK_SPEED_STEP);
}

export function formatPlaybackSpeed(value: number) {
  return normalizePlaybackSpeed(value).toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export function readPlaybackSpeed(storage: Pick<PlaybackSpeedStorage, "getItem">) {
  const stored = Number(storage.getItem(PLAYBACK_SPEED_STORAGE_KEY));
  if (!Number.isFinite(stored) || stored < PLAYBACK_SPEED_MIN || stored > PLAYBACK_SPEED_MAX) {
    return PLAYBACK_SPEED_DEFAULT;
  }
  return normalizePlaybackSpeed(stored);
}

export function writePlaybackSpeed(
  storage: Pick<PlaybackSpeedStorage, "setItem">,
  value: number
) {
  storage.setItem(PLAYBACK_SPEED_STORAGE_KEY, String(normalizePlaybackSpeed(value)));
}
