import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { buildGiftLandingLinks, giftLandingResponse, GIFT_INSTALL_DESTINATIONS } from "../dist-test/gift-landing.js";

const fragment = `gift=${"a".repeat(64)}&broker=${encodeURIComponent("https://owner.example")}&key=${"b".repeat(43)}&signing=${"c".repeat(43)}`;
const url = `https://owner.example/gift#${fragment}`;

test("landing stays generic and does not reflect a query or fragment in HTML / OG", async () => {
  // Deliberately pass a request at runtime: the renderer takes no request input.
  const response = await giftLandingResponse(new Request(`${url.split("#")[0]}?message=PRIVATE_MESSAGE&sender=PRIVATE_SENDER&book=PRIVATE_BOOK#${fragment}`));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.equal(html, await (await giftLandingResponse()).text());
  for (const secret of [fragment, "a".repeat(64), "b".repeat(43), "c".repeat(43), "PRIVATE_MESSAGE", "PRIVATE_SENDER", "PRIVATE_BOOK"]) assert.equal(html.includes(secret), false);
  const og = html.match(/<meta property="og:[^>]+>/g).join("\n");
  assert.match(og, /A book gift · OperaLibre/);
  assert.doesNotMatch(og, /og:(url|image)/);
  assert.match(html, /Installation does not automatically restore the gift/);
  assert.match(html, /Open in OperaLibre<\/a>/);
  assert.match(html, /id="open-app" hidden aria-describedby="open-help"/);
  assert.doesNotMatch(html, /<script[^>]+src=|<iframe|<form|<img|document\.write|innerHTML|localStorage|serviceWorker|sendBeacon|fetch\(/);
});

test("landing has restrictive policies and exact hashed static scripts/styles", async () => {
  const response = await giftLandingResponse();
  const html = await response.text();
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("x-robots-tag"), /noindex/);
  const csp = response.headers.get("content-security-policy");
  for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'", "worker-src 'none'"]) assert.ok(csp.includes(directive));
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https:/);
  for (const tag of ["script", "style"]) {
    const content = html.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))[1];
    assert.ok(csp.includes(`${tag}-src 'sha256-${createHash("sha256").update(content).digest("base64")}'`));
  }
});

