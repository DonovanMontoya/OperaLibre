type KeyValueStore = Pick<Storage, "getItem" | "removeItem">;

// Earlier builds could also connect to a Jellyfin server and recorded which
// kind of server the saved address was. Only OperaLibre servers are supported
// now, so the key is only read to find connections left over from then.
const SERVER_TYPE_STORAGE_KEY = "operalibre.serverType";
const JELLYFIN_DEVICE_ID_STORAGE_KEY = "operalibre.jellyfinDeviceId";

/**
 * Forget a saved connection to a server kind the app no longer supports, so
 * the app starts at the server picker instead of talking to it as if it were
 * an OperaLibre server. `connectionKeys` are the keys that describe the saved
 * connection and the server behind it. Returns whether a connection was
 * dropped; the caller still has to forget the sign-ins kept for it.
 *
 * An OperaLibre connection is left as it is. The leftover key is cleared
 * either way, so this does its work once.
 */
export function dropRemovedServerConnection(storage: KeyValueStore, connectionKeys: readonly string[]): boolean {
  const serverType = storage.getItem(SERVER_TYPE_STORAGE_KEY);
  storage.removeItem(SERVER_TYPE_STORAGE_KEY);
  storage.removeItem(JELLYFIN_DEVICE_ID_STORAGE_KEY);
  if (serverType === null || serverType === "operalibre") return false;
  for (const key of connectionKeys) storage.removeItem(key);
  return true;
}
