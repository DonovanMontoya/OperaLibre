/**
 * An HTTP error the server actually answered with, as opposed to a request
 * that never reached it. Lives apart from `api.ts` so the Jellyfin client can
 * raise the same error without importing the whole API module (which imports
 * the Jellyfin client back).
 */
export class ApiError extends Error {
  status: number;
  /**
   * Seconds the server asked the client to wait before asking again, from a
   * `Retry-After` header. Only the server sets it: a 503 from a proxy whose
   * upstream is down carries none, so its presence tells "the server is up
   * but not ready" apart from "nothing answered".
   */
  retryAfterSeconds?: number;
  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
