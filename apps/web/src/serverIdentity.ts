/**
 * The identity a server reports about itself without authentication: the
 * `serverId` of its health check. Servers released before the identity report
 * none.
 */
export function readServerId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = (body as Record<string, unknown>).serverId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Refuse an address that says it is some other server than the one this app
 * is connected to, so two libraries' downloads and progress never mix. The
 * identity is public and easily copied, so a match proves nothing and is not
 * what protects a sign-in: each address only ever gets its own. Servers that
 * report no identity cannot be compared and are let through.
 */
export function refuseDifferentServer(pinned: string | null, reported: string | null) {
  if (pinned && reported && reported !== pinned) {
    throw new Error("That address belongs to a different server. To use it, sign out and connect to it as a new server.");
  }
}
