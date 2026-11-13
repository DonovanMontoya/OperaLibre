import test from "node:test";
import assert from "node:assert/strict";
import { publishGiftIndex, recoverGiftIndex } from "../src/giftLibraryIndex.ts";
import type { Book } from "../src/types.ts";

function storage() {
  const data = new Map<string, string>();
  let failIndex = false;
  return {
    getItem(key: string) { return data.get(key) ?? null; },
    setItem(key: string, value: string) { if (failIndex && key === "operalibre.deviceLibrary.v1") { failIndex = false; throw new Error("storage interrupted"); } data.set(key, value); },
    removeItem(key: string) { data.delete(key); },
    failNextIndex() { failIndex = true; },
  };
}
const giftId = "gift____________";
const book = { id: `device:gift:${giftId}`, deviceBookId: `device:gift:${giftId}`, source: "device", title: "A gift", tracks: [] } as unknown as Book;

test("interrupted index publication recovers and replay is a duplicate", () => {
  const local = storage();
  local.failNextIndex();
  assert.throws(() => publishGiftIndex(local, giftId, book), /interrupted/);
  recoverGiftIndex(local);
  assert.equal(JSON.parse(local.getItem("operalibre.deviceLibrary.v1")!).length, 1);
  assert.equal(publishGiftIndex(local, giftId, book), "duplicate");
  assert.equal(JSON.parse(local.getItem("operalibre.deviceLibrary.v1")!).length, 1);
});

test("invalid identity cannot overwrite the device library", () => {
  const local = storage();
  local.setItem("operalibre.deviceLibrary.v1", JSON.stringify([{ id: "existing" }]));
  assert.throws(() => publishGiftIndex(local, giftId, { ...book, id: "existing" }));
  assert.deepEqual(JSON.parse(local.getItem("operalibre.deviceLibrary.v1")!), [{ id: "existing" }]);
});
