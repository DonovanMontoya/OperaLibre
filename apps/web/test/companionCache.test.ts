import assert from "node:assert/strict";
import { test } from "node:test";
import { optionalCompanionDownload, revalidatedCompanion } from "../src/companionCache.ts";

test("an online companion open replaces stale durable bytes and requests HTTP revalidation", async (t) => {
  let cached = new TextEncoder().encode("old edition").buffer;
  t.mock.method(globalThis, "fetch", async (_url: string, options: RequestInit) => {
    assert.equal(options.cache, "no-cache");
    assert.equal(options.credentials, "include");
    return new Response("new edition");
  });
  const data = await revalidatedCompanion("/book.epub", async () => cached, async (data) => { cached = data; });
  assert.equal(new TextDecoder().decode(data), "new edition");
  assert.equal(cached, data);
});

test("network failures use durable bytes but cancellation never does", async (t) => {
  const cached = new TextEncoder().encode("offline edition").buffer;
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("offline"); });
  assert.equal(await revalidatedCompanion("/book.epub", async () => cached, async () => {}), cached);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(revalidatedCompanion("/book.epub", async () => cached, async () => {}, controller.signal), { name: "AbortError" });
});

test("revoked access does not return a cached companion", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 403 }));
  await assert.rejects(revalidatedCompanion("/book.epub", async () => new ArrayBuffer(1), async () => {}), /403/);
});

test("a full cache does not prevent reading freshly downloaded bytes", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("new edition"));
  const bytes = await revalidatedCompanion("/book.epub", async () => null, async () => { throw new Error("quota"); });
  assert.equal(new TextDecoder().decode(bytes), "new edition");
});

test("optional body and storage failures preserve completed audio, but cancellation propagates", async () => {
  for (const failure of ["fetch failed", "body failed", "quota exceeded"]) {
    const written = ["audio-track"];
    try {
      await optionalCompanionDownload(async () => { throw new Error(failure); });
    } catch {
      written.length = 0;
    }
    assert.deepEqual(written, ["audio-track"]);
  }
  const controller = new AbortController();
  await assert.rejects(optionalCompanionDownload(async () => {
    controller.abort();
    throw new Error("body interrupted");
  }, controller.signal), { name: "AbortError" });
  const completed = new AbortController();
  await assert.rejects(optionalCompanionDownload(async () => { completed.abort(); }, completed.signal), { name: "AbortError" });
});
