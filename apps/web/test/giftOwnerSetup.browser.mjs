import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const origin = process.env.OPERALIBRE_GIFT_TEST_ORIGIN ?? "http://127.0.0.1:5199";

test("private sender retention is opt-in and recovery contacts the adapter only on explicit activation", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${origin}/test/gift-owner-setup.html?secure=1`);
    await page.getByLabel("Broker address").waitFor();
    await page.getByText("Server restarts", { exact: true }).click();
    await page.getByText("Maintenance", { exact: true }).click();
    const retain = page.getByRole("checkbox", { name: /Keep waiting gifts across restarts/ });
    const automatic = page.getByRole("checkbox", { name: /Resume them automatically at startup/ });
    assert.equal(await retain.isChecked(), false);
    assert.equal(await automatic.isChecked(), false);
    assert.equal(await automatic.isDisabled(), true);
    const recover = page.getByRole("button", { name: "Resume kept gifts" });
    assert.equal(await recover.isDisabled(), true);
    await retain.check();
    assert.equal(await automatic.isEnabled(), true);
    await automatic.check();
    await page.getByRole("checkbox", { name: /I run this broker/ }).check();
    await page.getByRole("button", { name: "Save gift setup" }).click();
    await page.getByRole("status").filter({ hasText: "Saved. Gifts can be sent" }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.ownerSetupCalls)).map(call => call.kind), ["load", "save"]);
    assert.equal((await page.evaluate(() => window.ownerSetupCalls)).find(call => call.kind === "save").input.autoRecoverSenders, true);
    assert.equal(await recover.isEnabled(), true);
    await recover.click();
    await page.getByRole("status").filter({ hasText: "1 started; 0 already active; 0 pending" }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.ownerSetupCalls)).map(call => call.kind), ["load", "save", "recover"]);
    const abandon=page.getByRole("button",{name:"Cancel kept gifts",exact:true});
    assert.equal(await abandon.isDisabled(),true);
    await page.getByRole("checkbox",{name:/Cancel every kept gift/}).check();
    await abandon.click();
    await page.getByRole("status").filter({hasText:"Kept gifts cancelled: 1"}).waitFor();
    assert.match(await page.getByRole("status").innerText(),/already accepted cannot be recalled/);
    assert.deepEqual((await page.evaluate(()=>window.ownerSetupCalls)).map(call=>call.kind),["load","save","recover","abandon"]);
  } finally { await browser.close(); }
});

test("owner setup shows redacted settings, omits retained secrets/connectivity, and cleans/removes explicitly", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/test/gift-owner-setup.html?secure=1`);
    await page.getByLabel("Broker address").waitFor();
    assert.deepEqual(await page.evaluate(() => window.ownerSetupCalls), [{ kind: "load" }]);
    assert.equal(await page.getByLabel("Broker owner secret").inputValue(), "");
    if (process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR) {
      await mkdir(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, "gift-owner-setup-mobile.png"), fullPage: true });
    }
    const confirm = page.getByRole("checkbox", { name: /I run this broker/ });
    await confirm.check();
    await page.getByRole("button", { name: "Save gift setup" }).click();
    await page.getByRole("status").filter({ hasText: "Saved. Gifts can be sent" }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.ownerSetupCalls)).find(call => call.kind === "save").input, { brokerOrigin: "https://broker.example", allowReaders: false, retainSenderState: false, autoRecoverSenders: false, ownerControlsBroker: true });
    await page.getByLabel("Broker owner secret").fill("bad"); await confirm.check();
    await page.getByRole("button", { name: "Save gift setup" }).click();
    await page.getByRole("status").filter({ hasText: "32–1024" }).waitFor();
    assert.equal(await page.getByLabel("Broker owner secret").inputValue(), "");
    await page.getByLabel("Broker owner secret").fill("OWNER_PRIVATE_SECRET_FOR_TEST_ONLY_1234");
    await page.getByRole("button", { name: "Save gift setup" }).click();
    await page.getByRole("status").filter({ hasText: "Saved. Gifts can be sent" }).waitFor();
    assert.equal(await page.getByLabel("Broker owner secret").inputValue(), "");
    assert.equal((await page.locator("body").innerText()).includes("OWNER_PRIVATE_SECRET_FOR_TEST_ONLY_1234"), false);
    assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)).includes("OWNER_PRIVATE_SECRET")), false);
    await page.getByText("Maintenance", { exact: true }).click();
    await page.getByRole("button", { name: "Retry broker cleanup" }).click();
    await page.getByRole("status").filter({ hasText: "cleanup completed: 1" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Remove gift setup" }).isDisabled(), true);
    await page.getByRole("checkbox", { name: /Remove the broker from this server/ }).check();
    await page.getByRole("button", { name: "Remove gift setup" }).click();
    await page.getByRole("status").filter({ hasText: "Server backups may still contain the secrets" }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.ownerSetupCalls)).map(call => call.kind), ["load", "save", "save", "cleanup", "delete"]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("HTTP setup UI and real API guards make no credential requests", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage(), requests = [];
    page.on("request", request => { if (request.url().includes("/api/admin/shares/config")) requests.push(request.url()); });
    await page.goto(`${origin}/test/gift-owner-setup.html?secure=0`);
    await page.getByRole("status").filter({ hasText: "over HTTPS" }).waitFor();
    assert.equal(await page.getByLabel("Broker owner secret").count(), 0);
    assert.deepEqual(await page.evaluate(() => window.testInsecureSetupCalls()), ["blocked", "blocked"]);
    assert.deepEqual(requests, []);
    assert.deepEqual(await page.evaluate(() => window.ownerSetupCalls), []);
  } finally { await browser.close(); }
});

