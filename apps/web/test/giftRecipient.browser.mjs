import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.OPERALIBRE_GIFT_TEST_ORIGIN ?? "http://127.0.0.1:5199";

test("recipient claims and signals through Worker before verifying received chunks", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${origin}/test/gift-recipient-transport.html`);
    await page.getByRole("heading", { name: "Alex sent you a book" }).waitFor();
    assert.equal(await page.evaluate(() => window.stagedBytes), 0);
    await page.getByRole("button", { name: "Skip animation" }).click();
    assert.equal(await page.evaluate(() => window.stagedBytes), 0);
    await page.getByRole("button", { name: "Accept book" }).click();
    await page.getByRole("heading", { name: "Your book is in your library" }).waitFor();
    assert.equal(await page.evaluate(() => window.verifiedArchive), true);
    assert.equal(await page.evaluate(() => window.stagedBytes), 22);
    assert.equal(await page.evaluate(() => window.importCount), 1);
    await page.goto(`${origin}/test/gift-recipient-transport.html?unsupported`);
    await page.getByRole("button", { name: "Skip animation" }).click();
    await page.getByRole("button", { name: "Accept book" }).click();
    await page.getByRole("alert").getByText(/cannot import yet/).waitFor();
    assert.equal(await page.evaluate(() => window.claimCalls), 0);
    assert.equal(await page.evaluate(() => window.stagedBytes), 0);
    assert.equal(await page.evaluate(() => window.remoteDescriptionCalls), 0);
    assert.equal(await page.evaluate(() => window.importCount), 0);
    await page.goto(`${origin}/test/gift-recipient-transport.html?tampered-offer`);
    await page.getByRole("button", { name: "Skip animation" }).click();
    await page.getByRole("button", { name: "Accept book" }).click();
    await page.getByRole("heading", { name: "Gift unavailable" }).waitFor();
    assert.equal(await page.evaluate(() => window.remoteDescriptionCalls), 0);
    assert.equal(await page.evaluate(() => window.stagedBytes), 0);
    assert.equal(await page.evaluate(() => window.importCount), 0);
    await page.goto(`${origin}/test/gift-recipient-transport.html?tamper`);
    await page.getByRole("button", { name: "Skip animation" }).click();
    await page.getByRole("button", { name: "Accept book" }).click();
    await page.getByRole("heading", { name: "Gift unavailable" }).waitFor();
    assert.equal(await page.evaluate(() => window.verifiedArchive), false);
    assert.equal(await page.evaluate(() => window.importCount), 0);
    await page.goto(`${origin}/test/gift-recipient-transport.html?expired`);
    await page.getByRole("button", { name: "Skip animation" }).click();
    await page.getByRole("button", { name: "Accept book" }).click();
    await page.getByRole("alert").getByText(/expired/i).waitFor();
    assert.equal(await page.evaluate(() => window.stagedBytes), 0);
    await page.goto(`${origin}/test/gift-recipient-transport.html?revoked`);
    await page.getByRole("button", { name: "Skip animation" }).click();
    await page.getByRole("button", { name: "Accept book" }).click();
    await page.getByRole("heading", { name: "Gift unavailable" }).waitFor();
    assert.equal(await page.evaluate(() => window.importCount), 0);
  } finally { await browser.close(); }
});
