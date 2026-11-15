import test from "node:test";
import assert from "node:assert/strict";
import { buildGiftDeviceBook, buildImportBase, recoverGiftExtraction, stageGiftImport } from "../src/giftDeviceImport.ts";
import { parseGiftMetadata } from "../src/giftMetadata.ts";

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

test("a read-along gift passes the check made before downloading, as it does the import", () => {
  const assets = [
    ebook,
    { name: "one.mp3", size: 10, sha256: "b".repeat(64), kind: "audio" as const },
    { name: "metadata.json", size: 20, sha256: "c".repeat(64), kind: "metadata" as const },
    { name: "alignment.sync.json", size: 30, sha256: "d".repeat(64), kind: "alignment" as const },
  ];
  const metadata = parseGiftMetadata({ version: 1, title: "Gift", tracks: [{ fileName: "one.mp3", index: 0, title: "One", durationSeconds: 10, chapters: [] }],
    alignment: { assetName: "alignment.sync.json", ebookAssetName: "book.epub", audioAssetNames: ["one.mp3"], timeline: "book", precision: "sentence" } }, assets);
  assert.equal(buildImportBase(id, assets, metadata).tracks.length, 1);
  // The map is only trusted alongside the metadata that describes it.
  assert.throws(() => buildImportBase(id, assets.filter(asset => asset.kind !== "metadata"), metadata), /alignment dependencies/);
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
