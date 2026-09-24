import type { Progress } from "./types";

export type PendingSeek = { trackId: string; positionSeconds: number };
export type QueuedProgressSave = {
  bookId: string;
  progress: Progress;
  isPaused: boolean;
  intentionalSeekGeneration: number;
  // Whether the seek behind that generation also went backwards far enough to
  // need the server's near-zero reset guard lifted (see
  // shouldFlagIntentionalRegression). Decided when the save is queued, from
  // the seek's own target rather than from whatever the clock reads later.
  intentionalRegression: boolean;
};
