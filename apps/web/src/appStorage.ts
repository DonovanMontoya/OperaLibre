import { readPlaybackSpeed, writePlaybackSpeed } from "./playbackSpeed";
import { readCustomSleepTimers, writeCustomSleepTimers } from "./sleepTimer";
import {
  bookVolumeStorageKey,
  readBookGains,
  readUnsyncedBookGains,
  unsyncedBookGainStorageKey,
  writeBookGains,
  writeUnsyncedBookGains
} from "./bookVolume";
import { getServerStorageKey } from "./api";
import type { Book } from "./types";

const APP_STATE_STORAGE_PREFIX = "operalibre.appState";

export function readStoredSpeed() {
  try {
    return readPlaybackSpeed(window.localStorage);
  } catch {
    return 1;
  }
}

export function writeStoredSpeed(value: number) {
  try {
    writePlaybackSpeed(window.localStorage, value);
  } catch {
    // ignore storage failures
  }
}

export function readStoredCustomSleepTimers() {
  try {
    return readCustomSleepTimers(window.localStorage);
  } catch {
    return [];
  }
}

export function writeStoredCustomSleepTimers(timers: readonly number[]) {
  try {
    writeCustomSleepTimers(window.localStorage, timers);
  } catch {
    // ignore storage failures
  }
}

export function readStoredBookGains(userId: string) {
  try {
    return readBookGains(window.localStorage, bookVolumeStorageKey(getServerStorageKey(), userId));
  } catch {
    return {};
  }
}

/**
 * The cached shelf is a snapshot of the server's answer at some earlier launch,
 * so its gains can predate an adjustment made since — and a launch served from
 * the cache is exactly when the listener has no way to set them again. Drop the
 * field so the cache is treated like a backend that never stored one and the
 * local mirror stays in charge.
 */
export function withoutCachedBookGains(books: Book[]): Book[] {
  return books.map(({ volumeGain: _volumeGain, ...book }) => book);
}

export function writeStoredBookGains(userId: string, gains: Record<string, number>) {
  try {
    writeBookGains(window.localStorage, bookVolumeStorageKey(getServerStorageKey(), userId), gains);
  } catch {
    // ignore storage failures
  }
}

/** The gain writes the server never received, kept across restarts for retry. */
export function unsyncedBookGainStore(userId: string) {
  return {
    read() {
      try {
        return readUnsyncedBookGains(window.localStorage, unsyncedBookGainStorageKey(getServerStorageKey(), userId));
      } catch {
        return {};
      }
    },
    write(entries: Record<string, number>) {
      try {
        writeUnsyncedBookGains(window.localStorage, unsyncedBookGainStorageKey(getServerStorageKey(), userId), entries);
      } catch {
        // ignore storage failures
      }
    }
  };
}

function storedStateKey(userId: string, field: "selectedBookId" | "playbackBookId") {
  return `${APP_STATE_STORAGE_PREFIX}.${getServerStorageKey()}.${userId}.${field}`;
}

export function readStoredBookId(userId: string, field: "selectedBookId" | "playbackBookId") {
  try {
    return window.localStorage.getItem(storedStateKey(userId, field));
  } catch {
    return null;
  }
}

// Merely touching window.localStorage throws when site data is blocked, and
// setItem throws under quota pressure; neither should take the app down.
export function readStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStoredValue(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore storage failures
  }
}

export function writeStoredBookId(userId: string, field: "selectedBookId" | "playbackBookId", bookId: string | null) {
  try {
    const key = storedStateKey(userId, field);
    if (bookId) {
      window.localStorage.setItem(key, bookId);
    } else {
      window.localStorage.removeItem(key);
    }
  } catch {
    // ignore storage failures
  }
}

export function nativeAudioRecoveryScope(userId: string, bookId: string) {
  return `${getServerStorageKey()}:${userId}:${bookId}`;
}