test("changing server/sign-in after loading blocks saving private credentials until reload", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/test/gift-owner-setup.html?secure=1`);
    await page.getByLabel("Broker owner secret").fill("OWNER_PRIVATE_SECRET_FOR_TEST_ONLY_1234");
    await page.getByRole("checkbox", { name: /I run this broker/ }).check();
    await page.evaluate(() => window.ownerSetupChangeContext());
    await page.getByRole("button", { name: "Save gift setup" }).click();
    await page.getByRole("status").filter({ hasText: "connected server or sign-in changed" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.ownerSetupCalls), [{ kind: "load" }]);
    assert.equal((await page.locator("body").innerText()).includes("OWNER_PRIVATE_SECRET_FOR_TEST_ONLY_1234"), false);
  } finally { await browser.close(); }
});

test("advanced connectivity is opt-in, clears private inputs, and posts only explicit UDP replacement", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/test/gift-owner-setup.html?secure=1`);
    await page.getByLabel("Broker address").waitFor();
    await page.getByText("Connection servers", { exact: true }).click();
    const change = page.getByRole("checkbox", { name: "Replace the connection servers" });
    assert.equal(await change.isChecked(), false);
    await change.check();
    assert.ok(await change.evaluate(input => input.closest("label").getBoundingClientRect().height >= 44));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR) {
      await mkdir(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, "gift-owner-connectivity-mobile.png"), fullPage: true });
    }
    const turn = page.getByLabel("TURN relay (optional)");
    const password = page.getByLabel("TURN shared secret");
    await page.getByLabel("STUN server (optional)").fill("stun:stun.example:3478");
    await turn.fill("turn:relay.example:3478?transport=udp");
    await password.fill("PRIVATE_COTURN_SECRET_FOR_TEST_1234");
    await turn.fill("turn:changed-relay.example:3478?transport=udp");
    assert.equal(await password.inputValue(), "");
    await password.fill("PRIVATE_COTURN_SECRET_FOR_TEST_1234");
    await change.uncheck(); await change.check();
    assert.equal(await password.inputValue(), "");
    await page.getByLabel("Broker address").fill("not-a-url");
    await page.getByLabel("Broker owner secret").fill("OWNER_PRIVATE_SECRET_FOR_TEST_ONLY_1234");
    await password.fill("PRIVATE_COTURN_SECRET_FOR_TEST_1234");
    await page.getByRole("checkbox", { name: /I run this broker/ }).check();
    await page.getByRole("button", { name: "Save gift setup" }).click();
    await page.getByRole("status").filter({ hasText: "Confirm an owner-controlled HTTPS broker origin" }).waitFor();
    assert.equal(await password.inputValue(), "");
    assert.equal(await page.getByLabel("Broker owner secret").inputValue(), "");
    await page.getByLabel("Broker address").fill("https://broker.example");
    await page.getByLabel("STUN server (optional)").fill("stun:stun.example:3478");
    await turn.fill("turn:relay.example:3478?transport=tcp");
    await password.fill("PRIVATE_COTURN_SECRET_FOR_TEST_1234");
    await page.getByLabel("Broker owner secret").fill("OWNER_PRIVATE_SECRET_FOR_TEST_ONLY_1234");
    await page.getByRole("checkbox", { name: /Allow the TURN relay/ }).check();
    await page.getByRole("checkbox", { name: /I run this broker/ }).check();
    assert.deepEqual((await page.evaluate(() => window.ownerSetupCalls)).map(call => call.kind), ["load"]);
    await page.getByRole("button", { name: "Save gift setup" }).click();
    await page.getByRole("status").filter({ hasText: "TCP/TLS" }).waitFor();
    assert.equal(await password.inputValue(), "");
    assert.equal(await page.getByLabel("Broker owner secret").inputValue(), "");
    assert.equal((await page.evaluate(() => window.ownerSetupCalls)).length, 1);
    await turn.fill("turn:relay.example:3478?transport=udp");
    await page.getByRole("button", { name: "Save gift setup" }).click();
    await page.getByRole("status").filter({ hasText: "Re-enter the full coturn" }).waitFor();
    await password.fill("PRIVATE_COTURN_SECRET_FOR_TEST_1234");
    await page.getByRole("checkbox", { name: /Always use the relay/ }).check();
    await page.getByRole("button", { name: "Save gift setup" }).click();
    await page.getByRole("status").filter({ hasText: "Saved. Gifts can be sent" }).waitFor();
    const save = (await page.evaluate(() => window.ownerSetupCalls)).find(call => call.kind === "save");
    assert.deepEqual(save.input, { brokerOrigin: "https://broker.example", allowReaders: false, retainSenderState: false, autoRecoverSenders: false, ownerControlsBroker: true, connectivity: { iceServers: [{ urls: ["stun:stun.example:3478"] }, { urls: ["turn:relay.example:3478?transport=udp"], turnRestSecret: "PRIVATE_COTURN_SECRET_FOR_TEST_1234" }], relayAllowed: true, requireRelay: true } });
    assert.equal(await change.isChecked(), false);
    assert.equal(await password.count(), 0);
    assert.equal((await page.locator("body").innerText()).includes("PRIVATE_COTURN_SECRET_FOR_TEST_1234"), false);
    assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)).includes("PRIVATE_COTURN_SECRET")), false);
    const button = page.getByRole("button", { name: "Save gift setup" });
    assert.ok((await button.boundingBox()).height >= 44);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("a fresh server is set up by pasting one Cloudflare token, which is never kept on the page", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${origin}/test/gift-owner-setup.html?secure=1&fresh=1`);
    const token = page.getByLabel("Cloudflare API token");
    await token.waitFor();
    const link = await page.getByRole("link", { name: "Create a Cloudflare token" }).getAttribute("href");
    assert.match(link, /^https:\/\/dash\.cloudflare\.com\/profile\/api-tokens\?/);
    assert.deepEqual(JSON.parse(new URL(link).searchParams.get("permissionGroupKeys")), [{ key: "workers_scripts", type: "edit" }]);
    // The manual form stays available, but out of the way.
    assert.equal(await page.getByLabel("Broker owner secret").isVisible(), false);
    const setUp = page.getByRole("button", { name: "Set up gifts" });
    await setUp.click();
    await page.getByRole("status").filter({ hasText: "Paste the Cloudflare API token first" }).waitFor();
    await token.fill("A_TOKEN_CLOUDFLARE_WILL_REFUSE_1234");
    await setUp.click();
    await page.getByRole("status").filter({ hasText: "did not accept this token" }).waitFor();
    assert.equal(await token.inputValue(), "");
    await token.fill("  CLOUDFLARE_TOKEN_FOR_TEST_ONLY_1234 ");
    await setUp.click();
    await page.getByRole("status").filter({ hasText: "Your broker is installed" }).waitFor();
    assert.equal(await page.getByLabel("Broker address").inputValue(), "https://operalibre-share-broker.home.workers.dev");
    const installs = (await page.evaluate(() => window.ownerSetupCalls)).filter(call => call.kind === "install");
    assert.deepEqual(installs.at(-1).install, { apiToken: "CLOUDFLARE_TOKEN_FOR_TEST_ONLY_1234" });
    assert.equal((await page.locator("body").innerText()).includes("CLOUDFLARE_TOKEN_FOR_TEST_ONLY"), false);
    assert.equal(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes("CLOUDFLARE_TOKEN")), false);
    await page.getByText("Update or reinstall the broker", { exact: true }).first().click();
    await page.getByRole("button", { name: "Reinstall broker" }).waitFor();
  } finally { await browser.close(); }
});
