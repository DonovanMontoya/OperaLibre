import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { defaultGiftSelection, giftSelectionSummary, parseGiftInventory, selectedGiftRequest } from "../src/giftSelectionModel.ts";

// An opt-in fixture must be exported from the Rust loopback HTTP route test,
// not manufactured from a client Book or a hand-written DTO.
const fixture = process.env.OPERALIBRE_GIFT_HTTP_INVENTORY_FIXTURE;
test("actual server HTTP inventory is accepted by the sender parser and stays lightweight", { skip: !fixture }, async () => {
  const response: unknown = JSON.parse(await readFile(fixture!, "utf8"));
  const bookId = (response as { bookId: string }).bookId;
  const inventory = parseGiftInventory(response, bookId);
  const selected = defaultGiftSelection(inventory);
  const summary = giftSelectionSummary(inventory, selected);
  assert.deepEqual(summary.errors, []);
  assert.ok(summary.assets.some(asset => asset.kind === "metadata"));
  assert.ok(summary.assets.some(asset => asset.kind === "ebook"));
  assert.ok(summary.assets.every(asset => asset.kind !== "audio" && asset.kind !== "alignment"));
  const request = selectedGiftRequest(inventory, selected, "A private card");
  assert.deepEqual(request.selectedAssetIds, selected);
  assert.deepEqual(Object.keys(request), ["bookId", "selectedAssetIds", "personalMessage", "expiresInSeconds"]);
});
