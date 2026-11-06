import { authenticateOwner, type TransactionalStorage } from "./claims.js";

type Reservation = { digest: number[]; expiresAt: number };
type Input = { reservationId: string; expiresAt: number };
const idPattern = /^[A-Za-z0-9_-]{43}$/;

export function validReservation(input: unknown): input is Input {
  if (!input || typeof input !== "object") return false;
  const value = input as Input;
  return typeof value.reservationId === "string" && idPattern.test(value.reservationId) && Number.isSafeInteger(value.expiresAt);
}

async function digest(id: string): Promise<number[]> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))));
}

// Room names are never recycled, including after expiration or cleanup.
export async function reserveRoom(storage: TransactionalStorage, input: Input, clock: () => number): Promise<boolean> {
  const hashed = await digest(input.reservationId);
  return storage.transaction(async txn => {
    const now = clock();
    if (input.expiresAt <= now || input.expiresAt > now + 900 || await txn.get("revoked")) return false;
    const existing = await txn.get<Reservation>("reservation");
    if (existing) return existing.expiresAt === input.expiresAt && await authenticateOwner(input.reservationId, Uint8Array.from(existing.digest));
    // Do not acquire a room already touched through the older broker interface.
    for (const key of ["preview", "claim:producer", "claim:recipient", "queue:producer", "queue:recipient"]) {
      if (await txn.get(key)) return false;
    }
    await txn.put("reservation", { digest: hashed, expiresAt: input.expiresAt });
    return true;
  });
}

export async function cleanupRoom(storage: TransactionalStorage, input: Input, clock: () => number): Promise<boolean> {
  return storage.transaction(async txn => {
    const reservation = await txn.get<Reservation>("reservation");
    if (!reservation || reservation.expiresAt !== input.expiresAt || !await authenticateOwner(input.reservationId, Uint8Array.from(reservation.digest)) || input.expiresAt <= clock()) return false;
    if (await txn.get("revoked")) return !!await txn.get("reservation:cleaned");
    await txn.put("revoked", true);
    await txn.put("reservation:cleaned", true);
    await txn.put("queue:producer", []);
    await txn.put("queue:recipient", []);
    await txn.put("preview", null);
    return true;
  });
}
