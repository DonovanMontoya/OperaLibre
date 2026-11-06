import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { defaultGiftSelection, giftAssetDisabledReason, giftSelectionSummary, parseCreatedGift, parseGiftInventory, selectedGiftRequest, type GiftInventory } from "../src/giftSelectionModel.ts";

function inventory(): GiftInventory {
  return { bookId: "server-book", title: "A book", maxBytes: 5000, assets: [
    { id: "metadata", kind: "metadata", fileName: "metadata.json", sizeBytes: 10, available: true },
    { id: "ebook", kind: "ebook", fileName: "book.epub", sizeBytes: 100, available: true },
    { id: "cover", kind: "cover", fileName: "cover.jpg", sizeBytes: 20, available: true },
    { id: "audio", kind: "audio", fileName: "audio.m4b", sizeBytes: 1000, available: true },
    { id: "alignment", kind: "alignment", fileName: "sync.json", sizeBytes: 30, available: true, requiresAssetIds: ["ebook", "audio"] },
    { id: "drm", kind: "ebook", fileName: "protected.epub", sizeBytes: 100, available: false, disabledReason: "DRM-protected; not shareable." },
  ], defaultSelectedAssetIds: ["metadata", "ebook", "cover", "audio", "alignment"] };
}

test("lightweight defaults include metadata, ebook and cover but never opt in to audio or alignment", () => {
  const inv = parseGiftInventory(inventory(), "server-book");
  const selected = defaultGiftSelection(inv);
  assert.deepEqual(selected, ["metadata", "ebook", "cover"]);
  assert.deepEqual(giftSelectionSummary(inv, selected).formats, ["Metadata", "EPUB", "Cover"]);
  assert.equal(giftSelectionSummary(inv, selected).sizeBytes, 130);
  assert.equal(giftSelectionSummary(inv, [...selected, "audio"]).sizeBytes, 1130);
  inv.defaultSelectedAssetIds = [];
  assert.deepEqual(defaultGiftSelection(inv), selected);
});

test("selected IDs, metadata, availability and matching dependencies are validated", () => {
  const inv = inventory();
  for (const ids of [["ebook"], ["metadata", "unknown"], ["metadata", "ebook", "ebook"], ["metadata", "drm"], ["metadata", "ebook", "alignment"], ["metadata", "cover"]]) assert.ok(giftSelectionSummary(inv, ids).errors.length, ids.join(","));
  assert.match(giftAssetDisabledReason(inv.assets[4])!, /not supported.*matching text and audio/);
  inv.assets[3].requiresAssetIds = ["ebook"];
  assert.match(giftSelectionSummary(inv, ["metadata", "audio"]).errors.join(" "), /requires book.epub/);
  assert.equal(giftSelectionSummary(inv, ["metadata", "ebook", "audio"]).errors.length, 0);
});

test("inventory rejects other books, duplicate IDs, missing metadata and unsafe resource declarations", () => {
  const invalid: unknown[] = [null, {}, { ...inventory(), bookId: "unauthorized-book" }, { ...inventory(), assets: [] }, { ...inventory(), maxBytes: 0 }, { ...inventory(), defaultSelectedAssetIds: ["unknown"] }];
  const duplicate = inventory(); duplicate.assets.push(duplicate.assets[0]); invalid.push(duplicate);
  const missing = inventory(); missing.assets = missing.assets.filter(asset => asset.kind !== "metadata"); invalid.push(missing);
  const size = inventory(); size.assets[0].sizeBytes = -1; invalid.push(size);
  const dependency = inventory(); dependency.assets[0].requiresAssetIds = ["missing"]; invalid.push(dependency);
  const excessive = inventory(); excessive.assets = Array.from({ length: 257 }, (_, i) => ({ ...excessive.assets[0], id: `id${i}` })); invalid.push(excessive);
  for (const inv of invalid) assert.throws(() => parseGiftInventory(inv, "server-book"));
  const original = inventory(); const parsed = parseGiftInventory(original, "server-book"); parsed.assets[0].available = false; assert.equal(original.assets[0].available, true);
  const serdeNull = inventory(); serdeNull.assets[0].disabledReason = null;
  assert.equal(giftAssetDisabledReason(parseGiftInventory(serdeNull, "server-book").assets[0]), null);
});

