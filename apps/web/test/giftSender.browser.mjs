import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const origin = process.env.OPERALIBRE_GIFT_TEST_ORIGIN ?? "http://127.0.0.1:5199";
const inventory = { bookId: "server-book", title: "The server's trusted title", maxBytes: 5000, assets: [
  { id: "metadata", kind: "metadata", fileName: "metadata.json", sizeBytes: 10, available: true },
  { id: "ebook", kind: "ebook", fileName: "book.epub", sizeBytes: 100, available: true },
  { id: "cover", kind: "cover", fileName: "cover.jpg", sizeBytes: 20, available: true },
  { id: "audio", kind: "audio", fileName: "audio.m4b", sizeBytes: 1000, available: true },
  { id: "alignment", kind: "alignment", fileName: "sync.json", sizeBytes: 30, available: true, requiresAssetIds: ["ebook", "audio"] },
  { id: "protected", kind: "ebook", fileName: "protected.epub", sizeBytes: 100, available: false, disabledReason: "DRM-protected; unavailable." },
], defaultSelectedAssetIds: ["metadata", "ebook", "cover", "audio"] };
const gift = { giftUrl: "https://owner.example/gift#gift=private-server-capability", expiresAt: 2000000000, managementToken: "PRIVATE_MANAGEMENT_TOKEN__________" };

async function fixture(browser, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const requests = [], errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/books/server-book/gift-inventory", async route => {
    requests.push({ type: "inventory", method: route.request().method() });
    if (options.inventory) return options.inventory(route);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(inventory) });
  });
  await page.route("**/api/shares/selected", async route => {
    requests.push({ type: "create", method: route.request().method(), body: route.request().postDataJSON() });
    if (options.create) return options.create(route);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gift) });
  });
  return { page, context, requests, errors };
}

test("changing servers cannot redirect a pending private note or selection", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const f = await fixture(browser);
    await f.page.goto(`${origin}/test/gift-sender.html?enabled=1`);
    await f.page.getByRole("button", { name: "Share gift" }).click();
    await f.page.getByRole("heading", { name: inventory.title }).waitFor();
    await f.page.getByLabel("Personal message (optional)").fill("Private note for the original server");
    await f.page.evaluate(() => window.senderSwitchServer("https://different-server.example", "new-test-session"));
    await f.page.getByRole("button", { name: "Create gift link" }).click();
    await f.page.getByText(/connected server or sign-in changed/).waitFor();
    assert.equal(f.requests.filter(request => request.type === "create").length, 0);
    assert.deepEqual(f.errors, []);
    await f.context.close();
  } finally { await browser.close(); }
});

test("disabled sender makes no request; opt-in selection uses actual typed API and returns only server link", { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const f = await fixture(browser);
    await f.page.goto(`${origin}/test/gift-sender.html?enabled=0`);
    await f.page.getByRole("heading", { name: "Book details fixture" }).waitFor();
    assert.equal(await f.page.getByRole("button", { name: "Share gift" }).count(), 0);
    assert.deepEqual(f.requests, []);
    await f.page.goto(`${origin}/test/gift-sender.html?enabled=1`);
    assert.deepEqual(f.requests, []);
    await f.page.getByRole("button", { name: "Share gift" }).click();
    await f.page.getByRole("heading", { name: inventory.title }).waitFor();
    // The existing API may migrate its empty credential vault on first use;
    // gift selections, notes and returned capabilities must not be persisted.
    const storedBefore = await f.page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    assert.deepEqual(f.requests, [{ type: "inventory", method: "GET" }]);
    assert.equal(await f.page.getByRole("checkbox", { name: /metadata.json/ }).isChecked(), true);
    assert.equal(await f.page.getByRole("checkbox", { name: /metadata.json/ }).isDisabled(), true);
    assert.equal(await f.page.getByRole("checkbox", { name: /book.epub/ }).isChecked(), true);
    assert.equal(await f.page.getByRole("checkbox", { name: /cover.jpg/ }).isChecked(), true);
    assert.equal(await f.page.getByRole("checkbox", { name: /audio.m4b/ }).isChecked(), false);
    assert.equal(await f.page.getByRole("checkbox", { name: /sync.json/ }).isDisabled(), true);
    assert.equal(await f.page.getByRole("checkbox", { name: /protected.epub/ }).isDisabled(), true);
    await f.page.getByText(/Selected asset size: 130 B/).waitFor();
    if (process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR) {
      await mkdir(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, { recursive: true });
      await f.page.screenshot({ path: path.join(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, "gift-sender-selection-mobile.png"), fullPage: true });
    }
    await f.page.getByLabel("Personal message (optional)").fill("🎁".repeat(1001));
    assert.equal(await f.page.getByRole("button", { name: "Create gift link" }).isDisabled(), true);
    await f.page.getByLabel("Personal message (optional)").fill("I thought you'd enjoy this. <script>plain text</script>");
    await f.page.getByRole("checkbox", { name: /audio.m4b/ }).check();
    await f.page.getByRole("checkbox", { name: /cover.jpg/ }).uncheck();
    await f.page.getByRole("button", { name: "Create gift link" }).click();
    await f.page.getByRole("heading", { name: "Your gift link" }).waitFor();
    assert.equal(await f.page.getByLabel("Private gift URL").inputValue(), gift.giftUrl);
    assert.equal((await f.page.locator("body").innerText()).includes(gift.managementToken), false);
    const create = f.requests.find(request => request.type === "create");
    assert.equal(create.method, "POST");
    assert.deepEqual(create.body, { bookId: "server-book", selectedAssetIds: ["metadata", "ebook", "audio"], personalMessage: "I thought you'd enjoy this. <script>plain text</script>", expiresInSeconds: 900 });
    assert.equal(JSON.stringify(create.body).includes("sha256"), false);
    assert.equal(await f.page.evaluate(() => JSON.stringify(Object.entries(localStorage))), storedBefore);
    assert.deepEqual(f.errors, []);
    await f.page.getByRole("button", { name: "Done" }).click();
    assert.equal(await f.page.getByRole("button", { name: "Share gift" }).evaluate(button => document.activeElement === button), true);
    await f.context.close();
  } finally { await browser.close(); }
});

