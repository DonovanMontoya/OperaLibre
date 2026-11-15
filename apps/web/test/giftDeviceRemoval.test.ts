import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import * as giftImport from "../src/giftDeviceImport.ts";
import * as giftIndex from "../src/giftLibraryIndex.ts";
import { loadHook } from "./hookHarness.ts";

const giftId = "gift____________";
const bookId = `device:gift:${giftId}`;
const ebook = { name: "book.epub", size: 10, sha256: "a".repeat(64), kind: "ebook" as const };
const libraryKey = "operalibre.deviceLibrary.v1";
const extractionKey = "operalibre.giftExtractionJournal.v1";
const indexKey = "operalibre.pendingGiftIndex.v1";

function fixture(t: TestContext) {
  const data = new Map<string, string>();
  let failRemoval = false;
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failRemoval && key === libraryKey) throw new Error("storage unavailable");
      data.set(key, value);
    },
    removeItem: (key: string) => { data.delete(key); }
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  const removed: string[] = [];
  const removeBook = loadHook("localLibrary", {
    "@capawesome/capacitor-file-picker": {}, "@capacitor/core": {},
    "@capacitor/filesystem": { Directory: { Data: "DATA" }, Filesystem: {
      rmdir: async ({ path }: { path: string }) => { removed.push(path); }
    } },
    "./audioTags": {}, "./mediaFiles": {}, "./libraryMerge": {},
    "./giftLibraryIndex": giftIndex, "./giftDeviceImport": giftImport, "./reliability.ts": {}
  }, "removeDeviceBook");
  return { storage, removed, removeBook, failNextRemoval: () => { failRemoval = true; } };
}

test("removing an interrupted gift publication prevents both journals from restoring it", async t => {
  const f = fixture(t);
  const book = giftImport.buildGiftDeviceBook(giftId, [ebook], { title: "Gift" });
  f.storage.setItem(libraryKey, JSON.stringify([book, { id: "another-book" }]));
  f.storage.setItem(indexKey, JSON.stringify(book));
  f.storage.setItem(extractionKey, JSON.stringify({ giftId, assets: [ebook], metadata: { title: "Gift" } }));
  const progress = JSON.stringify({ [bookId]: { positionSeconds: 120 } });
  f.storage.setItem("operalibre.deviceProgress.v1", progress);

  await f.removeBook(bookId);
  giftIndex.recoverGiftIndex(f.storage);
  assert.equal(await giftImport.recoverGiftExtraction(f.storage, async () => {
    assert.fail("a removed gift must not be extracted again");
  }), null);
  assert.deepEqual(JSON.parse(f.storage.getItem(libraryKey)!), [{ id: "another-book" }]);
  assert.deepEqual(f.removed, [`device-library/gift-${giftId}`]);
  assert.equal(f.storage.getItem("operalibre.deviceProgress.v1"), progress);
});

test("removing a gift with only a pending index still removes its local files", async t => {
  const f = fixture(t);
  f.storage.setItem(indexKey, JSON.stringify(giftImport.buildGiftDeviceBook(giftId, [ebook], { title: "Gift" })));
  await f.removeBook(bookId);
  giftIndex.recoverGiftIndex(f.storage);
  assert.deepEqual(JSON.parse(f.storage.getItem(libraryKey)!), []);
  assert.deepEqual(f.removed, [`device-library/gift-${giftId}`]);
});

test("removal cannot race native extraction or discard its recovery journal", async t => {
  const f = fixture(t);
  let finish!: (result: { directory: string }) => void;
  const importing = giftImport.stageGiftImport(f.storage, giftId, [ebook], { title: "Gift" },
    () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(f.removeBook(bookId), /already in progress/);
  assert.ok(f.storage.getItem(extractionKey));
  assert.deepEqual(f.removed, []);
  finish({ directory: `device-library/gift-${giftId}` });
  assert.equal(await importing, "imported");
});

test("a failed shelf removal keeps the files available", async t => {
  const f = fixture(t);
  const book = giftImport.buildGiftDeviceBook(giftId, [ebook], { title: "Gift" });
  const shelf = JSON.stringify([book]);
  f.storage.setItem(libraryKey, shelf);
  f.failNextRemoval();
  await assert.rejects(f.removeBook(bookId), /storage unavailable/);
  assert.deepEqual(f.removed, []);
  assert.equal(f.storage.getItem(libraryKey), shelf);
});

test("removing one gift preserves another gift's extraction recovery", async t => {
  const f = fixture(t);
  const otherId = "another_gift____";
  await assert.rejects(giftImport.stageGiftImport(f.storage, otherId, [ebook], { title: "Other" },
    async () => { throw new Error("interrupted"); }), /interrupted/);
  const journal = f.storage.getItem(extractionKey);
  f.storage.setItem(libraryKey, JSON.stringify([giftImport.buildGiftDeviceBook(giftId, [ebook], { title: "Gift" })]));
  await f.removeBook(bookId);
  assert.equal(f.storage.getItem(extractionKey), journal);
  assert.equal(await giftImport.recoverGiftExtraction(f.storage,
    async () => ({ directory: `device-library/gift-${otherId}` })), "imported");
  assert.equal(JSON.parse(f.storage.getItem(libraryKey)!)[0].id, `device:gift:${otherId}`);
});

test("ordinary device audio removal keeps listening history", async t => {
  const f = fixture(t);
  const ordinaryId = "device:ordinary";
  f.storage.setItem(libraryKey, JSON.stringify([{ id: ordinaryId, tracks: [{ localFilePath: "device-library/ordinary/audio.mp3" }] }]));
  const progress = JSON.stringify({ [ordinaryId]: { positionSeconds: 45 } });
  f.storage.setItem("operalibre.deviceProgress.v1", progress);
  await f.removeBook(ordinaryId);
  assert.deepEqual(JSON.parse(f.storage.getItem(libraryKey)!), []);
  assert.deepEqual(f.removed, ["device-library/ordinary"]);
  assert.equal(f.storage.getItem("operalibre.deviceProgress.v1"), progress);
});
