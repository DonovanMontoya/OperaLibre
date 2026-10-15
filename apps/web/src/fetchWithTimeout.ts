/**
 * Fetch and read the response under one deadline. The body is read inside the
 * timeout too: a server that sends headers and then stalls would otherwise
 * leave `response.json()` pending forever.
 */
export async function fetchWithTimeout<T>(
  url: string,
  init: RequestInit | undefined,
  read: (response: Response) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  // An already-aborted signal never fires "abort" again.
  if (init?.signal?.aborted) controller.abort();
  init?.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    return await read(response);
  } finally {
    window.clearTimeout(timer);
    init?.signal?.removeEventListener("abort", abort);
  }
}
