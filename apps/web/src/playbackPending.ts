export type PendingPlayRequest = {
  bookId: string | null;
  cancelGeneration: number;
};

/** A delayed play result may only change the pending request that created it. */
export function ownsPendingPlay(
  request: PendingPlayRequest,
  cancelGeneration: number,
  pendingBookId: string | null
) {
  return request.cancelGeneration === cancelGeneration
    && request.bookId === pendingBookId;
}

/** Media events from an old book must not finish a newer book's request. */
export function playbackEventOwnsPendingPlay(
  pending: boolean,
  pendingBookId: string | null,
  playbackBookId: string | null
) {
  return !pending || pendingBookId === playbackBookId;
}