test("install destinations are documented official pages without gift credentials", async () => {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  const html = await (await giftLandingResponse()).text();
  for (const destination of Object.values(GIFT_INSTALL_DESTINATIONS)) {
    assert.ok(readme.includes(destination));
    assert.ok(html.includes(`href="${destination}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer"`));
    assert.equal(new URL(destination).hash, "");
    assert.equal(new URL(destination).search, "");
  }
  assert.equal(GIFT_INSTALL_DESTINATIONS.iphone, "https://apps.apple.com/us/app/operalibre/id6792065037");
  assert.doesNotMatch(html, /play\.google\.com|intent:\/\//);
});

test("valid fragment stays byte-for-byte local; query is dropped; native URL is the exact registered gift scheme", () => {
  const nativeUrl = `operalibre://gift#${fragment}`;
  assert.deepEqual(buildGiftLandingLinks(url), { originalUrl: url, nativeUrl });
  assert.deepEqual(buildGiftLandingLinks(url.replace("#", "?gift=QUERY_SECRET&redirect=https://evil.example#")), { originalUrl: url, nativeUrl });
  const encoded = url.replace("gift=", "g%69ft=");
  assert.equal(buildGiftLandingLinks(encoded)?.originalUrl, encoded);
});

test("invalid, ambiguous, oversized and unsafe URL fragments fail closed", () => {
  for (const candidate of [
    "https://owner.example/gift", url.replace("https:", "http:"), url.replace("https:", "javascript:"), url.replace("owner.example/gift", "user:password@owner.example/gift"), url.replace("/gift#", "/other#"),
    `${url}&gift=${"d".repeat(32)}`, `${url}&redirect=https://evil.example`, `${url}&key=${"e".repeat(43)}`, `${url}&unknown=%3Cscript%3E`, `${url}%zz`, `${url}\n`, `${url}%0a`,
    url.replace("gift=", "wrong="), url.replace("&key=", "&no-key="), url.replace("https%3A%2F%2Fowner.example", "javascript%3Aalert(1)"), url.replace("https%3A%2F%2Fowner.example", "https%3A%2F%2Fuser%3Asecret%40owner.example"),
    url.replace("https%3A%2F%2Fowner.example", "https%3A%2F%2Fowner.example%2Fpath"), url.replace("https%3A%2F%2Fowner.example", "https%3A%2F%2Fowner.example%3Fsecret%3Dx"), `https://owner.example/gift#gift=${"a".repeat(9000)}`, "x".repeat(17000),
  ]) assert.equal(buildGiftLandingLinks(candidate), null, candidate.slice(0, 160));
});

test("landing preserves optional opaque ID in original/native fragments but never in HTML", async () => {
  for (const id of ["gift____________", "a".repeat(128)]) {
    const giftUrl = `${url}&id=${id}`;
    assert.deepEqual(buildGiftLandingLinks(giftUrl), { originalUrl: giftUrl, nativeUrl: `operalibre://gift#${fragment}&id=${id}` });
    assert.equal((await (await giftLandingResponse()).text()).includes(id), false);
  }
  for (const id of ["", "a".repeat(15), "a".repeat(129), "../gift___________", "gift with spaces_", "gift___________=", "gift___________\n"]) assert.equal(buildGiftLandingLinks(`${url}&id=${encodeURIComponent(id)}`), null);
  assert.equal(buildGiftLandingLinks(`${url}&id=gift____________&id=gift____________`), null);
  assert.equal(buildGiftLandingLinks(`${url}&recoverySecret=MUST_STAY_PRIVATE`), null);
});

test("landing and actual app parser agree on decoded-control and exact-field validation", async () => {
  const base = new URLSearchParams(`${fragment}&id=gift____________`);
  const rejects = [];
  for (const field of ["gift", "id", "key", "signing"]) {
    for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029", "\0", "\t", " ", "\u007f"]) {
      const params = new URLSearchParams(base);
      params.set(field, params.get(field) + suffix);
      rejects.push(params.toString());
    }
    const empty = new URLSearchParams(base); empty.set(field, ""); rejects.push(empty.toString());
    const unknownName = new URLSearchParams(base); unknownName.set(`${field}\n`, "a".repeat(43)); rejects.push(unknownName.toString());
  }
  for (const suffix of ["\n", "\r", "\r\n", "\t", " "]) {
    const params = new URLSearchParams(base); params.set("broker", `https://owner.example${suffix}`); rejects.push(params.toString());
  }
  const valid = [base.toString(), fragment, `${fragment.replace("gift=", "g%69ft=")}&id=%67ift____________`];
  // Exercise the actual pure app module with the repository's supported Node
  // type stripping, even when the parent broker runner has no TS-loader flag.
  const { spawnSync } = await import("node:child_process");
  const moduleUrl = new URL("../../apps/web/src/giftAppLinks.ts", import.meta.url).href;
  const script = `import { readFileSync } from 'node:fs';
    import { parseExperimentalGiftFragment, parseNativeGiftUrl } from ${JSON.stringify(moduleUrl)};
    const values = JSON.parse(readFileSync(0, 'utf8'));
    process.stdout.write(JSON.stringify(values.map(raw => ({ valid: !!parseExperimentalGiftFragment(raw), native: parseNativeGiftUrl('operalibre://gift#' + raw)?.originalUrl ?? null }))));`;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { input: JSON.stringify([...rejects, ...valid]), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const appResults = JSON.parse(child.stdout);
  for (const [index, raw] of rejects.entries()) {
    assert.equal(buildGiftLandingLinks(`https://owner.example/gift#${raw}`), null, raw);
    assert.deepEqual(appResults[index], { valid: false, native: null }, raw);
  }
  for (const [index, raw] of valid.entries()) {
    const links = buildGiftLandingLinks(`https://owner.example/gift#${raw}`);
    assert.equal(links.nativeUrl, `operalibre://gift#${raw}`);
    assert.deepEqual(appResults[rejects.length + index], { valid: true, native: links.nativeUrl });
  }
  const html = await (await giftLandingResponse()).text();
  assert.match(html, /Another installed app could register the same scheme/);
  assert.match(html, /Custom app links are not verified HTTPS links/);
});

function clientEnvironment(href) {
  const elements = new Map(["gift-status", "original-gift", "copy-gift", "open-app"].map(id => [id, { attributes: new Map([["hidden", ""]]), textContent: "", listeners: {}, setAttribute(key, value) { this.attributes.set(key, value); }, removeAttribute(key) { this.attributes.delete(key); }, addEventListener(event, action) { this.listeners[event] = action; } }]));
  const copied = [];
  const events = {};
  return { elements, copied, events, context: { URL, URLSearchParams, window: { location: { href }, addEventListener(event, action) { events[event] = action; } }, document: { getElementById: id => elements.get(id) }, navigator: { clipboard: { async writeText(value) { copied.push(value); } } } } };
}

test("actual embedded client sets only validated return href and copies on explicit click", async () => {
  const html = await (await giftLandingResponse()).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const state = clientEnvironment(url.replace("#", "?private=DO_NOT_FORWARD#"));
  vm.runInNewContext(script, state.context);
  assert.equal(state.elements.get("original-gift").attributes.get("href"), url);
  assert.equal(state.elements.get("original-gift").attributes.has("hidden"), false);
  assert.equal(state.elements.get("copy-gift").attributes.has("hidden"), false);
  assert.equal(state.elements.get("open-app").attributes.get("href"), `operalibre://gift#${fragment}`);
  assert.deepEqual(state.copied, []);
  state.elements.get("copy-gift").listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(state.copied, [url]);
  assert.match(state.elements.get("gift-status").textContent, /Gift link copied/);
  state.context.window.location.href = `${url}&gift=duplicate`;
  state.events.hashchange();
  assert.equal(state.elements.get("original-gift").attributes.has("href"), false);
  assert.equal(state.elements.get("copy-gift").attributes.has("hidden"), true);
  assert.equal(state.elements.get("open-app").attributes.has("href"), false);
  state.elements.get("copy-gift").listeners.click();
  assert.deepEqual(state.copied, [url]);
  const invalid = clientEnvironment(`${url}&redirect=javascript:alert(1)`);
  vm.runInNewContext(script, invalid.context);
  assert.equal(invalid.elements.get("original-gift").attributes.has("href"), false);
  assert.equal(invalid.elements.get("copy-gift").attributes.has("hidden"), true);
  assert.match(invalid.elements.get("gift-status").textContent, /incomplete or invalid/);
});

test("Chromium enforces CSP, sends no gift data, and opens downloads only on activation", { skip: !process.env.OPERALIBRE_TEST_CHROMIUM }, async () => {
  const { chromium } = await import("playwright");
  const response = await giftLandingResponse();
  const body = await response.text();
  const browser = await chromium.launch({ executablePath: process.env.OPERALIBRE_TEST_CHROMIUM, headless: true });
  try {
    const context = await browser.newContext();
    const requests = [];
    const installRequests = [];
    const failures = [];
    await context.route("**/*", async route => {
      requests.push(route.request().url());
      if (new URL(route.request().url()).origin !== "https://owner.example") {
        installRequests.push({ url: route.request().url(), headers: await route.request().allHeaders() });
        // Mock the install destination; no external network is used by this test.
        await route.fulfill({ status: 200, contentType: "text/plain", body: "Official install page fixture" });
        return;
      }
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body });
    });
    const page = await context.newPage();
    page.on("pageerror", error => failures.push(error.message));
    await page.goto(url);
    await page.getByRole("status").filter({ hasText: "Your private gift details stay in this link" }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Open in OperaLibre" }).getAttribute("href"), `operalibre://gift#${fragment}`);
    assert.equal(await page.getByRole("link", { name: "Return to your original gift link" }).getAttribute("href"), url);
    assert.equal(await page.getByRole("link", { name: "iPhone and iPad: OperaLibre on the App Store" }).getAttribute("href"), GIFT_INSTALL_DESTINATIONS.iphone);
    assert.deepEqual(requests, ["https://owner.example/gift"]);
    assert.deepEqual(failures, []);
    assert.equal(page.url(), url);
    await page.goto(`${url}&id=gift____________`);
    assert.equal(await page.getByRole("link", { name: "Open in OperaLibre" }).getAttribute("href"), `operalibre://gift#${fragment}&id=gift____________`);
    assert.deepEqual(requests, ["https://owner.example/gift"]);
    const [install] = await Promise.all([
      context.waitForEvent("page"),
      page.getByRole("link", { name: "iPhone and iPad: OperaLibre on the App Store" }).click(),
    ]);
    await install.waitForLoadState("domcontentloaded");
    assert.equal(installRequests.length, 1);
    assert.equal(installRequests[0].url, GIFT_INSTALL_DESTINATIONS.iphone);
    assert.equal(installRequests[0].headers.referer, undefined);
    assert.equal(await install.evaluate(() => window.opener === null), true);
    await install.close();
    await page.goto(`${url}&redirect=javascript:alert(1)`);
    await page.getByRole("status").filter({ hasText: "This gift link is incomplete or invalid" }).waitFor();
    assert.equal(await page.getByRole("link", { name: "Return to your original gift link" }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Open in OperaLibre" }).count(), 0);
    await context.close();
  } finally { await browser.close(); }
});
