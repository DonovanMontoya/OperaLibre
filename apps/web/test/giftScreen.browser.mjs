import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";

test("gift unwrap, accept and decline require explicit action", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.goto("http://127.0.0.1:5199/test/gift-screen.html");
    await page.getByRole("heading", { name: "Alex sent you a book" }).waitFor();
    assert.equal(await page.evaluate(() => window.giftAcceptCount), 0);
    assert.equal(await page.getByText("I thought you would love this.").count(), 0);
    await page.getByRole("button", { name: "Unwrap your book gift" }).click();
    await page.getByRole("heading", { name: "The Little Book" }).waitFor();
    assert.equal(await page.getByText("I thought you would love this.").count(), 1);
    assert.equal(await page.getByText(/EPUB, Audiobook/).count(), 1);
    assert.equal(await page.evaluate(() => window.giftAcceptCount), 0);
    assert.equal(await page.locator(".gift-reveal").evaluate(node => getComputedStyle(node).animationName), "none");
    await page.getByRole("button", { name: "Accept book" }).click();
    await page.getByRole("heading", { name: "Your book is in your library" }).waitFor();
    assert.equal(await page.evaluate(() => window.giftAcceptCount), 1);
    await page.reload();
    await page.getByRole("button", { name: "Skip animation" }).click();
    await page.getByRole("button", { name: "Decline" }).click();
    await page.getByRole("heading", { name: "Gift declined" }).waitFor();
    assert.equal(await page.evaluate(() => window.giftAcceptCount), 0);
    await page.goto("http://127.0.0.1:5199/test/gift-screen.html?offline");
    await page.getByRole("alert").getByText(/offline/i).waitFor();
    assert.equal(await page.evaluate(() => window.giftAcceptCount), 0);
    await page.goto("http://127.0.0.1:5199/test/gift-screen.html?failure=expired");
    await page.getByRole("alert").getByText(/expired/i).waitFor();
    await page.goto("http://127.0.0.1:5199/test/gift-screen.html?failure=revoked");
    await page.getByRole("alert").getByText(/withdrawn/i).waitFor();
  } finally { await browser.close(); }
});
