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
  await expect(dialog.getByRole("status")).toHaveText("Future purchases will be imported after a refresh.");
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

test("reader shelf exposes refresh without account administration", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?reader`);
  await expect(page.getByRole("button", { name: "Refresh purchases", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Manage Audible", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect Audible", exact: true })).toHaveCount(0);
  await expect(page.locator(".audible-sidebar details")).toHaveCount(0);
});
