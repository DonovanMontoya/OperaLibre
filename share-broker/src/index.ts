const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_MESSAGES = 32;
const MAX_TTL_SECONDS = 15 * 60;
const MAX_PREVIEW_MESSAGE_BYTES = 180 * 1024;
import { issue, consume, ownerAuthorized, readBounded, verifyClaim, signClaim } from "./experimental.js";
import { rotateRole, claimRecipientRecovery, recipientRecoverySuccessor, recipientRecoveryAuthorized, type Transaction, type TransactionalStorage } from "./claims.js";
import { cleanupRoom, reserveRoom, validReservation } from "./reservations.js";
import { giftLandingResponse } from "./gift-landing.js";

type DurableObject = { fetch(request: Request): Promise<Response> };
type DurableObjectState = { storage: { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void>; transaction<T>(fn: (txn: Transaction) => Promise<T>): Promise<T> } };
type DurableObjectNamespace = { idFromName(name: string): unknown; get(id: unknown): DurableObject };

type Env = { ROOMS: DurableObjectNamespace; CAPABILITY_SECRET: string; OWNER_SECRET_DIGEST_HEX: string; SIGNING_SECRET: string; EXPERIMENTAL_ENABLED?: string };
type Capability = { room: string; invitationDigest: string; nonce: string; expiresAt: number; maxBytes: number; assets: string[] };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

function encode(value: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
function decode(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(normalized + padding), c => c.charCodeAt(0));
}

