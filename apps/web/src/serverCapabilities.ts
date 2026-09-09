import type { AuthUser, ServerType } from "./types";

/** Backend support and account permissions, independent of device/browser APIs. */
export function serverCapabilities(
  server: ServerType,
  user: Pick<AuthUser, "isAdmin" | "canDownload">,
  mode: { local?: boolean; demo?: boolean } = {}
) {
  const connected = !mode.local && !mode.demo;
  const opera = server === "operalibre";
  return {
    downloads: connected && (opera || user.canDownload === true),
    bookArchive: connected && opera,
    progressSync: connected,
    completion: connected,
    readingFiles: opera,
    sentenceAlignment: connected && opera,
    // Includes the device-only ledger; detailed listening statistics still need the server.
    statistics: opera,
    sharedActivity: connected && opera,
    imports: connected && opera,
    administration: connected && opera && user.isAdmin,
    metadataEditing: connected && opera && user.isAdmin,
    uploads: connected && opera && user.isAdmin
  };
}
