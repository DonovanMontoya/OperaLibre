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
