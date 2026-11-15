import { MAX_TTL_SECONDS } from "./limits.js";
// Experimental claim state machine for the disabled-by-default Worker.
export type Role = "producer" | "recipient";
export type Claim = { room: string; role: Role; nonce: string; expiresAt: number; previousNonce?: string };
export interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
export interface TransactionalStorage {
  transaction<T>(fn: (txn: Transaction) => Promise<T>): Promise<T>;
}

const recoveryKey = "recovery:recipient";
const recoverySecretPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
type Capability = { payload: string; signature: string };
type RecoveryMember = { digest: number[]; expiresAt: number; initialNonce: string; successor?: Capability };
function validRecoverySecret(value: unknown): value is string {
  return typeof value === "string" && recoverySecretPattern.exec(value)?.[0] === value;
}

/** Enrolled recipient authority always requires its separate secret, including
 * the interval after enrollment but before its first rotation. */
export async function recipientRecoveryAuthorized(txn: Transaction, claim: Claim, secret: string | undefined, clock: () => number): Promise<boolean> {
  if (claim.role !== "recipient") return true;
  const recovery = await txn.get<RecoveryMember>(recoveryKey);
  if (!recovery) return true;
  return validRecoverySecret(secret) && recovery.expiresAt === claim.expiresAt && claim.expiresAt > clock()
    && await authenticateOwner(secret, Uint8Array.from(recovery.digest)) && claim.expiresAt > clock();
}

/** Atomically enroll the one-time recipient and its independently generated
 * recovery secret. Exact retries resolve a lost claim response; neither the
 * original link alone nor a legacy-claimed room may enroll afterward. */
export async function claimRecipientRecovery(storage: TransactionalStorage, room: string, claim: Claim, secret: string, clock: () => number): Promise<boolean> {
  if (claim.room !== room || claim.role !== "recipient" || claim.previousNonce !== undefined || !validRecoverySecret(secret)) return false;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret))));
  return storage.transaction(async txn => {
    const now = clock();
    if (claim.expiresAt <= now || claim.expiresAt > now + MAX_TTL_SECONDS || await txn.get("revoked")) return false;
    const member = await txn.get<{ nonce: string; expiresAt: number }>("claim:recipient");
    const recovery = await txn.get<RecoveryMember>(recoveryKey);
    if (member || recovery) {
      return !!member && !!recovery && member.nonce === claim.nonce && member.expiresAt === claim.expiresAt
        && recovery.initialNonce === claim.nonce && recovery.expiresAt === claim.expiresAt
        && await authenticateOwner(secret, Uint8Array.from(recovery.digest)) && claim.expiresAt > clock();
    }
    await txn.put("claim:recipient", { nonce: claim.nonce, expiresAt: claim.expiresAt });
    await txn.put(`used:recipient:${claim.nonce}`, true);
    await txn.put(recoveryKey, { digest, expiresAt: claim.expiresAt, initialNonce: claim.nonce } satisfies RecoveryMember);
    return true;
  });
}

/** The verified current claim plus the recipient's private secret authorize a
 * single cached, same-scope successor. HTTPS delivers it only to that recipient;
 * the original shared-link key is not used as its authorization or encryption.
 * Repeated reads are idempotent until rotation, including a lost response. */
export async function recipientRecoverySuccessor(storage: TransactionalStorage, room: string, current: Claim, secret: string, mint: (next: Claim) => Promise<Capability>, clock: () => number): Promise<Capability | null> {
  if (current.room !== room || current.role !== "recipient" || !validRecoverySecret(secret)) return null;
  return storage.transaction(async txn => {
    const member = await txn.get<{ nonce: string; expiresAt: number }>("claim:recipient");
    const recovery = await txn.get<RecoveryMember>(recoveryKey);
    if (await txn.get("revoked") || !member || !recovery || member.nonce !== current.nonce || member.expiresAt !== current.expiresAt || recovery.expiresAt !== current.expiresAt || current.expiresAt <= clock() || (await txn.get<number>("rotations:recipient") ?? 0) >= 16 || !await authenticateOwner(secret, Uint8Array.from(recovery.digest))) return null;
    if (current.expiresAt <= clock()) return null;
    if (recovery.successor) return { ...recovery.successor };
    const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const successor = await mint({ room, role: "recipient", nonce, previousNonce: current.nonce, expiresAt: current.expiresAt });
    if (current.expiresAt <= clock()) return null;
    await txn.put(recoveryKey, { ...recovery, successor });
    return { ...successor };
  });
}

/** The caller must verify the signed capability before invoking this function. */
export async function claimRole(storage: TransactionalStorage, room: string, claim: Claim, now: number): Promise<boolean> {
  if (claim.room !== room || !claim.nonce || claim.previousNonce !== undefined || claim.expiresAt <= now || !["producer", "recipient"].includes(claim.role)) return false;
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
export async function rotateRole(storage: TransactionalStorage, room: string, current: Claim, next: Claim, generation: number, clock: () => number, recoverySecret?: string): Promise<boolean> {
  if (current.room !== room || next.room !== room || current.role !== next.role || !["producer", "recipient"].includes(current.role) || !current.nonce || !next.nonce || current.nonce === next.nonce || next.previousNonce !== current.nonce || current.expiresAt !== next.expiresAt || !Number.isSafeInteger(generation) || generation < 0) return false;
  return storage.transaction(async txn => {
    const now = clock();
    if (current.expiresAt <= now || await txn.get("revoked") || (await txn.get<number>("generation") ?? 0) !== generation) return false;
    const key = `claim:${current.role}`;
    const member = await txn.get<{ nonce: string; expiresAt: number }>(key);
    const rotations = await txn.get<number>(`rotations:${current.role}`) ?? 0;
    if (!member || member.nonce !== current.nonce || member.expiresAt !== current.expiresAt || rotations >= 16 || await txn.get(`used:${current.role}:${next.nonce}`)) return false;
    const recovery = current.role === "recipient" ? await txn.get<RecoveryMember>(recoveryKey) : undefined;
    if (recovery) {
      if (!validRecoverySecret(recoverySecret) || recovery.expiresAt !== current.expiresAt || !recovery.successor || JSON.parse(recovery.successor.payload).nonce !== next.nonce || !await authenticateOwner(recoverySecret, Uint8Array.from(recovery.digest)) || current.expiresAt <= clock()) return false;
      const { successor: _successor, ...retained } = recovery;
      await txn.put(recoveryKey, retained);
    }
    // Mark the current nonce too, including memberships created before rotation existed.
    await txn.put(`used:${current.role}:${current.nonce}`, true);
    await txn.put(`used:${current.role}:${next.nonce}`, true);
    await txn.put(`rotations:${current.role}`, rotations + 1);
    await txn.put(key, { nonce: next.nonce, expiresAt: next.expiresAt });
    await txn.put("queue:producer", []);
    await txn.put("queue:recipient", []);
    await txn.put("generation", generation + 1);
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
