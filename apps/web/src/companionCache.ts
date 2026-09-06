/**
 * Online reads revalidate the HTTP cache; a deliberately downloaded book uses
 * its durable companion first so opening its EPUB does not wait for the server.
 */
export async function revalidatedCompanion(
  url: string,
  readCached: () => Promise<ArrayBuffer | null>,
  save: (data: ArrayBuffer) => Promise<void>,
  signal?: AbortSignal,
  preferCached = false
): Promise<ArrayBuffer> {
  signal?.throwIfAborted();
  if (preferCached) {
    const cached = await readCached().catch(() => null);
    signal?.throwIfAborted();
    if (cached) return cached;
  }
  let response: Response;
  try {
    response = await fetch(url, { credentials: "include", cache: "no-cache", signal });
  } catch (error) {
    signal?.throwIfAborted();
    const cached = await readCached().catch(() => null);
    signal?.throwIfAborted();
    if (cached) return cached;
    throw error;
  }
  // Do not conceal revoked access or a removed document behind a cached copy.
  if (!response.ok) throw new Error(`Companion request failed with ${response.status}`);
  const data = await response.arrayBuffer();
  signal?.throwIfAborted();
  await save(data).catch(() => undefined);
  signal?.throwIfAborted();
  return data;
}

/** Optional media may fail at fetch, body reading, or storage; cancellation is not optional. */
export async function optionalCompanionDownload(operation: () => Promise<void>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  try {
    await operation();
  } catch {
    signal?.throwIfAborted();
  }
  signal?.throwIfAborted();
}
