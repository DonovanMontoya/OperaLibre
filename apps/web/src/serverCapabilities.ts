import type { AuthUser } from "./types";

/** Server features and account permissions, independent of device/browser APIs. */
export function serverCapabilities(
  user: Pick<AuthUser, "isAdmin">,
  mode: { local?: boolean; demo?: boolean } = {}
) {
  const connected = !mode.local && !mode.demo;
  return {
    downloads: connected,
    progressSync: connected,
    completion: connected,
    sentenceAlignment: connected || mode.demo === true,
    sharedActivity: connected,
    imports: connected,
    administration: connected && user.isAdmin,
    metadataEditing: connected && user.isAdmin,
    uploads: connected && user.isAdmin
  };
}

export type ServerCapabilities = ReturnType<typeof serverCapabilities>;
