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

/**
 * Writes the server never received, waiting to be re-sent. Scoped like the
 * mirror above, and kept separately from it: the mirror is "what this device
 * plays at", this is "what the server still owes us".
 */
export function unsyncedBookGainStorageKey(serverKey: string, userId: string) {
  return `operalibre.bookVolumeUnsynced.${serverKey}.${userId}`;
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

function parseGainMap(raw: string | null, keepDefault = false): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: Record<string, number> = {};
    for (const [bookId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const gain = normalizeBookGain(value);
      if (keepDefault || gain !== BOOK_GAIN_DEFAULT) entries[bookId] = gain;
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
 * Unlike the mirror, the unsynced record keeps unity entries: a book reset to
 * Original while the server was unreachable is still a write the server owes
 * an acknowledgement for, and dropping it would leave the old boost stored.
 */
export function readUnsyncedBookGains(
  storage: Pick<VolumeStorage, "getItem">,
  key: string
): Record<string, number> {
  return parseGainMap(storage.getItem(key), true);
}

export function writeUnsyncedBookGains(
  storage: VolumeStorage,
  key: string,
  entries: Record<string, number>
) {
  const stored: Record<string, number> = {};
  for (const [bookId, value] of Object.entries(entries)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      stored[bookId] = normalizeBookGain(value);
    }
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

/**
 * Serialize the server writes for a book and coalesce the ones a slider drag
 * produces.
 *
 * The gain slider reports every step of a drag, so a single sweep asks for
 * dozens of writes. Firing them concurrently lets them land out of order, and
 * whichever the server happens to process last becomes the stored level — not
 * necessarily where the listener let go. Only one write per book is in flight
 * here; the rest collapse to the latest value, which is sent once the previous
 * one settles. The last value asked for is therefore the last value written.
 *
 * `pending` is the guard the library merge consults, and only the final write
 * for a book decides its fate. A write the server accepted keeps the book
 * guarded until a payload echoes it back — that echo is the whole point. A
 * write a backend had nowhere to store releases the guard: nothing will ever
 * echo it, and leaving the entry behind would shut the book out of
 * reconciliation for the rest of the session.
 *
 * A write that *failed* — the server was unreachable — is different: the
 * listener's choice is right and the server is behind, so the guard is held
 * and the value is kept for `retry()`, which the caller invokes once the
 * server answers again. Releasing the guard here is what used to let any
 * later payload snap an offline adjustment back. With an `unsynced` store the
 * kept writes also survive a restart, restored entries re-arming the guard so
 * a payload served before the retry lands cannot undo the change either.
 *
 * The store is written when the adjustment is *made*, not when its request
 * fails: an offline write made just before the app is closed or backgrounded
 * may never reject before the WebView is suspended, and a rejection-only
 * record would leave the restart with a mirror value no guard protects. The
 * entry is erased once the server settles the write.
 */
type UnsyncedGainStore = {
  read(): Record<string, number>;
  write(entries: Record<string, number>): void;
};

export function createBookGainSync(
  write: (bookId: string, gain: number) => Promise<boolean>,
  pending: Map<string, number>,
  unsynced?: UnsyncedGainStore
) {
  const inFlight = new Set<string>();
  const queued = new Map<string, number>();
  const owed = new Map<string, number>(Object.entries(unsynced?.read() ?? {}));
  for (const [bookId, gain] of owed) pending.set(bookId, gain);

  function persistOwed() {
    unsynced?.write(Object.fromEntries(owed));
  }

  function settle(bookId: string, gain: number, outcome: "stored" | "unconfirmable" | "failed") {
    inFlight.delete(bookId);
    const next = queued.get(bookId);
    if (next !== undefined) {
      queued.delete(bookId);
      send(bookId, next);
      return;
    }
    // Only reached by the last write for this book, so `gain` is the value
    // the listener settled on.
    if (outcome === "failed") {
      // Still owed: write() already recorded this value, so a restart will
      // find it even though the rejection ran this time.
      return;
    }
    if (owed.delete(bookId)) persistOwed();
    if (outcome === "unconfirmable" && pending.get(bookId) === gain) pending.delete(bookId);
  }

  function send(bookId: string, gain: number) {
    inFlight.add(bookId);
    void write(bookId, gain).then(
      (stored) => settle(bookId, gain, stored ? "stored" : "unconfirmable"),
      () => settle(bookId, gain, "failed")
    );
  }

  return {
    write(bookId: string, gain: number) {
      pending.set(bookId, gain);
      // Recorded before the request goes out — see the note on the type
      // above. A newer value simply replaces the owed one.
      owed.set(bookId, gain);
      persistOwed();
      if (inFlight.has(bookId)) {
        queued.set(bookId, gain);
        return;
      }
      send(bookId, gain);
    },
    /**
     * Re-send writes the server never received. Harmless when there are none,
     * so callers fire it on every fresh server payload rather than trying to
     * detect the exact moment connectivity returned.
     */
    retry() {
      for (const [bookId, gain] of [...owed]) {
        if (inFlight.has(bookId) || queued.has(bookId)) continue;
        send(bookId, gain);
      }
    }
  };
}
