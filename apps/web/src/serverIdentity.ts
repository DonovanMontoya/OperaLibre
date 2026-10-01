/**
 * The identity a server reports about itself without authentication: the
 * `serverId` of an OperaLibre health check, or the `Id` of Jellyfin's public
 * system info. OperaLibre servers released before the identity report none.
 */
export function readServerId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const value = record.serverId ?? record.Id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Gate for moving a saved sign-in to another address. Answering a health check
 * proves only that something is listening there, so the address must also
 * report the identity pinned when this server was connected; otherwise the
 * token would be handed to whoever now holds that address.
 */
export function requireSameServer(pinned: string | null, reported: string | null) {
  if (!reported) {
    throw new Error("That address could not be verified as your server. The server may need an update.");
  }
  if (!pinned) {
    throw new Error("This app could not confirm that address is your server. Reach the server at its current address once, then try again.");
  }
  if (reported !== pinned) {
    throw new Error("That address belongs to a different server. To use it, sign out and connect to it as a new server.");
  }
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...view)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(domain: string, value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${domain}\0${value}`)));
}

/**
 * What to ask an address so it can prove it holds this sign-in without being
 * sent the token: `session` names the session, and `expected` is the proof
 * only a server that issued the token can return for `nonce`. Mirrors
 * `server_proof_handle` and `server_proof` in the server's auth.rs.
 */
export async function serverProofChallenge(
  token: string,
  nonce = base64Url(crypto.getRandomValues(new Uint8Array(32)))
): Promise<{ session: string; nonce: string; expected: string }> {
  // The server keeps this digest of the token, never the token itself.
  const sessionId = await sha256("operalibre-session-id-v1", token);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(sessionId),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const proof = await crypto.subtle.sign("HMAC", key, encoder.encode(`operalibre-server-proof-v1\0${nonce}`));
  return {
    session: await sha256("operalibre-server-proof-handle-v1", sessionId),
    nonce,
    expected: base64Url(proof)
  };
}
