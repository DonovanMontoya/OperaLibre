export function serverStorageKey(serverType: string, serverUrl: string): string {
  const value = `${serverType}:${serverUrl.toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${serverType}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function progressTimestamp(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizedBookTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function deviceBookMatchesServer(
  device: { title: string; trackCount: number },
  server: { title: string; trackCount: number }
): boolean {
  return normalizedBookTitle(device.title) === normalizedBookTitle(server.title)
    && device.trackCount === server.trackCount;
}
