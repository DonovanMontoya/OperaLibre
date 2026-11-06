import test from "node:test";
import assert from "node:assert/strict";
import { buildGiftDeviceBook, importNativeGift, recoverGiftExtraction, stageGiftImport } from "../src/giftDeviceImport.ts";

const id = "gift____________";
const ebook = { name: "book.epub", size: 10, sha256: "a".repeat(64), kind: "ebook" as const };

test("ebook-only gift maps into a standalone device book", () => {
  const book = buildGiftDeviceBook(id, [ebook], { title: "Gift", author: "Author" });
  assert.equal(book.id, `device:gift:${id}`);
  assert.equal(book.source, "device");
  assert.equal(book.tracks.length, 0);
  assert.equal(book.companions?.[0].localFilePath, `device-library/gift-${id}/book.epub`);
});

test("invalid paths and unsupported alignment fail closed", () => {
  assert.throws(() => buildGiftDeviceBook(id, [{ ...ebook, name: "../book.epub" }], { title: "Gift" }));
  assert.throws(() => buildGiftDeviceBook(id, [ebook, { ...ebook, name: "map.json", kind: "alignment" }], { title: "Gift" }), /not available/);
});

test("native import remains gated", async () => {
  await assert.rejects(importNativeGift(id, [ebook], { title: "Gift" }), /not enabled/);
});

test("file commit before index survives interruption and retries verification", async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  let committed = false, checks = 0;
  const extract = async () => {
    checks++;
    if (!committed) { committed = true; throw new Error("process interrupted after native commit"); }
    return { directory: `device-library/gift-${id}` };
  };
  await assert.rejects(stageGiftImport(storage, id, [ebook], { title: "Gift" }, extract), /interrupted/);
  assert.equal(storage.getItem("operalibre.deviceLibrary.v1"), null);
  assert.equal(await recoverGiftExtraction(storage, extract), "imported");
  assert.equal(checks, 2);
  assert.equal(JSON.parse(storage.getItem("operalibre.deviceLibrary.v1")!).length, 1);
  assert.equal(await recoverGiftExtraction(storage, extract), null);
});

test("overlapping recovery cannot erase a later import's journal", async () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const destination = (giftId: string) => ({ directory: `device-library/gift-${giftId}` });
  await assert.rejects(stageGiftImport(storage, id, [ebook], { title: "Gift" }, async () => { throw new Error("interrupted"); }), /interrupted/);
  let finish!: (result: { directory: string }) => void;
  const recovery = recoverGiftExtraction(storage, () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(recoverGiftExtraction(storage, async () => destination(id)), /already in progress/);
  const nextId = "another_gift____";
  await assert.rejects(stageGiftImport(storage, nextId, [ebook], { title: "Next" }, async () => destination(nextId)), /already in progress/);
  finish(destination(id));
  assert.equal(await recovery, "imported");

  await assert.rejects(stageGiftImport(storage, nextId, [ebook], { title: "Next" }, async () => { throw new Error("interrupted"); }), /interrupted/);
  assert.equal(await recoverGiftExtraction(storage, async () => destination(nextId)), "imported");
  assert.equal(await stageGiftImport(storage, id, [ebook], { title: "Gift" }, async () => destination(id)), "duplicate");
  assert.deepEqual(JSON.parse(storage.getItem("operalibre.deviceLibrary.v1")!).map((book: { id: string }) => book.id), [`device:gift:${id}`, `device:gift:${nextId}`]);
});
