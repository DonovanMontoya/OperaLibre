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
    await page.getByRole("button", { name: "Load saved setup" }).click();
    const retain = page.getByRole("checkbox", { name: /Retain private selected archives/ });
    assert.equal(await retain.isChecked(), false);
    const recover = page.getByRole("button", { name: "Recover retained gift senders" });
    assert.equal(await recover.isDisabled(), true);
    await retain.check();
    await page.getByRole("checkbox", { name: /I control this broker/ }).check();
    await page.getByRole("button", { name: "Save private server configuration" }).click();
    await page.getByRole("status").filter({ hasText: "Configuration saved privately" }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.ownerSetupCalls)).map(call => call.kind), ["load", "save"]);
    assert.equal(await recover.isEnabled(), true);
    await recover.click();
    await page.getByRole("status").filter({ hasText: "1 started; 0 already active; 0 pending" }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.ownerSetupCalls)).map(call => call.kind), ["load", "save", "recover"]);
    assert.match(await page.getByRole("status").innerText(), /does not prove a recipient/);
    const abandon=page.getByRole("button",{name:"Abandon retained gifts",exact:true});
    assert.equal(await abandon.isDisabled(),true);
    await page.getByRole("checkbox",{name:/Revoke all retained gifts on this broker/}).check();
    await abandon.click();
    await page.getByRole("status").filter({hasText:"Retained gifts revoked: 1"}).waitFor();
    assert.match(await page.getByRole("status").innerText(),/Recipient copies and external backups cannot be recalled/);
    assert.deepEqual((await page.evaluate(()=>window.ownerSetupCalls)).map(call=>call.kind),["load","save","recover","abandon"]);
  } finally { await browser.close(); }
});

