import type { Progress } from "./types";
import { progressTimestamp, shouldFlagIntentionalRegression } from "./reliability.ts";

type SeekStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export function progressSeekStorage(): SeekStorage | null {
  try { return window.localStorage; } catch { return null; }
}
export type ProgressSeekIntent = {
  id: string;
  recordedAt: number;
  targetBookPosition: number | null;
};

function key(server: string, user: string, book: string) {
  return ["operalibre.progressSeekIntent.v1", server, user, book].map(encodeURIComponent).join(".");
}

/** Keep a deliberate seek until its server response, including across a restart. */
export function recordProgressSeekIntent(
  storage: SeekStorage | null, server: string, user: string, book: string, target?: number
) {
  if (!storage) return;
  try {
    const intent: ProgressSeekIntent = {
      id: crypto.getRandomValues(new Uint32Array(4)).join("-"),
      recordedAt: Date.now(),
      targetBookPosition: target !== undefined && Number.isFinite(target) ? Math.max(0, target) : null
    };
    storage.setItem(key(server, user, book), JSON.stringify(intent));
  } catch {
    // In-memory seek generations still protect saves when storage is unavailable.
  }
}

export function readProgressSeekIntent(storage: SeekStorage | null, server: string, user: string, book: string): ProgressSeekIntent | null {
  if (!storage) return null;
  try {
    const value = JSON.parse(storage.getItem(key(server, user, book)) ?? "null") as ProgressSeekIntent | null;
    return value && typeof value.id === "string" && Number.isFinite(value.recordedAt)
      && (value.targetBookPosition === null || Number.isFinite(value.targetBookPosition)) ? value : null;
  } catch {
    return null;
  }
}

export function progressSeekOptions(intent: ProgressSeekIntent | null, progress: Progress, serverPosition?: number) {
  // A seek recorded after this checkpoint cannot authorize replaying the old position.
  const intentionalSeek = !!intent && progressTimestamp(progress.updatedAt) >= intent.recordedAt;
  return {
    intentionalSeek,
    intentionalRegression: intentionalSeek && shouldFlagIntentionalRegression(intent.targetBookPosition, serverPosition)
  };
}

export function acknowledgeProgressSeekIntent(
  storage: SeekStorage | null, server: string, user: string, book: string, id: string | undefined
) {
  if (!storage) return;
  try {
    if (id && readProgressSeekIntent(storage, server, user, book)?.id === id) {
      storage.removeItem(key(server, user, book));
    }
  } catch {
    // A failed acknowledgement leaves the pending seek available for retry.
  }
}
