/**
 * An HTTP error the server actually answered with, as opposed to a request
 * that never reached it. Lives apart from `api.ts` so the Jellyfin client can
 * raise the same error without importing the whole API module (which imports
 * the Jellyfin client back).
 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
