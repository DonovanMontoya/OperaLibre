/**
 * Per-book playback gain.
 *
 * Audiobooks are mastered at wildly different levels, so a device volume that
 * suits one narrator leaves the next one inaudible. This is the listener's own
 * correction for a single book, expressed in decibels because that is the unit
 * loudness actually moves in, and stored as a linear multiplier because that is
 * what both audio engines want.
 */

export const BOOK_GAIN_DB_MIN = -6;
export const BOOK_GAIN_DB_MAX = 24;
export const BOOK_GAIN_DB_STEP = 1;
export const BOOK_GAIN_DB_DEFAULT = 0;
export const BOOK_GAIN_DB_PRESETS = [0, 6, 12, 18, 24] as const;

/** Matches the server's clamp, which is the authority for stored values. */
export const BOOK_GAIN_MIN = 0.5;
export const BOOK_GAIN_MAX = 16;
export const BOOK_GAIN_DEFAULT = 1;

export const BOOK_VOLUME_STORAGE_KEY = "operalibre.bookVolume";

type VolumeStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function dbToGain(db: number) {
  return 10 ** (db / 20);
}

export function gainToDb(gain: number) {
  if (!Number.isFinite(gain) || gain <= 0) return BOOK_GAIN_DB_DEFAULT;
  return 20 * Math.log10(gain);
}

export function normalizeBookGainDb(db: number) {
  if (!Number.isFinite(db)) return BOOK_GAIN_DB_DEFAULT;
  const clamped = Math.min(BOOK_GAIN_DB_MAX, Math.max(BOOK_GAIN_DB_MIN, db));
  return Math.round(clamped / BOOK_GAIN_DB_STEP) * BOOK_GAIN_DB_STEP;
}

/** Linear gains cross the wire and the storage layer; keep them in range. */
export function normalizeBookGain(gain: number) {
  if (!Number.isFinite(gain) || gain <= 0) return BOOK_GAIN_DEFAULT;
  return Math.min(BOOK_GAIN_MAX, Math.max(BOOK_GAIN_MIN, gain));
}

/** The gain a snapped decibel slider position actually asks the engine for. */
export function bookGainFromDb(db: number) {
  const normalized = normalizeBookGainDb(db);
  return normalized === BOOK_GAIN_DB_DEFAULT
    ? BOOK_GAIN_DEFAULT
    : normalizeBookGain(dbToGain(normalized));
}

export function bookGainToDb(gain: number) {
  return normalizeBookGainDb(gainToDb(normalizeBookGain(gain)));
}

export function isBoosted(gain: number) {
  return normalizeBookGain(gain) > BOOK_GAIN_DEFAULT;
}

export function formatBookGainDb(db: number) {
  const normalized = normalizeBookGainDb(db);
  if (normalized === 0) return "Original";
  // A minus sign rather than a hyphen: the value sits next to "+6 dB" in the
  // same column and the hyphen reads as a bullet at small sizes.
  return `${normalized > 0 ? "+" : "−"}${Math.abs(normalized)} dB`;
}

function parseGainMap(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: Record<string, number> = {};
    for (const [bookId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const gain = normalizeBookGain(value);
      if (gain !== BOOK_GAIN_DEFAULT) entries[bookId] = gain;
    }
    return entries;
  } catch {
    return {};
  }
}

/**
 * The local mirror of the server's copy. It is what device-only books, Jellyfin
 * servers, and an offline launch read, and what keeps the boost applied on the
 * very first frame instead of after the library round-trip.
 */
export function readBookGains(storage: Pick<VolumeStorage, "getItem">): Record<string, number> {
  return parseGainMap(storage.getItem(BOOK_VOLUME_STORAGE_KEY));
}

export function writeBookGains(
  storage: VolumeStorage,
  gains: Record<string, number>
) {
  const stored: Record<string, number> = {};
  for (const [bookId, value] of Object.entries(gains)) {
    const gain = normalizeBookGain(value);
    // Unity is the absence of a setting, so a reset shrinks the record rather
    // than growing it with a no-op entry for every book ever opened.
    if (gain !== BOOK_GAIN_DEFAULT) stored[bookId] = gain;
  }
  storage.setItem(BOOK_VOLUME_STORAGE_KEY, JSON.stringify(stored));
}
