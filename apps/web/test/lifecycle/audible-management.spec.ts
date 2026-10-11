import { expect, test, type Locator } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

async function buttonContrast(button: Locator) {
  return button.evaluate(element => {
    const rgba = (value: string) => value.match(/[\d.]+/g)!.map(Number);
    const blend = (front: number[], back: number[]) => front.slice(0, 3).map((channel, index) => channel * (front[3] ?? 1) + back[index] * (1 - (front[3] ?? 1)));
    const luminance = (rgb: number[]) => rgb.map(channel => {
      const value = channel / 255;
      return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
    const backgrounds = [];
    for (let node: Element | null = element; node; node = node.parentElement) backgrounds.push(rgba(getComputedStyle(node).backgroundColor));
    const background = backgrounds.reverse().reduce((back, front) => blend(front, back), [255, 255, 255]);
    const foreground = blend(rgba(getComputedStyle(element).color), background);
    const light = Math.max(luminance(foreground), luminance(background));
    const dark = Math.min(luminance(foreground), luminance(background));
    return (light + .05) / (dark + .05);
  });
}

test("the narrow shelf has a direct connect action without account dropdowns", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto(`${url}test/audible-management.html?empty`);
  const connect = page.getByRole("button", { name: "Connect Audible", exact: true });
  await expect(connect).toBeEnabled();
  const box = (await connect.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(320);
  expect(box.y + box.height).toBeLessThan(320);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(await buttonContrast(connect)).toBeGreaterThanOrEqual(4.5);
  expect((await page.locator(".audible-sidebar").boundingBox())!.height).toBeLessThan(100);
  await expect(page.locator(".audible-sidebar details")).toHaveCount(0);
  await connect.press("Enter");
  await expect(page.getByRole("dialog", { name: "Connect Audible", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(connect).toBeFocused();
});

async function openManagement(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Manage Audible", exact: true }).press("Enter");
  await expect(page.getByRole("dialog", { name: "Audible accounts & imports", exact: true })).toBeVisible();
}

test("account management opens outside the shelf and returns focus when closed", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto(`${url}test/audible-management.html?connected`);
  const manage = page.getByRole("button", { name: "Manage Audible", exact: true });
  await expect(manage).toBeVisible();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rename", exact: true })).toHaveCount(0);
  await expect(page.locator(".audible-sidebar details")).toHaveCount(0);
  expect((await page.locator(".audible-sidebar").boundingBox())!.height).toBeLessThan(100);
  await openManagement(page);
  const dialog = page.getByRole("dialog", { name: "Audible accounts & imports", exact: true });
  await expect(dialog.locator("details")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Rename", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("region", { name: "Server setup", exact: true })).toContainText("Ready");
  const autoImport = dialog.getByRole("checkbox");
  await autoImport.press("Space");
  await expect(autoImport).toBeChecked();
  await expect(dialog.getByRole("status").filter({ hasText: "Future purchases will be imported after a refresh." })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(manage).toBeFocused();
  await openManagement(page);
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  await dialog.getByRole("button", { name: "Close Audible management" }).press("Enter");
  await expect(manage).toBeFocused();
});

test("account controls stack without squeezing import settings in a narrow shelf", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto(`${url}test/audible-management.html`);
  await openManagement(page);
  const reconnect = page.getByRole("button", { name: "Reconnect", exact: true });
  await expect(reconnect).toBeEnabled();
  const error = (await page.getByRole("alert").boundingBox())!;
  const actions = (await page.locator(".account-list-actions").boundingBox())!;
  const imports = (await page.locator(".audible-auto-import").boundingBox())!;
  expect(actions.y).toBeGreaterThanOrEqual(error.y + error.height);
  expect(imports.y).toBeGreaterThanOrEqual(actions.y + actions.height);
  expect(imports.width).toBeGreaterThan(150);
  expect(imports.width).toBe(error.width);
  expect(imports.x + imports.width).toBeLessThanOrEqual(320);
  expect(await buttonContrast(reconnect)).toBeGreaterThanOrEqual(4.5);
});

for (const [surface, query] of [["dark shelf", ""], ["light settings", "?native"], ["dark settings", "?native&dark"]]) {
  test(`Audible primary and secondary buttons are readable in ${surface}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${url}test/audible-management.html${query}`);
    if (!query) await openManagement(page);
    const connect = page.getByRole("button", { name: "Connect Audible", exact: true });
    await expect(connect).toBeEnabled();
    expect(await buttonContrast(connect)).toBeGreaterThanOrEqual(4.5);
    const refresh = page.getByRole("button", { name: "Refresh purchases", exact: true });
    await refresh.focus();
    await expect(refresh).toBeVisible();
    expect(await buttonContrast(refresh)).toBeGreaterThanOrEqual(4.5);
    expect((await refresh.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  });
}

for (const native of [false, true]) {
  test(`Audible sign-in completes and returns focus at ${native ? "phone" : "desktop"} width`, async ({ page }) => {
    await page.setViewportSize(native ? { width: 390, height: 844 } : { width: 1280, height: 800 });
    await page.goto(`${url}test/audible-management.html${native ? "?native" : ""}`);
    if (!native) await openManagement(page);
    await page.getByRole("button", { name: "Connect Audible", exact: true }).press("Enter");
    const dialog = page.getByRole("dialog", { name: "Connect Audible", exact: true });
    await expect(page.getByRole("dialog")).toHaveCount(1);
    await page.getByLabel("Account label", { exact: true }).fill("Personal");
    await page.getByLabel("Audible email or login").fill("personal@example.test");
    await page.getByRole("button", { name: "Continue to Amazon" }).press("Enter");
    await expect(page.getByRole("link", { name: "Open Amazon sign-in" })).toHaveAttribute("href", /^https:\/\/www\.amazon\.com\//);
    const response = page.getByLabel("Paste the final sign-in address");
    await response.fill("https://amazon.com.attacker.test/?code=bad");
    await expect(page.getByRole("button", { name: "Finish connecting" })).toBeDisabled();
    await response.fill("https://www.amazon.com/ap/maplanding?code=fixture");
    await page.getByRole("button", { name: "Finish connecting" }).press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Connect Audible", exact: true })).toBeFocused();
    await expect(page.getByText("Audible connected. Your purchases are refreshing.")).toBeVisible();
    await expect(page.getByText("US · Connected", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test("connecting the first account returns focus to Manage in the shelf", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?empty`);
  await page.getByRole("button", { name: "Connect Audible", exact: true }).press("Enter");
  await page.getByLabel("Account label", { exact: true }).fill("Personal");
  await page.getByLabel("Audible email or login").fill("personal@example.test");
  await page.getByRole("button", { name: "Continue to Amazon" }).press("Enter");
  await page.getByLabel("Paste the final sign-in address").fill("https://www.amazon.com/ap/maplanding?code=fixture");
  await page.getByRole("button", { name: "Finish connecting" }).press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage Audible", exact: true })).toBeFocused();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.locator(".audible-sidebar details")).toHaveCount(0);
});

test("closing during a slow start cancels the session when its response arrives", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?slow`);
  await openManagement(page);
  await page.getByRole("button", { name: "Connect Audible", exact: true }).press("Enter");
  await page.getByLabel("Account label", { exact: true }).fill("Personal");
  await page.getByLabel("Audible email or login").fill("personal@example.test");
  await page.getByRole("button", { name: "Continue to Amazon" }).press("Enter");
  await expect(page.getByRole("button", { name: "Preparing sign-in…" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel Audible sign-in" }).press("Enter");
  await expect(page.getByRole("dialog", { name: /^(Connect|Reconnect) Audible$/ })).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { finishAudibleStart: () => void }).finishAudibleStart());
  await expect.poll(() => page.evaluate(() => (window as unknown as { audibleCalls: { path: string; method: string; }[] }).audibleCalls.some(call => call.method === "DELETE" && call.path.endsWith("fixture-session")))).toBe(true);
});

test("an unfinished sign-in can be resumed and cancelled after reopening settings", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?pending`);
  await page.getByRole("button", { name: "Continue sign-in", exact: true }).press("Enter");
  await expect(page.getByLabel("Paste the final sign-in address")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: /^(Connect|Reconnect) Audible$/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Manage Audible", exact: true })).toBeFocused();
});

test("failed sign-in stays retryable and ICU failures provide the specific repair", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?failure&icu`);
  await openManagement(page);
  await expect(page.getByText(/Libation needs the ICU system dependency/)).toBeVisible();
  await page.getByRole("button", { name: "Reconnect", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Continue to Amazon" }).press("Enter");
  await page.getByLabel("Paste the final sign-in address").fill("https://www.amazon.com/ap/maplanding?code=fixture");
  await page.getByRole("button", { name: "Finish connecting" }).press("Enter");
  await expect(page.getByRole("dialog", { name: "Reconnect Audible", exact: true }).getByText(/Reconnect this Audible account/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to Amazon" })).toBeEnabled();
});

test("an unnamed account managed in Libation can reconnect with its original identity", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?legacy`);
  await openManagement(page);
  await page.getByRole("button", { name: "Reconnect", exact: true }).press("Enter");
  await expect(page.getByLabel("Account label", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Audible email or login")).toHaveValue("family@example.test");
  await page.getByRole("button", { name: "Continue to Amazon" }).press("Enter");
  await expect(page.getByRole("link", { name: "Open Amazon sign-in" })).toBeVisible();
  await page.getByLabel("Paste the final sign-in address").fill("https://www.amazon.com/ap/maplanding?code=fixture");
  await page.getByRole("button", { name: "Finish connecting" }).press("Enter");
  await expect(page.getByRole("dialog", { name: /^(Connect|Reconnect) Audible$/ })).toHaveCount(0);
  await expect(page.getByText("US · Connected", { exact: true })).toBeVisible();
});

test("reader settings expose refresh without credentials or account administration", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?reader&native`);
  await expect(page.getByRole("button", { name: "Refresh purchases" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Connect Audible", exact: true })).toHaveCount(0);
  await expect(page.getByText("family@example.test")).toHaveCount(0);
  await expect(page.getByText("Connect your account", { exact: true })).toHaveCount(0);
});

test("an unavailable installation can be inspected without a sidebar dropdown", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?missing`);
  await openManagement(page);
  await expect(page.getByRole("button", { name: "Connect Audible", exact: true })).toBeDisabled();
  await expect(page.getByRole("region", { name: "Server setup" })).toContainText("Install Libation on the server.");
});

for (const dark of [false, true]) {
  test(`setup check briefly shows success in native ${dark ? "dark" : "light"} settings and resets on retry`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${url}test/audible-management.html?native${dark ? "&dark" : ""}`);
    const check = page.getByRole("button", { name: "Check setup", exact: true });
    await expect(check).toBeEnabled();
    await page.clock.install();
    await expect(check.locator(".audible-setup-result")).toHaveCount(0);
    await check.press("Enter");
    await expect(check.locator(".audible-setup-result.success")).toBeVisible();
    await expect(check).toHaveAttribute("title", "Setup ready.");
    await expect(page.locator(".audible-section-head [role=status]")).toHaveText("Setup ready.");
    await page.clock.fastForward(2000);
    await check.press("Enter");
    await expect(check.locator(".audible-setup-result.success")).toBeVisible();
    await page.clock.fastForward(2000);
    await expect(check.locator(".audible-setup-result.success")).toBeVisible();
    await page.clock.fastForward(2000);
    await expect(check.locator(".audible-setup-result")).toHaveCount(0);
    await expect(check.locator(".lucide-refresh-ccw")).toBeVisible();
    await expect(page.locator(".audible-section-head [role=status]")).toBeEmpty();
  });
}

test("setup check shows failure when a completed check needs attention", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?missing`);
  await openManagement(page);
  const check = page.getByRole("button", { name: "Check setup", exact: true });
  await expect(check).toBeEnabled();
  await page.clock.install();
  await check.press("Enter");
  await expect(check.locator(".audible-setup-result.failure")).toBeVisible();
  await expect(check).toHaveAttribute("title", "Setup needs attention. See server setup below.");
  await expect(page.getByRole("region", { name: "Server setup" })).toContainText("Install Libation on the server.");
  await page.clock.fastForward(4000);
  await expect(check.locator(".audible-setup-result")).toHaveCount(0);
});

test("setup check shows request failure and keeps the error after the icon resets", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?native&setup-failure`);
  const check = page.getByRole("button", { name: "Check setup", exact: true });
  await expect(check).toBeEnabled();
  await page.clock.install();
  await check.press("Enter");
  await expect(check.locator(".audible-setup-result.failure")).toBeVisible();
  await expect(check).toBeEnabled();
  await expect(check).toHaveAttribute("title", "Setup check failed.");
  const error = page.getByRole("alert").filter({ hasText: "Setup could not be checked." });
  await expect(error).toBeVisible();
  await page.clock.fastForward(4000);
  await expect(check.locator(".audible-setup-result")).toHaveCount(0);
  await expect(error).toBeVisible();
});

async function setFailure(page: import("@playwright/test").Page, kind: string, enabled: boolean) {
  await page.evaluate(({ kind, enabled }) => (window as unknown as { setAudibleFailure: (kind: string, enabled: boolean) => void }).setAudibleFailure(kind, enabled), { kind, enabled });
}

for (const native of [false, true]) {
  test(`connection checks fail honestly and recover in ${native ? "native settings" : "web management"}`, async ({ page }) => {
    await page.goto(`${url}test/audible-management.html?connected${native ? "&native" : ""}`);
    if (!native) await openManagement(page);
    const check = page.getByRole("button", { name: "Check setup", exact: true });
    await expect(check).toBeEnabled();
    await setFailure(page, "status", true);
    await check.press("Enter");
    await expect(check).toHaveAttribute("title", "Setup check failed.");
    await expect(check.locator(".audible-setup-result.failure")).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("status temporarily unavailable.");
    await setFailure(page, "status", false);
    await check.press("Enter");
    await expect(check).toHaveAttribute("title", "Setup ready.");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test(`account changes repair cached purchases and filters when reloading fails in ${native ? "native settings" : "web management"}`, async ({ page }) => {
    await page.goto(`${url}test/audible-management.html?connected&catalog${native ? "&native" : ""}`);
    const catalog = page.getByRole("region", { name: "Cached Audible purchases" });
    await expect(catalog).toContainText("Family Purchase — Family");
    await catalog.getByLabel("Account filter", { exact: true }).selectOption("family");
    await catalog.getByLabel("Combined account filter", { exact: true }).selectOption("audible:family");
    if (!native) await openManagement(page);
    await setFailure(page, "catalog", true);
    await page.getByRole("button", { name: "Rename", exact: true }).press("Enter");
    await page.getByLabel("Account label", { exact: true }).fill("Personal");
    await page.getByRole("button", { name: "Save", exact: true }).press("Enter");
    await expect(page.getByText("Account renamed.", { exact: true })).toBeVisible();
    await expect(catalog).toContainText("Family Purchase — Personal");
    await expect(catalog.getByRole("option", { name: "Personal", exact: true })).toHaveCount(2);
    await expect(page.getByRole("alert")).toContainText("Libation books could not be loaded.");
    await setFailure(page, "status", true);
    await page.getByRole("button", { name: "Disconnect", exact: true }).press("Enter");
    await page.getByRole("button", { name: "Disconnect account", exact: true }).press("Enter");
    await expect(page.getByText("Account disconnected.", { exact: true })).toBeVisible();
    await expect(catalog.locator("li")).toHaveCount(0);
    await expect(catalog.getByRole("option", { name: "Personal", exact: true })).toHaveCount(0);
    await expect(catalog.getByLabel("Account filter", { exact: true })).toHaveValue("all");
    await expect(catalog.getByLabel("Combined account filter", { exact: true })).toHaveValue("all");
  });
}

test("healthy connection checks preserve unrelated acquisition errors", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?connected&native`);
  await setFailure(page, "import", true);
  await page.getByRole("button", { name: "Add all purchases to server", exact: true }).press("Enter");
  await expect(page.getByRole("alert")).toContainText("Fixture acquisition failed.");
  const check = page.getByRole("button", { name: "Check setup", exact: true });
  await setFailure(page, "status", true);
  await check.press("Enter");
  await expect(check).toHaveAttribute("title", "Setup check failed.");
  await setFailure(page, "status", false);
  await check.press("Enter");
  await expect(check).toHaveAttribute("title", "Setup ready.");
  await expect(page.getByRole("alert")).toContainText("Fixture acquisition failed.");
});

test("a catalog response started before disconnect cannot restore a removed account", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?connected&catalog&native`);
  const catalog = page.getByRole("region", { name: "Cached Audible purchases" });
  await expect(catalog).toContainText("Family Purchase");
  await page.evaluate(() => (window as unknown as { holdAudibleCatalog: () => void }).holdAudibleCatalog());
  await page.getByRole("button", { name: "Rename", exact: true }).press("Enter");
  await page.getByLabel("Account label", { exact: true }).fill("Personal");
  await page.getByRole("button", { name: "Save", exact: true }).press("Enter");
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseAudibleCatalog?: () => void }).releaseAudibleCatalog)).toBe("function");
  await page.getByRole("button", { name: "Disconnect", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Disconnect account", exact: true }).press("Enter");
  await expect(catalog.locator("li")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { releaseAudibleCatalog: () => void }).releaseAudibleCatalog());
  await expect(page.getByText("Account disconnected.", { exact: true })).toBeVisible();
  await expect(catalog.locator("li")).toHaveCount(0);
  await expect(catalog.getByRole("option")).toHaveCount(2);
});

test("a discovery poll started before refresh cannot discard its optimistic job", async ({ page }) => {
  await page.clock.install();
  await page.goto(`${url}test/audible-management.html?connected&native`);
  const refresh = page.getByRole("button", { name: "Refresh purchases", exact: true });
  await expect(refresh).toBeEnabled();
  await page.evaluate(() => (window as unknown as { holdAudibleJobs: () => void }).holdAudibleJobs());
  await page.clock.fastForward(15000);
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseAudibleJobs?: () => void }).releaseAudibleJobs)).toBe("function");
  await refresh.press("Enter");
  const refreshing = page.getByRole("button", { name: "Refreshing purchases", exact: true });
  await expect(refreshing).toBeDisabled();
  await page.evaluate(() => (window as unknown as { releaseAudibleJobs: () => void }).releaseAudibleJobs());
  const check = page.getByRole("button", { name: "Check setup", exact: true });
  await check.press("Enter");
  await expect(check).toHaveAttribute("title", "Setup ready.");
  await expect(refreshing).toBeDisabled();
  await expect(page.getByRole("button", { name: "Refresh purchases", exact: true })).toHaveCount(0);
});

test("connection status captured before disconnect cannot restore the removed account", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?connected&catalog&native`);
  const catalog = page.getByRole("region", { name: "Cached Audible purchases" });
  await expect(catalog).toContainText("Family Purchase");
  await page.evaluate(() => (window as unknown as { holdAudibleStatus: () => void }).holdAudibleStatus());
  await page.getByRole("button", { name: "Check setup", exact: true }).press("Enter");
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseAudibleStatus?: () => void }).releaseAudibleStatus)).toBe("function");
  await page.getByRole("button", { name: "Disconnect", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Disconnect account", exact: true }).press("Enter");
  await expect(page.getByText("Account disconnected.", { exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseAudibleStatus: () => void }).releaseAudibleStatus());
  await expect(page.getByRole("button", { name: "Check setup", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toHaveCount(0);
  await expect(catalog.getByRole("option")).toHaveCount(2);
});

test("a successful account update clears a previous connection-status error", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?connected&native`);
  const check = page.getByRole("button", { name: "Check setup", exact: true });
  await expect(check).toBeEnabled();
  await setFailure(page, "status", true);
  await check.press("Enter");
  await expect(check).toHaveAttribute("title", "Setup check failed.");
  await expect(page.getByRole("alert")).toContainText("status temporarily unavailable.");
  await page.getByRole("checkbox").press("Space");
  await expect(page.getByRole("checkbox")).toBeChecked();
  await expect(page.getByRole("status").filter({ hasText: "Future purchases will be imported after a refresh." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("an ordinary catalog refresh does not invalidate a successful connection check", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?connected&catalog&native`);
  await expect(page.getByRole("region", { name: "Cached Audible purchases" })).toContainText("Family Purchase");
  await page.evaluate(() => (window as unknown as { holdAudibleStatus: () => void }).holdAudibleStatus());
  const check = page.getByRole("button", { name: "Check setup", exact: true });
  await check.press("Enter");
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseAudibleStatus?: () => void }).releaseAudibleStatus)).toBe("function");
  await page.evaluate(() => (window as unknown as { refreshAudibleCatalog: () => Promise<void> }).refreshAudibleCatalog());
  await page.evaluate(() => (window as unknown as { releaseAudibleStatus: () => void }).releaseAudibleStatus());
  await expect(check).toHaveAttribute("title", "Setup ready.");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

const approvedRequest = {
  id: "fixture-request", userId: "owner", username: "Owner", asin: "fixture",
  profileId: "family", profileName: "Family", catalogId: "family:fixture", title: "Family Purchase",
  status: "approved", requestedAt: "1700000000", decidedAt: "1700000001", decidedBy: "approver", jobId: "fixture-download"
};

test("an approved request refreshes on its timer without a catalog fetch restarting the poll", async ({ page }) => {
  await page.clock.install();
  let requests = 0;
  await page.route("**/api/libation/requests", async route => {
    requests += 1;
    await route.fulfill({ json: [approvedRequest] });
  });
  await page.goto(`${url}test/audible-management.html?connected&reader&catalog`);
  await expect(page.getByRole("region", { name: "Cached Audible purchases" })).toContainText("Family Purchase");
  await page.evaluate(() => (window as unknown as { refreshAudibleCatalog: () => Promise<void> }).refreshAudibleCatalog());
  expect(requests).toBe(1);
  await page.clock.fastForward(5000);
  await expect.poll(() => requests).toBe(2);
  await page.evaluate(() => (window as unknown as { refreshAudibleCatalog: () => Promise<void> }).refreshAudibleCatalog());
  expect(requests).toBe(2);
});

test("a slow request poll avoids overlapping fetches and retries after a failure", async ({ page }) => {
  await page.clock.install();
  let requests = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/libation/requests", async route => {
    requests += 1;
    if (requests === 1) {
      await held;
      await route.fulfill({ status: 503, json: { message: "Requests temporarily unavailable." } });
    } else {
      await route.fulfill({ json: [] });
    }
  });
  await page.goto(`${url}test/audible-management.html?connected&reader&catalog`);
  await expect.poll(() => requests).toBe(1);
  await page.clock.fastForward(5000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect(requests).toBe(1);
  const failed = page.waitForResponse(response => response.url().endsWith("/api/libation/requests") && response.status() === 503);
  release();
  await (await failed).finished();
  await page.clock.fastForward(60_000);
  await expect.poll(() => requests).toBe(2);
});
