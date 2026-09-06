/**
 * Sleep timer durations.
 *
 * The presets cover the usual cases, but "one more chapter" is rarely exactly
 * 15 or 30 minutes, so a listener can name their own duration. Custom
 * durations are remembered on the device: someone who always sets 22 minutes
 * should find 22 waiting the next night rather than typing it again.
 */

export const SLEEP_TIMER_PRESETS: readonly number[] = [5, 15, 30, 45, 60];
export const SLEEP_TIMER_MIN_MINUTES = 1;
export const SLEEP_TIMER_MAX_MINUTES = 600;
/** Enough to keep a listener's habits without turning the menu into a list. */
export const SLEEP_TIMER_CUSTOM_LIMIT = 3;
export const SLEEP_TIMER_STORAGE_KEY = "operalibre.sleepTimer.custom";

type SleepTimerStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * Whole minutes inside the supported range, or `null` when the entry cannot be
 * used — an empty field, a word, a negative, or a night longer than ten hours.
 */
export function normalizeSleepTimerMinutes(value: unknown): number | null {
  const minutes = typeof value === "string"
    ? Number(value.trim())
    : typeof value === "number"
      ? value
      : Number.NaN;
  if (!Number.isFinite(minutes)) return null;
  const rounded = Math.round(minutes);
  if (rounded < SLEEP_TIMER_MIN_MINUTES || rounded > SLEEP_TIMER_MAX_MINUTES) return null;
  return rounded;
}

export function formatSleepTimerMinutes(minutes: number): string {
  const total = normalizeSleepTimerMinutes(minutes);
  if (total === null) return "Off";
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  if (hours === 0) return `${rest} minute${rest === 1 ? "" : "s"}`;
  const hourLabel = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? hourLabel : `${hourLabel} ${rest} min`;
}

/**
 * Newest first, so the cap drops the duration the listener has gone longest
 * without using. Presets are filtered out: they are already in the menu, and
 * re-listing one would read as a duplicate.
 */
function collectCustomSleepTimers(values: readonly unknown[]): number[] {
  const kept: number[] = [];
  for (const value of values) {
    const minutes = normalizeSleepTimerMinutes(value);
    if (minutes === null) continue;
    if (SLEEP_TIMER_PRESETS.includes(minutes)) continue;
    if (kept.includes(minutes)) continue;
    kept.push(minutes);
    if (kept.length === SLEEP_TIMER_CUSTOM_LIMIT) break;
  }
  return kept;
}

export function mergeCustomSleepTimer(existing: readonly number[], minutes: number): number[] {
  return collectCustomSleepTimers([minutes, ...existing]);
}

/** Presets and remembered customs as one ascending menu. */
export function sleepTimerChoices(custom: readonly number[]): number[] {
  return [...new Set([...SLEEP_TIMER_PRESETS, ...collectCustomSleepTimers(custom)])]
    .sort((a, b) => a - b);
}

export function readCustomSleepTimers(storage: Pick<SleepTimerStorage, "getItem">): number[] {
  const raw = storage.getItem(SLEEP_TIMER_STORAGE_KEY);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? collectCustomSleepTimers(parsed) : [];
}

export function writeCustomSleepTimers(
  storage: Pick<SleepTimerStorage, "setItem">,
  timers: readonly number[]
) {
  storage.setItem(SLEEP_TIMER_STORAGE_KEY, JSON.stringify(collectCustomSleepTimers(timers)));
}