test("revocation stays bound to original server and authentication after a server switch", { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const f = await fixture(browser);
    const revoked = [];
    await f.page.route("**/api/shares/PRIVATE_MANAGEMENT_TOKEN__________", async route => {
      revoked.push({ url: route.request().url(), method: route.request().method(), authorization: (await route.request().allHeaders()).authorization });
      if (revoked.length === 1) await route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ message: "original auth expired" }) });
      else await route.fulfill({ status: 204 });
    });
    await f.page.goto(`${origin}/test/gift-sender.html?enabled=1`);
    await f.page.evaluate(origin => window.senderSwitchServer(origin, "original-sender-auth"), origin);
    await f.page.getByRole("button", { name: "Share gift" }).click();
    await f.page.getByRole("heading", { name: inventory.title }).waitFor();
    await f.page.getByRole("button", { name: "Create gift link" }).click();
    await f.page.getByRole("heading", { name: "Your gift link" }).waitFor();
    await f.page.evaluate(() => window.senderSwitchServer("https://new-server.example", "new-server-auth"));
    await f.page.getByRole("button", { name: "Revoke gift", exact: true }).click();
    await f.page.getByRole("alert").filter({ hasText: "Revocation could not be confirmed by the original server" }).waitFor();
    assert.deepEqual(revoked, [{ url: `${origin}/api/shares/${gift.managementToken}`, method: "DELETE", authorization: "Bearer original-sender-auth" }]);
    assert.equal(await f.page.evaluate(() => window.senderUnauthorizedCount), 0);
    assert.equal((await f.page.locator("body").innerText()).includes(gift.managementToken), false);
    assert.equal((await f.page.getByLabel("Private gift URL").inputValue()).includes(gift.managementToken), false);
    assert.equal(await f.page.evaluate(token => JSON.stringify(Object.entries(localStorage)).includes(token), gift.managementToken), false);
    await f.page.getByRole("button", { name: "Revoke gift", exact: true }).click();
    await f.page.getByRole("button", { name: "Gift revoked", exact: true }).waitFor();
    assert.equal(await f.page.getByRole("button", { name: "Gift revoked", exact: true }).isDisabled(), true);
    assert.equal(await f.page.getByRole("button", { name: "Copy gift link" }).isDisabled(), true);
    await f.page.getByRole("status").filter({ hasText: "Downloaded or offline copies cannot be recalled" }).waitFor();
    assert.equal(revoked.length, 2);
    assert.deepEqual(revoked[1], revoked[0]);
    assert.deepEqual(f.errors, []);
    await f.context.close();
  } finally { await browser.close(); }
});

test("load failure and unavailable creation never fabricate a gift link", { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    let fail = true;
    const f = await fixture(browser, {
      inventory: async route => route.fulfill({ status: fail ? 503 : 200, contentType: "application/json", body: JSON.stringify(fail ? { message: "disabled" } : inventory) }),
      create: async route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "runtime unconfigured" }) }),
    });
    await f.page.goto(`${origin}/test/gift-sender.html?enabled=1`);
    await f.page.getByRole("button", { name: "Share gift" }).click();
    await f.page.getByRole("alert").filter({ hasText: "Gift inventory is unavailable" }).waitFor();
    assert.equal(f.requests.filter(request => request.type === "create").length, 0);
    fail = false;
    await f.page.getByRole("button", { name: "Reload contents" }).click();
    await f.page.getByRole("heading", { name: inventory.title }).waitFor();
    await f.page.getByRole("button", { name: "Create gift link" }).click();
    await f.page.getByRole("alert").filter({ hasText: "Gift creation could not be confirmed" }).waitFor();
    assert.equal(await f.page.getByLabel("Private gift URL").count(), 0);
    await f.page.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.deepEqual(f.errors, []);
    await f.context.close();
  } finally { await browser.close(); }
});

test("cancelled in-flight creation ignores a late valid response and does not claim revocation", { timeout: 20000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const f = await fixture(browser, { create: async route => { await waiting; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(gift) }).catch(() => {}); } });
    await f.page.goto(`${origin}/test/gift-sender.html?enabled=1`);
    await f.page.getByRole("button", { name: "Share gift" }).click();
    await f.page.getByRole("heading", { name: inventory.title }).waitFor();
    await f.page.getByRole("button", { name: "Create gift link" }).click();
    await f.page.getByRole("button", { name: "Stop waiting", exact: true }).click();
    release();
    await f.page.getByRole("alert").filter({ hasText: "Stopping does not revoke it" }).waitFor();
    assert.equal(await f.page.getByLabel("Private gift URL").count(), 0);
    assert.equal(f.requests.filter(request => request.type === "create").length, 1);
    await f.page.keyboard.press("Escape");
    assert.equal(await f.page.getByRole("dialog").count(), 0);
    assert.deepEqual(f.errors, []);
    await f.context.close();
  } finally { await browser.close(); }
});
