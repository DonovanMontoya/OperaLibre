import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "node:http";
import broker, { SecureRoom } from "../dist-test/index.js";

function storage() {
  const values = new Map(); let tail = Promise.resolve();
  return { transaction(fn) {
    const result = tail.then(() => fn({ async get(k) { return values.get(k); }, async put(k, v) { values.set(k, v); } }));
    tail = result.catch(() => {}); return result;
  } };
}

test("browser WebRTC peers exchange SDP through broker and transfer bytes", { timeout: 30000 }, async () => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("owner-secret")));
  const env = { EXPERIMENTAL_ENABLED: "true", OWNER_SECRET_DIGEST_HEX: Array.from(digest, b => b.toString(16).padStart(2, "0")).join(""), SIGNING_SECRET: "s".repeat(32) };
  const objects = new Map();
  env.ROOMS = { idFromName: name => name, get(name) { if (!objects.has(name)) objects.set(name, new SecureRoom({ storage: storage() }, env)); return objects.get(name); } };
  const call = async (path, body, headers = {}) => {
    const response = await broker.fetch(new Request(`https://broker/${path}`, { method: "POST", headers, body: JSON.stringify(body) }), env);
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const room = "loopback________";
  async function member(role, nonce) {
    const issued = await call("issue", { room, role, nonce, expiresAt: Math.floor(Date.now() / 1000) + 120 }, { authorization: "Bearer owner-secret" });
    assert.equal(issued.status, 200);
    assert.equal((await call(`claim/${room}`, issued.body)).status, 204);
    return issued.body;
  }
  const producer = await member("producer", "producer________");
  const recipient = await member("recipient", "recipient_______");
  const browser = await chromium.launch({ headless: true, executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, args: ["--allow-loopback-in-peer-connection"] });
  const server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>WebRTC test</title>"); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.exposeFunction("brokerCall", call);
    const received = await page.evaluate(async ({ room, producer, recipient }) => {
      const send = async (token, sequence, kind, message) => {
        const result = await window.brokerCall(`send/${room}`, { ...token, sequence, kind, message });
        if (result.status !== 204) throw new Error(`send: ${result.status}`);
      };
      const poll = async (token, after = 0) => {
        const result = await window.brokerCall(`poll/${room}`, { ...token, after });
        if (result.status !== 200 || !result.body.length) throw new Error(`poll: ${result.status}`);
        return result.body[0].message;
      };
      const gather = pc => pc.iceGatheringState === "complete" ? Promise.resolve() : new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`ICE gathering timed out: ${pc.iceGatheringState}`)), 8000); pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(timer); resolve(); } }); });
      const a = new RTCPeerConnection({ iceServers: [] });
      const b = new RTCPeerConnection({ iceServers: [] });
      try {
        const data = new Promise(resolve => { b.ondatachannel = event => { event.channel.onmessage = message => resolve(message.data); }; });
        const channel = a.createDataChannel("gift");
        const opened = new Promise(resolve => { channel.onopen = resolve; });
        await send(recipient, 1, "ready", JSON.stringify({ challenge: "A".repeat(43) }));
        await a.setLocalDescription(await a.createOffer()); await gather(a);
        if (!a.localDescription.sdp.includes("a=candidate:")) throw new Error("offer gathered no ICE candidates");
        await send(producer, 1, "offer", JSON.stringify(a.localDescription));
        await b.setRemoteDescription(JSON.parse(await poll(recipient)));
        await b.setLocalDescription(await b.createAnswer()); await gather(b);
        if (!b.localDescription.sdp.includes("a=candidate:")) throw new Error("answer gathered no ICE candidates");
        await send(recipient, 2, "answer", JSON.stringify(b.localDescription));
        await a.setRemoteDescription(JSON.parse(await poll(producer, 1)));
        await Promise.race([opened, new Promise((_, reject) => setTimeout(() => reject(new Error(`channel timed out: ${a.connectionState}/${b.connectionState}`)), 8000))]); channel.send("OperaLibre broker loopback");
        return await Promise.race([data, new Promise((_, reject) => setTimeout(() => reject(new Error("message timed out")), 8000))]);
      } finally { a.close(); b.close(); }
    }, { room, producer, recipient });
    assert.equal(received, "OperaLibre broker loopback");
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