test("owner setup loads only explicitly, omits retained secrets/connectivity, and cleans/removes explicitly", { timeout: 15000 }, async () => {
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/test/gift-owner-setup.html?secure=1`);
    await page.getByRole("button", { name: "Load saved setup" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.ownerSetupCalls), []);
    await page.getByRole("button", { name: "Load saved setup" }).click();
    await page.getByLabel("Saved broker HTTPS origin").waitFor();
    assert.equal(await page.getByLabel("New broker owner secret").inputValue(), "");
    if (process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR) {
      await mkdir(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, "gift-owner-setup-mobile.png"), fullPage: true });
    }
    const confirm = page.getByRole("checkbox", { name: /I control this broker/ });
    await confirm.check();
    await page.getByRole("button", { name: "Save private server configuration" }).click();
    await page.getByRole("status").filter({ hasText: "Configuration saved privately" }).waitFor();
    assert.deepEqual((await page.evaluate(() => window.ownerSetupCalls)).find(call => call.kind === "save").input, { brokerOrigin: "https://broker.example", allowReaders: false, retainSenderState: false, ownerControlsBroker: true });
    await page.getByLabel("New broker owner secret").fill("bad"); await confirm.check();
    await page.getByRole("button", { name: "Save private server configuration" }).click();
    await page.getByRole("status").filter({ hasText: "32–1024" }).waitFor();
    assert.equal(await page.getByLabel("New broker owner secret").inputValue(), "");
    await page.getByLabel("New broker owner secret").fill("OWNER_PRIVATE_SECRET_FOR_TEST_ONLY_1234");
    await page.getByRole("button", { name: "Save private server configuration" }).click();
    await page.getByRole("status").filter({ hasText: "Configuration saved privately" }).waitFor();
    assert.equal(await page.getByLabel("New broker owner secret").inputValue(), "");
    assert.equal((await page.locator("body").innerText()).includes("OWNER_PRIVATE_SECRET_FOR_TEST_ONLY_1234"), false);
    assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)).includes("OWNER_PRIVATE_SECRET")), false);
    await page.getByRole("button", { name: "Retry cleanup using saved credentials" }).click();
    await page.getByRole("status").filter({ hasText: "cleanup completed: 1" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Remove saved gift setup" }).isDisabled(), true);
    await page.getByRole("checkbox", { name: /I understand removal/ }).check();
    await page.getByRole("button", { name: "Remove saved gift setup" }).click();
    await page.getByRole("status").filter({ hasText: "Server backups may still contain credentials" }).waitFor();
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
    await page.getByRole("button", { name: "Load saved setup" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Load saved setup" }).isDisabled(), true);
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
    await page.getByRole("button", { name: "Load saved setup" }).click();
    await page.getByLabel("New broker owner secret").fill("OWNER_PRIVATE_SECRET_FOR_TEST_ONLY_1234");
    await page.getByRole("checkbox", { name: /I control this broker/ }).check();
    await page.evaluate(() => window.ownerSetupChangeContext());
    await page.getByRole("button", { name: "Save private server configuration" }).click();
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
    await page.getByRole("button", { name: "Load saved setup" }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.ownerSetupCalls), []);
    await page.getByRole("button", { name: "Load saved setup" }).click();
    const change = page.getByRole("checkbox", { name: "Change ICE (replace all saved connectivity entries)" });
    assert.equal(await change.isChecked(), false);
    await change.check();
    assert.ok(await change.evaluate(input => input.closest("label").getBoundingClientRect().height >= 44));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR) {
      await mkdir(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.OPERALIBRE_GIFT_SCREENSHOT_DIR, "gift-owner-connectivity-mobile.png"), fullPage: true });
    }
    const turn = page.getByLabel("UDP coturn TURN URL (optional)");
    const password = page.getByLabel("Private coturn TURN REST shared secret");
    await page.getByLabel("UDP STUN URL (optional)").fill("stun:stun.example:3478");
    await turn.fill("turn:relay.example:3478?transport=udp");
    await password.fill("PRIVATE_COTURN_SECRET_FOR_TEST_1234");
    await turn.fill("turn:changed-relay.example:3478?transport=udp");
    assert.equal(await password.inputValue(), "");
    await password.fill("PRIVATE_COTURN_SECRET_FOR_TEST_1234");
    await change.uncheck(); await change.check();
    assert.equal(await password.inputValue(), "");
    await page.getByLabel("Saved broker HTTPS origin").fill("not-a-url");
    await page.getByLabel("New broker owner secret").fill("OWNER_PRIVATE_SECRET_FOR_TEST_ONLY_1234");
    await password.fill("PRIVATE_COTURN_SECRET_FOR_TEST_1234");
    await page.getByRole("checkbox", { name: /I control this broker/ }).check();
    await page.getByRole("button", { name: "Save private server configuration" }).click();
    await page.getByRole("status").filter({ hasText: "Confirm an owner-controlled HTTPS broker origin" }).waitFor();
    assert.equal(await password.inputValue(), "");
    assert.equal(await page.getByLabel("New broker owner secret").inputValue(), "");
    await page.getByLabel("Saved broker HTTPS origin").fill("https://broker.example");
    await page.getByLabel("UDP STUN URL (optional)").fill("stun:stun.example:3478");
    await turn.fill("turn:relay.example:3478?transport=tcp");
    await password.fill("PRIVATE_COTURN_SECRET_FOR_TEST_1234");
    await page.getByLabel("New broker owner secret").fill("OWNER_PRIVATE_SECRET_FOR_TEST_ONLY_1234");
    await page.getByRole("checkbox", { name: /Allow this owner's UDP TURN relay/ }).check();
    await page.getByRole("checkbox", { name: /I control this broker/ }).check();
    assert.deepEqual((await page.evaluate(() => window.ownerSetupCalls)).map(call => call.kind), ["load"]);
    await page.getByRole("button", { name: "Save private server configuration" }).click();
    await page.getByRole("status").filter({ hasText: "TCP/TLS" }).waitFor();
    assert.equal(await password.inputValue(), "");
    assert.equal(await page.getByLabel("New broker owner secret").inputValue(), "");
    assert.equal((await page.evaluate(() => window.ownerSetupCalls)).length, 1);
    await turn.fill("turn:relay.example:3478?transport=udp");
    await page.getByRole("button", { name: "Save private server configuration" }).click();
    await page.getByRole("status").filter({ hasText: "Re-enter the full coturn" }).waitFor();
    await password.fill("PRIVATE_COTURN_SECRET_FOR_TEST_1234");
    await page.getByRole("checkbox", { name: "Require relay rather than direct peers" }).check();
    await page.getByRole("button", { name: "Save private server configuration" }).click();
    await page.getByRole("status").filter({ hasText: "Configuration saved privately" }).waitFor();
    const save = (await page.evaluate(() => window.ownerSetupCalls)).find(call => call.kind === "save");
    assert.deepEqual(save.input, { brokerOrigin: "https://broker.example", allowReaders: false, retainSenderState: false, ownerControlsBroker: true, connectivity: { iceServers: [{ urls: ["stun:stun.example:3478"] }, { urls: ["turn:relay.example:3478?transport=udp"], turnRestSecret: "PRIVATE_COTURN_SECRET_FOR_TEST_1234" }], relayAllowed: true, requireRelay: true } });
    assert.equal(await change.isChecked(), false);
    assert.equal(await password.count(), 0);
    assert.equal((await page.locator("body").innerText()).includes("PRIVATE_COTURN_SECRET_FOR_TEST_1234"), false);
    assert.equal(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)).includes("PRIVATE_COTURN_SECRET")), false);
    const button = page.getByRole("button", { name: "Load saved setup" });
    assert.ok((await button.boundingBox()).height >= 44);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
