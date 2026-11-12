import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

test("experimental gift route previews before receive and imports only after accept", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage();
    const fragment = `#gift=${"a".repeat(32)}&broker=${encodeURIComponent("https://owner.example/")}`;
    await page.goto(`http://127.0.0.1:5199/test/gift-route.html${fragment}`);
    await page.getByRole("heading", { name: "Alex sent you a book" }).waitFor();
    assert.equal(await page.evaluate(() => window.giftPreviewCount), 1);
    assert.equal(await page.evaluate(() => window.giftReceiveCount), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem("operalibre.deviceLibrary.v1")), null);
    await page.getByRole("button", { name: "Skip animation" }).click();
    assert.equal(await page.evaluate(() => window.giftReceiveCount), 0);
    await page.getByRole("button", { name: "Accept book" }).click();
    await page.getByRole("heading", { name: "Your book is in your library" }).waitFor();
    assert.equal(await page.evaluate(() => window.giftReceiveCount), 1);
    const books = await page.evaluate(() => JSON.parse(localStorage.getItem("operalibre.deviceLibrary.v1")));
    assert.equal(books[0].source, "device");
    assert.equal(books[0].readingFile.extension, "epub");
    await page.goto(`http://127.0.0.1:5199/test/gift-route.html#gift=${"a".repeat(32)}&broker=http%3A%2F%2Funsafe.example`);
    await page.reload();
    await page.getByText("Invalid gift link").waitFor();
  } finally { await browser.close(); }
});