test("size limit and integer overflow fail closed", () => {
  const inv = inventory(); inv.maxBytes = 100;
  assert.match(giftSelectionSummary(inv, defaultGiftSelection(inv)).errors.join(" "), /size limit/);
  inv.maxBytes = Number.MAX_SAFE_INTEGER; inv.assets[1].sizeBytes = Number.MAX_SAFE_INTEGER;
  assert.match(giftSelectionSummary(inv, ["metadata", "ebook"]).errors.join(" "), /size limit/);
});

test("create body contains only IDs, a bounded Unicode message and short expiry", () => {
  const inv = inventory();
  const request = selectedGiftRequest(inv, defaultGiftSelection(inv), "🎁".repeat(1000), 300);
  assert.deepEqual(Object.keys(request), ["bookId", "selectedAssetIds", "personalMessage", "expiresInSeconds"]);
  assert.equal(Array.from(request.personalMessage!).length, 1000);
  assert.equal(JSON.stringify(request).includes("book.epub"), false);
  assert.equal(JSON.stringify(request).includes("sha256"), false);
  assert.throws(() => selectedGiftRequest(inv, defaultGiftSelection(inv), "🎁".repeat(1001)), /1000/);
  assert.throws(() => selectedGiftRequest(inv, defaultGiftSelection(inv), "null\0byte"));
  assert.throws(() => selectedGiftRequest(inv, defaultGiftSelection(inv), "Hello", 3600));
  assert.equal(selectedGiftRequest(inv, defaultGiftSelection(inv), "  ").personalMessage, undefined);
  assert.equal(selectedGiftRequest(inv, defaultGiftSelection(inv), "<script>plain text</script>").personalMessage, "<script>plain text</script>");
});

test("a gift link is accepted only when actually returned by the server", () => {
  const gift = { giftUrl: "https://owner.example/gift#private-credentials", expiresAt: 2000000000 };
  assert.deepEqual(parseCreatedGift(gift), gift);
  assert.throws(() => parseCreatedGift({ ...gift, giftUrl: `https://owner.example/gift#gift=${"private".repeat(8)}`, managementToken: "private".repeat(8) }), /management token/);
  for (const value of [{}, { token: "not-a-link" }, { ...gift, giftUrl: "http://owner.example/gift#private" }, { ...gift, giftUrl: "https://owner.example/gift?secret=x#private" }, { ...gift, giftUrl: "https://user:secret@owner.example/gift#private" }, { ...gift, giftUrl: "javascript:alert(1)" }, { ...gift, giftUrl: "https://owner.example/gift" }, { ...gift, expiresAt: -1 }]) assert.throws(() => parseCreatedGift(value));
});

test("production action is explicitly off and API requests use the agreed selection-only routes", async () => {
  const component = await readFile(new URL("../src/GiftShareDialog.tsx", import.meta.url), "utf8");
  assert.match(component, /EXPERIMENTAL_GIFT_SENDER_ENABLED = false/);
  assert.doesNotMatch(component, /localStorage|sessionStorage|console\.|navigator\.share|createExperimentalGiftLink/);
  assert.match(component, /Share only books you have permission to share/);
  assert.match(component, /No DRM removal is provided/);
  assert.match(component, /not a guarantee of DRM detection/);
  const pane = await readFile(new URL("../src/PlayerPane.tsx", import.meta.url), "utf8");
  assert.match(pane, /EXPERIMENTAL_GIFT_SENDER_ENABLED && import\.meta\.env\.DEV && import\.meta\.env\.VITE_EXPERIMENTAL_GIFT_BROKER === "true"/);
  assert.match(pane, /!demoMode && !localMode && selectedBook\.source !== "device"/);
  const api = await readFile(new URL("../src/api.ts", import.meta.url), "utf8");
  assert.ok(api.includes("/api/books/${encodeURIComponent(bookId)}/gift-inventory"));
  assert.ok(api.includes('requestAt<unknown>(originalBase, originalToken, "/api/shares/selected"'));
  assert.match(api, /requestAt<void>\(originalBase, originalToken, `\/api\/shares\//);
  assert.match(api, /ignoreUnauthorized: true/);
});
