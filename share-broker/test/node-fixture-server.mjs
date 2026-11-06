// Local integration fixture, never a deployable broker: real Worker routing
// and SecureRoom code over loopback HTTP, simulated transactional DO storage.
// Compile first with `tsc -p share-broker/tsconfig.test.json`.
import { createServer } from "node:http";
import broker, { SecureRoom } from "../dist-test/index.js";

const owner = "fixture-owner-not-a-real-credential-123";
const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner));
const env = { EXPERIMENTAL_ENABLED: "true", OWNER_SECRET_DIGEST_HEX: Buffer.from(digest).toString("hex"), SIGNING_SECRET: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex") };
const rooms = new Map();
env.ROOMS = { idFromName: name => name, get(name) {
  if (!rooms.has(name)) {
    if (rooms.size >= 256) throw new Error("Fixture room capacity exceeded.");
    const values = new Map(); let tail = Promise.resolve();
    const store = {
      async get(key) { return structuredClone(values.get(key)); },
      async put(key, value) { values.set(key, structuredClone(value)); },
      transaction(fn) {
        const result = tail.then(async () => {
          const staged = new Map([...values].map(([key, value]) => [key, structuredClone(value)]));
          const transaction = { async get(key) { return structuredClone(staged.get(key)); }, async put(key, value) { staged.set(key, structuredClone(value)); } };
          const returned = await fn(transaction);
          // Publish synchronously only after the entire callback succeeds.
          values.clear(); for (const [key, value] of staged) values.set(key, value);
          return returned;
        });
        tail = result.catch(() => {}); return result;
      },
    };
    rooms.set(name, new SecureRoom({ storage: store }, env));
  }
  return rooms.get(name);
} };
const server = createServer(async (incoming, outgoing) => {
  try {
    const buffers = []; let size = 0;
    for await (const bytes of incoming) {
      size += bytes.length;
      if (size > 200 * 1024) { outgoing.writeHead(413); outgoing.end(); return; }
      buffers.push(bytes);
    }
    const method = incoming.method ?? "GET";
    // Request host/header cannot choose an outbound destination. The Worker
    // uses URLs for routing only; all room objects remain inside this process.
    const request = new Request(new URL(incoming.url ?? "/", "https://fixture.invalid"), { method, headers: incoming.headers, ...(method === "GET" || method === "HEAD" ? {} : { body: Buffer.concat(buffers) }) });
    const response = await broker.fetch(request, env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { "content-type": "text/plain" }); outgoing.end("Local Worker fixture failed.");
  }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener unavailable.");
  // Only the ephemeral loopback locator is printed, never broker state/keys.
  process.stdout.write(JSON.stringify({ origin: `http://127.0.0.1:${address.port}` }) + "\n");
});
process.once("SIGTERM", () => { server.close(); server.closeAllConnections(); });
