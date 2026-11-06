import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const origin = process.env.OPERALIBRE_GIFT_TEST_ORIGIN ?? "http://127.0.0.1:5199";

test("closing the reader aborts an in-flight private map fetch without activating follow", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage(), requests = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url()); });
    await page.goto(`${origin}/test/gift-local-reader.html?failure=cancelled`);
    await page.waitForFunction(() => window.giftReaderReadStarted === true);
    assert.equal(await page.evaluate(() => window.giftReaderStatus.following), false);
    await page.evaluate(() => window.giftReaderClose());
    await page.waitForFunction(() => window.giftReaderReadAborted === true);
    assert.equal(await page.evaluate(() => window.giftReaderStatus.following), false);
    assert.deepEqual(requests, []);
  } finally { await browser.close(); }
});

test("accepted receipt-bound gift follows its actual local EPUB across tracks with no server requests", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }), requests = [], errors = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url()); });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/test/gift-local-reader.html`);
    await page.waitForFunction(() => window.giftReaderStatus?.mapLoaded === true || window.giftReaderStatus?.phase === "failed");
    assert.equal(await page.evaluate(() => window.giftReaderStatus.error), undefined);
    assert.equal(await page.locator("#gift-reader-mode").textContent(), "sentence");
    assert.equal(await page.locator("#gift-reader-publisher").textContent(), "Publisher");
    assert.equal(await page.evaluate(() => window.giftReaderStatus.following), true);
    assert.equal(await page.evaluate(() => window.giftReaderStatus.otherAvailable), false);
    await page.getByRole("button", { name: "Follow narration", exact: true }).first().click();
    await page.locator(".readalong-highlight").first().waitFor({ state: "attached" });
    assert.equal(await page.evaluate(() => window.giftReaderStatus.fragment), 0);
    await page.evaluate(() => window.giftReaderSeek(1.3));
    await page.waitForFunction(() => window.giftReaderStatus.fragment === 1);
    await page.waitForFunction(() => [...document.querySelectorAll("iframe")].some(frame => frame.contentDocument?.body?.textContent?.includes("Second sentence.")));
    await page.locator(".readalong-highlight").first().waitFor({ state: "attached" });
    await page.evaluate(() => window.giftReaderSeek(2.3));
    await page.waitForFunction(() => window.giftReaderStatus.fragment === 2);
    await page.locator(".readalong-highlight").first().waitFor({ state: "attached" });
    assert.deepEqual(requests, []); assert.deepEqual(errors, []);
    const shelf = await page.evaluate(() => JSON.parse(localStorage.getItem("operalibre.deviceLibrary.v1")));
    assert.equal(shelf[0].durationSeconds, 3); assert.equal(shelf[0].source, "device");
    assert.equal(shelf[0].localSyncMap.audio.length, 2);
  } finally { await browser.close(); }
});

for (const failure of ["tampered", "missing"]) test(`${failure} local map never activates narration or advertises sentence follow`, { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage(), requests = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url()); });
    await page.goto(`${origin}/test/gift-local-reader.html?failure=${failure}`);
    await page.waitForFunction(() => window.giftReaderStatus?.mapChecked === true || window.giftReaderStatus?.phase === "failed");
    const status = await page.evaluate(() => window.giftReaderStatus);
    assert.equal(status.error, undefined); assert.equal(status.mapLoaded, false);
    assert.equal(status.following, false); assert.equal(status.available, false); assert.equal(status.otherAvailable, false);
    assert.equal(await page.locator("#gift-reader-mode").textContent(), "chapter");
    assert.equal(await page.locator(".readalong-highlight").count(), 0);
    assert.deepEqual(requests, []);
  } finally { await browser.close(); }
});

test("the actual Rust-selected ZIP reaches real EPUB sentence highlighting without server/account", { skip: !process.env.OPERALIBRE_GIFT_ALIGNMENT_ARCHIVE_FIXTURE, timeout: 20000 }, async () => {
  const body = readFileSync(process.env.OPERALIBRE_GIFT_ALIGNMENT_ARCHIVE_FIXTURE, "utf8"), fixture = JSON.parse(body);
  const map = JSON.parse(Buffer.from(fixture.entries.find(entry => entry.name === "alignment.sync.json").dataBase64, "base64").toString("utf8"));
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } }), requests = [], errors = [];
    await page.route("**/test/gift-alignment-actual.json", route => route.fulfill({ contentType: "application/json", body }));
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.push(request.url()); });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/test/gift-local-reader.html?actual=1`);
    await page.waitForFunction(() => window.giftReaderStatus?.mapLoaded || window.giftReaderStatus?.phase === "failed");
    assert.equal(await page.evaluate(() => window.giftReaderStatus.error), undefined);
    await page.evaluate(seconds => window.giftReaderSeek(seconds), (map.fragments[0].startSeconds + map.fragments[0].endSeconds) / 2);
    await page.getByRole("button", { name: "Follow narration", exact: true }).first().click();
    await page.locator(".readalong-highlight").first().waitFor({ state: "attached" });
    for (let index = 0; index < map.fragments.length; index++) {
      const fragment = map.fragments[index];
      await page.evaluate(seconds => window.giftReaderSeek(seconds), (fragment.startSeconds + fragment.endSeconds) / 2);
      await page.waitForFunction(expected => window.giftReaderStatus.fragment === expected, index);
      await page.waitForFunction(text => [...document.querySelectorAll("iframe")].some(frame => frame.contentDocument?.body?.textContent?.includes(text)), fragment.text);
      await page.locator(".readalong-highlight").first().waitFor({ state: "attached" });
    }
    if (process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR) {
      await mkdir(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, "gift-local-readalong-desktop.png"), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator(".readalong-highlight").first().waitFor({ state: "attached" });
      await page.screenshot({ path: path.join(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, "gift-local-readalong-mobile.png"), fullPage: true });
    }
    assert.deepEqual(requests, []); assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
