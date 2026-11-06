import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const fragment = `gift=${"a".repeat(64)}&broker=${encodeURIComponent("https://owner.example")}&key=${"b".repeat(43)}&signing=${"c".repeat(43)}&id=gift____________`;
const uri = `operalibre://gift#${fragment}`;
const base = `${process.env.OPERALIBRE_GIFT_TEST_ORIGIN ?? "http://127.0.0.1:5199"}/test/gift-native-links.html`;

test("native launch boundary precedes onboarding and never receives content without acceptance", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
    const apiRequests = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) apiRequests.push(request.url()); });
    await page.goto(`${base}?enabled=1`);
    await page.getByRole("status", { name: "" }).filter({ hasText: "Opening OperaLibre" }).waitFor();
    await page.waitForFunction(() => window.nativeGiftTest.metrics.launches === 1);
    assert.equal(await page.getByRole("heading", { name: "Server onboarding fallback" }).count(), 0);
    await page.evaluate(uri => window.nativeGiftTest.finish(uri), uri);
    await page.getByRole("heading", { name: "Alex sent you a book" }).waitFor();
    assert.equal(await page.evaluate(() => window.nativeGiftTest.metrics.fallbackMounts), 0);
    assert.equal(await page.evaluate(() => window.nativeGiftTest.metrics.receives), 0);
    assert.equal(await page.evaluate(() => window.nativeGiftTest.metrics.lastGiftId), "gift____________");
    assert.deepEqual(apiRequests, []);
    assert.equal(await page.evaluate(() => localStorage.length), 0);
    if (process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR) {
      await mkdir(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, "gift-wrapped-mobile.png"), fullPage: true });
    }
    await page.getByRole("button", { name: "Skip animation" }).click();
    const acceptBounds = await page.getByRole("button", { name: "Accept book" }).boundingBox();
    assert.ok(acceptBounds && acceptBounds.height >= 44, "mobile acceptance needs a usable touch target");
    if (process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, "gift-revealed-mobile.png"), fullPage: true });
    await page.getByRole("button", { name: "Decline" }).click();
    await page.getByRole("heading", { name: "Gift declined" }).waitFor();
    await page.getByRole("button", { name: "Done" }).click();
    await page.getByRole("heading", { name: "Server onboarding fallback" }).waitFor();
    assert.equal(await page.evaluate(() => window.nativeGiftTest.metrics.receives), 0);
    // A warm launch is independent of server setup and invalid URIs do nothing.
    await page.evaluate(uri => window.nativeGiftTest.open(uri), uri.replace("gift#", "gift?server=evil#"));
    assert.equal(await page.getByRole("heading", { name: "Server onboarding fallback" }).count(), 1);
    await page.evaluate(uri => window.nativeGiftTest.open(uri), uri);
    await page.getByRole("heading", { name: "Alex sent you a book" }).waitFor();
    assert.deepEqual(apiRequests, []);
  } finally { await browser.close(); }
});

test("disabled gift gate performs no native lookup and rejects query URI injection", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}?enabled=0#${fragment}`);
    await page.getByRole("heading", { name: "Server onboarding fallback" }).waitFor();
    assert.equal(await page.evaluate(() => window.nativeGiftTest.metrics.registrations), 0);
    assert.equal(await page.evaluate(() => window.nativeGiftTest.metrics.launches), 0);
    assert.equal(await page.evaluate(() => window.nativeGiftTest.metrics.previews), 0);
    await page.goto(`${base}?enabled=1`);
    await page.waitForFunction(() => window.nativeGiftTest.metrics.launches === 1);
    await page.evaluate(uri => window.nativeGiftTest.finish(uri), uri.replace("gift#", "gift?gift=malicious#"));
    await page.getByRole("heading", { name: "Server onboarding fallback" }).waitFor();
    assert.equal(await page.evaluate(() => window.nativeGiftTest.metrics.previews), 0);
  } finally { await browser.close(); }
});
