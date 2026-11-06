// Experimental claim state machine for the disabled-by-default Worker.
export type Role = "producer" | "recipient";
export type Claim = { room: string; role: Role; nonce: string; expiresAt: number };
export interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export interface TransactionalStorage {
  transaction<T>(fn: (txn: Transaction) => Promise<T>): Promise<T>;
}

/** The caller must verify the signed capability before invoking this function. */
export async function claimRole(storage: TransactionalStorage, room: string, claim: Claim, now: number): Promise<boolean> {
  if (claim.room !== room || !claim.nonce || claim.expiresAt <= now || !["producer", "recipient"].includes(claim.role)) return false;
  return storage.transaction(async txn => {
    if (await txn.get("revoked")) return false;
    const key = `claim:${claim.role}`;
    if (await txn.get(key)) return false;
    await txn.put(key, { nonce: claim.nonce, expiresAt: claim.expiresAt });
    await txn.put(`used:${claim.role}:${claim.nonce}`, true);
    return true;
  });
}

/** Both capabilities must be verified before entering the room transaction. */
export async function rotateRole(storage: TransactionalStorage, room: string, current: Claim, next: Claim, clock: () => number): Promise<boolean> {
  if (current.room !== room || next.room !== room || current.role !== next.role || !["producer", "recipient"].includes(current.role) || !current.nonce || !next.nonce || current.nonce === next.nonce || current.expiresAt !== next.expiresAt) return false;
  return storage.transaction(async txn => {
    const now = clock();
    if (current.expiresAt <= now || await txn.get("revoked")) return false;
    const key = `claim:${current.role}`;
    const member = await txn.get<{ nonce: string; expiresAt: number }>(key);
    const rotations = await txn.get<number>(`rotations:${current.role}`) ?? 0;
    if (!member || member.nonce !== current.nonce || member.expiresAt !== current.expiresAt || rotations >= 16 || await txn.get(`used:${current.role}:${next.nonce}`)) return false;
    // Mark the current nonce too, including memberships created before rotation existed.
    await txn.put(`used:${current.role}:${current.nonce}`, true);
    await txn.put(`used:${current.role}:${next.nonce}`, true);
    await txn.put(`rotations:${current.role}`, rotations + 1);
    await txn.put(key, { nonce: next.nonce, expiresAt: next.expiresAt });
    return true;
  });
}

/** Owner authentication compares a fixed-size digest using WebCrypto. */
export async function authenticateOwner(presented: string, expectedDigest: Uint8Array): Promise<boolean> {
  if (!presented || expectedDigest.byteLength !== 32) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(presented)));
  // Verify an HMAC of a fixed message using the derived digest as the key.
  // WebCrypto performs the authentication-tag comparison.
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const actualKey = await crypto.subtle.importKey("raw", digest, algorithm, false, ["sign"]);
  const expectedKey = await crypto.subtle.importKey("raw", Uint8Array.from(expectedDigest), algorithm, false, ["verify"]);
  const message = new TextEncoder().encode("operalibre-owner-auth-v1");
  const tag = await crypto.subtle.sign("HMAC", actualKey, message);
  return crypto.subtle.verify("HMAC", expectedKey, tag, message);
}
