/** Unrouted prototype. The production Worker remains disabled pending review. */
import { authenticateOwner, claimRole, type Claim, type TransactionalStorage } from "./claims.js";

type Namespace = { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
type Environment = { OWNER_SECRET_DIGEST_HEX: string; SIGNING_SECRET: string; ROOMS: Namespace };
const encoder = new TextEncoder();

function hexBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g)!, byte => Number.parseInt(byte, 16));
}

async function mac(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))), b => b.toString(16).padStart(2, "0")).join("");
}

export async function ownerAuthorized(request: Request, env: Environment): Promise<boolean> {
  const expected = hexBytes(env.OWNER_SECRET_DIGEST_HEX ?? "");
  const auth = request.headers.get("authorization") ?? "";
  return !!expected && await authenticateOwner(auth.startsWith("Bearer ") ? auth.slice(7) : "", expected);
}

export async function readBounded(request: Request, limit: number): Promise<string | null> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return new TextDecoder().decode(bytes);
}

export async function issue(request: Request, env: Environment): Promise<Response> {
  if (!await ownerAuthorized(request, env)) return new Response(null, { status: 401 });
  if (!env.SIGNING_SECRET || env.SIGNING_SECRET.length < 32) return new Response(null, { status: 503 });
  const input = await readBounded(request, 4096);
  if (input === null) return new Response(null, { status: 413 });
  let claim: Claim;
  try { claim = JSON.parse(input); } catch { return new Response(null, { status: 400 }); }
  const now = Math.floor(Date.now() / 1000);
  if (!claim || typeof claim.room !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(claim.room) || typeof claim.nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(claim.nonce) || (claim.previousNonce !== undefined && (typeof claim.previousNonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(claim.previousNonce) || claim.previousNonce === claim.nonce)) || !["producer", "recipient"].includes(claim.role) || !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= now || claim.expiresAt > now + 900) return new Response(null, { status: 400 });
  const payload = JSON.stringify({ room: claim.room, role: claim.role, nonce: claim.nonce, expiresAt: claim.expiresAt, ...(claim.previousNonce === undefined ? {} : { previousNonce: claim.previousNonce }) });
  return Response.json({ payload, signature: await mac(payload, env.SIGNING_SECRET) }, { headers: { "cache-control": "no-store" } });
}

export async function consume(storage: TransactionalStorage, expectedRoom: string, payload: string, signature: string, secret: string, now: number): Promise<boolean> {
  const claim = await verifyClaim(expectedRoom, payload, signature, secret, now);
  return claim ? claimRole(storage, expectedRoom, claim, now) : false;
}

export async function verifyClaim(expectedRoom: string, payload: string, signature: string, secret: string, now: number): Promise<Claim | null> {
  if (payload.length > 4096 || !/^[0-9a-f]{64}$/.test(signature) || !secret || secret.length < 32) return null;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const tag = hexBytes(signature);
  if (!tag || !await crypto.subtle.verify("HMAC", key, Uint8Array.from(tag), encoder.encode(payload))) return null;
  try {
    const claim = JSON.parse(payload) as Claim;
    return claim.room === expectedRoom && ["producer", "recipient"].includes(claim.role) && typeof claim.nonce === "string" && Number.isSafeInteger(claim.expiresAt) && claim.expiresAt > now ? claim : null;
  } catch { return null; }
}