export async function sign(capability: Capability, secret: string) {
  const payload = encode(new TextEncoder().encode(JSON.stringify(capability)).buffer);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${payload}.${encode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)))}`;
}

export async function verify(token: string, secret: string): Promise<Capability | null> {
  try {
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const capability = JSON.parse(new TextDecoder().decode(decode(payload))) as Capability;
    if (!capability.room || capability.expiresAt <= Math.floor(Date.now() / 1000) || capability.assets.length === 0 || capability.maxBytes <= 0) return null;
    const expected = await sign(capability, secret);
    const a = new TextEncoder().encode(expected.split(".")[1]);
    const b = new TextEncoder().encode(signature);
    if (a.length !== b.length) return null;
    let mismatch = 0; for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
    return mismatch === 0 ? capability : null;
  } catch { return null; }
}

export class Room implements DurableObject {
  constructor(private state: DurableObjectState) {}
  async fetch(request: Request) {
    if (request.method !== "POST" || request.headers.get("content-type") !== "application/json") return new Response("method not allowed", { status: 405 });
    const body = await request.arrayBuffer();
    const role = request.headers.get("x-role");
    const nonce = request.headers.get("x-nonce");
    const digest = request.headers.get("x-invitation-digest");
    if ((role !== "producer" && role !== "recipient") || !nonce || !digest) return new Response("membership required", { status: 401 });
    if ((await this.state.storage.get<string>("invitationDigest")) && (await this.state.storage.get<string>("invitationDigest")) !== digest) return new Response("room mismatch", { status: 403 });
    await this.state.storage.put("invitationDigest", digest);
    const claimedKey = `claim:${role}`;
    const claimed = await this.state.storage.get<string>(claimedKey);
    if (claimed && claimed !== nonce) return new Response("role already claimed", { status: 409 });
    await this.state.storage.put(claimedKey, nonce);
    if (body.byteLength > MAX_MESSAGE_BYTES) return new Response("message too large", { status: 413 });
    const messages = (await this.state.storage.get<number>("messages") ?? 0) + 1;
    if (messages > MAX_MESSAGES) return new Response("room quota exceeded", { status: 429 });
    await this.state.storage.put("messages", messages);
    await this.state.storage.put(`message:${messages}`, new Uint8Array(body));
    return new Response(null, { status: 204 });
  }
}

/** Separate object class: authorization and counters share transactional storage. */
export class SecureRoom implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (url.pathname === "/rate") {
      const now = Math.floor(Date.now() / 60_000);
      const allowed = await this.state.storage.transaction(async txn => {
        const previous = await txn.get<{ minute: number; count: number }>("rate");
        const count = previous?.minute === now ? previous.count + 1 : 1;
        if (count > 30) return false;
        await txn.put("rate", { minute: now, count });
        return true;
      });
      return new Response(null, { status: allowed ? 204 : 429 });
    }
    if (url.pathname === "/revoke") {
      await this.state.storage.transaction(async txn => {
        await txn.put("revoked", true);
        await txn.put("queue:producer", []);
        await txn.put("queue:recipient", []);
        await txn.put("preview", null);
        await txn.put("recovery:recipient", null);
      });
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/reserve" || url.pathname === "/cleanup") {
      const text = await readBounded(request, 4096);
      if (text === null) return new Response(null, { status: 413 });
      let body: unknown;
      try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
      if (!validReservation(body)) return new Response(null, { status: 400 });
      const clock = () => Math.floor(Date.now() / 1000);
      const ok = url.pathname === "/reserve" ? await reserveRoom(this.state.storage, body, clock) : await cleanupRoom(this.state.storage, body, clock);
      return new Response(null, { status: ok ? 204 : url.pathname === "/reserve" ? 409 : 403, headers: { "cache-control": "no-store" } });
    }
    if (!["/claim", "/recovery-claim", "/recovery-successor", "/resume", "/session", "/send", "/poll", "/preview-put", "/preview-read"].includes(url.pathname)) return new Response(null, { status: 404 });
    const text = await readBounded(request, url.pathname === "/preview-put" ? MAX_PREVIEW_MESSAGE_BYTES : 8192);
    if (text === null) return new Response(null, { status: 413 });
    let body: { room: string; payload: string; signature: string; recoverySecret?: string; nextPayload?: string; nextSignature?: string; generation?: number; sequence?: number; kind?: string; message?: string; after?: number; nonce?: string; ciphertext?: string; expiresAt?: number };
    try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
    if (!body || typeof body.room !== "string") return new Response(null, { status: 400 });
    const now = Math.floor(Date.now() / 1000);
    if (url.pathname === "/preview-put") {
      if (typeof body.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(body.nonce) || typeof body.ciphertext !== "string" || !/^[A-Za-z0-9_-]{22,174784}$/.test(body.ciphertext) || !Number.isSafeInteger(body.expiresAt) || body.expiresAt! <= now || body.expiresAt! > now + 900) return new Response(null, { status: 400 });
      return this.state.storage.transaction(async txn => {
        if (await txn.get("revoked") || await txn.get("preview")) return new Response(null, { status: 409 });
        await txn.put("preview", { nonce: body.nonce, ciphertext: body.ciphertext, expiresAt: body.expiresAt });
        return new Response(null, { status: 204 });
      });
    }
    if (typeof body.payload !== "string" || typeof body.signature !== "string") return new Response(null, { status: 400 });
    if (url.pathname === "/claim") {
      const ok = await consume(this.state.storage as TransactionalStorage, body.room, body.payload, body.signature, this.env.SIGNING_SECRET, now);
      return new Response(null, { status: ok ? 204 : 403 });
    }
    const claim = await verifyClaim(body.room, body.payload, body.signature, this.env.SIGNING_SECRET, now);
    if (!claim) return new Response(null, { status: 403 });
    if (url.pathname === "/recovery-claim" || url.pathname === "/recovery-successor") {
      const clock = () => Math.floor(Date.now() / 1000);
      if (url.pathname === "/recovery-claim") {
        const ok = await claimRecipientRecovery(this.state.storage, body.room, claim, body.recoverySecret!, clock);
        return new Response(null, { status: ok ? 204 : 403, headers: { "cache-control": "no-store" } });
      }
      const next = await recipientRecoverySuccessor(this.state.storage, body.room, claim, body.recoverySecret!, next => signClaim(next, this.env.SIGNING_SECRET), clock);
      return next ? json(next) : new Response(null, { status: 403 });
    }
    if (url.pathname === "/resume") {
      if (typeof body.nextPayload !== "string" || typeof body.nextSignature !== "string" || !Number.isSafeInteger(body.generation) || body.generation! < 0 || body.generation! >= Number.MAX_SAFE_INTEGER) return new Response(null, { status: 400 });
      const next = await verifyClaim(body.room, body.nextPayload, body.nextSignature, this.env.SIGNING_SECRET, now);
      if (!next) return new Response(null, { status: 403 });
      const ok = await rotateRole(this.state.storage, body.room, claim, next, body.generation!, () => Math.floor(Date.now() / 1000), body.recoverySecret);
      return new Response(null, { status: ok ? 204 : 403, headers: { "cache-control": "no-store", ...(ok ? { "x-signaling-generation": String(body.generation! + 1) } : {}) } });
    }
    if (url.pathname === "/preview-read") {
      if (claim.role !== "recipient") return new Response(null, { status: 403 });
      return this.state.storage.transaction(async txn => {
        if (await txn.get("revoked")) return new Response(null, { status: 403 });
        if (!await recipientRecoveryAuthorized(txn, claim, body.recoverySecret, () => Math.floor(Date.now() / 1000))) return new Response(null, { status: 403 });
        const preview = await txn.get<{ nonce: string; ciphertext: string; expiresAt: number }>("preview");
        if (!preview || preview.expiresAt !== claim.expiresAt || preview.expiresAt <= now) return new Response(null, { status: 404 });
        const member = await txn.get<{ nonce: string }>("claim:recipient");
        if (member && member.nonce !== claim.nonce) return new Response(null, { status: 403 });
        return Response.json({ nonce: preview.nonce, ciphertext: preview.ciphertext }, { headers: { "cache-control": "no-store" } });
      });
    }
    if (body.generation !== undefined && (!Number.isSafeInteger(body.generation) || body.generation < 0)) return new Response(null, { status: 400 });
    if (url.pathname === "/send" && (!Number.isSafeInteger(body.sequence) || body.sequence! < 1 || body.sequence! > 32 || typeof body.message !== "string" || new TextEncoder().encode(body.message).length > 7168 || !["ready", "offer", "answer", "ice"].includes(body.kind ?? "") || (body.kind === "offer" && (claim.role !== "producer" || body.sequence !== 1)) || (body.kind === "ready" && (claim.role !== "recipient" || body.sequence !== 1)) || (body.kind === "answer" && (claim.role !== "recipient" || body.sequence !== 2)) || (body.kind === "ice" && body.sequence! < (claim.role === "producer" ? 2 : 3)))) return new Response(null, { status: 400 });
    if (url.pathname === "/poll" && (!Number.isSafeInteger(body.after) || body.after! < 0 || body.after! > 32)) return new Response(null, { status: 400 });
    return this.state.storage.transaction(async txn => {
      if (await txn.get("revoked")) return new Response(null, { status: 403 });
      if (!await recipientRecoveryAuthorized(txn, claim, body.recoverySecret, () => Math.floor(Date.now() / 1000))) return new Response(null, { status: 403 });
      const member = await txn.get<{ nonce: string; expiresAt: number }>(`claim:${claim.role}`);
      if (!member || member.nonce !== claim.nonce || member.expiresAt !== claim.expiresAt || member.expiresAt <= Math.floor(Date.now() / 1000)) return new Response(null, { status: 403 });
      if (url.pathname === "/session") {
        return Response.json({ generation: await txn.get<number>("generation") ?? 0 }, { headers: { "cache-control": "no-store" } });
      }
      if ((await txn.get<number>("generation") ?? 0) !== (body.generation ?? 0)) return new Response(null, { status: 409 });
      if (url.pathname === "/send") {
        const key = `queue:${claim.role}`;
        const queue = await txn.get<Array<{ sequence: number; kind: string; message: string }>>(key) ?? [];
        if (body.sequence !== queue.length + 1 || queue.length >= 32) return new Response(null, { status: 409 });
        queue.push({ sequence: body.sequence!, kind: body.kind!, message: body.message! });
        await txn.put(key, queue);
        return new Response(null, { status: 204 });
      }
      const other = claim.role === "producer" ? "recipient" : "producer";
      const queue = await txn.get<Array<{ sequence: number }>>(`queue:${other}`) ?? [];
      return Response.json(queue.filter(item => item.sequence > body.after!), { headers: { "cache-control": "no-store" } });
    });
  }
}

async function experimentalRoute(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (url.pathname === "/issue") {
      if (!await ownerAuthorized(request, env)) return new Response(null, { status: 401 });
      const limiter = env.ROOMS.get(env.ROOMS.idFromName("issuance-rate"));
      const limited = await limiter.fetch(new Request("https://internal/rate", { method: "POST" }));
      if (limited.status !== 204) return limited;
      return issue(request, env);
    }
    if (url.pathname.startsWith("/revoke/")) {
      if (!await ownerAuthorized(request, env)) return new Response(null, { status: 401 });
      const room = url.pathname.slice("/revoke/".length);
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(room)) return new Response(null, { status: 400 });
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request("https://internal/revoke", { method: "POST" }));
    }
    if (/^\/(reserve|cleanup)\//.test(url.pathname)) {
      if (!await ownerAuthorized(request, env)) return new Response(null, { status: 401 });
      const match = /^\/(reserve|cleanup)\/([A-Za-z0-9_-]{16,128})$/.exec(url.pathname);
      if (!match || match[2] === "issuance-rate") return new Response(null, { status: 400 });
      const text = await readBounded(request, 4096);
      if (text === null) return new Response(null, { status: 413 });
      return env.ROOMS.get(env.ROOMS.idFromName(match[2])).fetch(new Request(`https://internal/${match[1]}`, { method: "POST", body: text }));
    }
    if (/^\/(claim|recovery-claim|recovery-successor|resume|session|send|poll|preview-put|preview-read)\//.test(url.pathname)) {
      const [, action, room] = url.pathname.split("/");
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(room)) return new Response(null, { status: 400 });
      if (action === "preview-put" && !await ownerAuthorized(request, env)) return new Response(null, { status: 401 });
      const text = await readBounded(request, action === "preview-put" ? MAX_PREVIEW_MESSAGE_BYTES : 8192);
      if (text === null) return new Response(null, { status: 413 });
      let body: Record<string, unknown>;
      try { body = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
      return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request(`https://internal/${action}`, { method: "POST", body: JSON.stringify({ ...body, room }) }));
    }
    return new Response(null, { status: 404 });
}

const APP_ORIGINS = new Set(["capacitor://localhost", "http://localhost", "https://localhost", "http://127.0.0.1:49201"]);
export default {
  async fetch(request: Request, env: Env) {
    // This gate stays closed until independent security and native review.
    if (env.EXPERIMENTAL_ENABLED !== "true") return json({ error: "Book sharing broker is not enabled." }, 503);
    if (request.method === "GET" && new URL(request.url).pathname === "/gift") return giftLandingResponse();
    const origin = request.headers.get("origin");
    if (origin && !APP_ORIGINS.has(origin)) return new Response(null, { status: 403 });
    if (request.method === "OPTIONS") {
      if (!origin || request.headers.get("access-control-request-method") !== "POST") return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": origin, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "vary": "Origin" } });
    }
    const response = await experimentalRoute(request, env);
    if (!origin) return response;
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", origin);
    headers.set("access-control-expose-headers", "x-signaling-generation");
    headers.set("vary", "Origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
};
