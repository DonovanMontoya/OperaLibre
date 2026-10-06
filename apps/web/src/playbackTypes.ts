import type { Progress } from "./types";

export type ProgressSaveResult = { attempted: Progress; saved: Progress };
export type LibraryProgressReplay = (ProgressSaveResult & { acknowledgements: ProgressSaveResult[] }) | null;

export type PendingSeek = { trackId: string; positionSeconds: number };
export type QueuedProgressSave = {
  bookId: string;
  progress: Progress;
  isPaused: boolean;
  intentionalSeekGeneration: number;
  seekIntentId?: string;
  // Whether the seek behind that generation also went backwards far enough to
  // need the server's near-zero reset guard lifted (see
  // shouldFlagIntentionalRegression). Decided when the save is queued, from
  // the seek's own target rather than from whatever the clock reads later.
  intentionalRegression: boolean;
};
