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

/**
 * Gains are scoped to the server and the listener, the same way playback
 * checkpoints are. On backends that never send `volumeGain` — Jellyfin, device
 * books, servers older than this feature — the local record is the only copy
 * there is, so a shared browser would otherwise hand the next person to sign in
 * the previous listener's boosts.
 */
export function bookVolumeStorageKey(serverKey: string, userId: string) {
  return `operalibre.bookVolume.${serverKey}.${userId}`;
}

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
export function readBookGains(
  storage: Pick<VolumeStorage, "getItem">,
  key: string
): Record<string, number> {
  return parseGainMap(storage.getItem(key));
}

export function writeBookGains(
  storage: VolumeStorage,
  key: string,
  gains: Record<string, number>
) {
  const stored: Record<string, number> = {};
  for (const [bookId, value] of Object.entries(gains)) {
    const gain = normalizeBookGain(value);
    // Unity is the absence of a setting, so a reset shrinks the record rather
    // than growing it with a no-op entry for every book ever opened.
    if (gain !== BOOK_GAIN_DEFAULT) stored[bookId] = gain;
  }
  storage.setItem(key, JSON.stringify(stored));
}

/**
 * Gains cross the wire as f64 and come back through JSON, so the copy the
 * server echoes is compared with a tolerance rather than for identity — a
 * hair of drift must not read as "someone else changed this book".
 */
export function gainsMatch(a: number, b: number) {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}

type BookGainSource = { id: string; volumeGain?: number };

/**
 * Fold the server's copy of the gains into the local mirror.
 *
 * `pending` holds what this device last wrote for a book and has not yet seen
 * the server repeat back. Those books are left alone: a library payload can be
 * older than the adjustment that raced it — a `getBooks()` already in flight
 * when the slider moved, a cached shelf served during a network blip — and
 * accepting it would snap the book back to its previous level mid-chapter. A
 * book drops out of `pending` (and follows the server again) as soon as a
 * payload does carry the value this device wrote, which is the only proof that
 * the write actually landed.
 *
 * Returns null when nothing changed, so the caller can keep the current state
 * object rather than re-rendering for a no-op.
 */
export function mergeServerBookGains(
  local: Record<string, number>,
  books: readonly BookGainSource[],
  pending: Map<string, number>
): Record<string, number> | null {
  let changed = false;
  const merged = { ...local };
  for (const book of books) {
    if (typeof book.volumeGain !== "number") continue;
    const gain = normalizeBookGain(book.volumeGain);
    const written = pending.get(book.id);
    if (written !== undefined) {
      if (!gainsMatch(written, gain)) continue;
      pending.delete(book.id);
    }
    if (gain === BOOK_GAIN_DEFAULT) {
      if (!(book.id in merged)) continue;
      delete merged[book.id];
    } else {
      if (merged[book.id] === gain) continue;
      merged[book.id] = gain;
    }
    changed = true;
  }
  return changed ? merged : null;
}
