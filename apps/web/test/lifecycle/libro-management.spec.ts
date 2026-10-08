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

async function foregroundContrast(target: Locator) {
  return target.evaluate(element => {
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


test("a narrow Libro.fm shelf keeps account forms out of the purchase list", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto(`${url}test/libro-management.html`);
  const manage = page.getByRole("button", { name: "Manage Libro.fm", exact: true });
  await expect(manage).toBeEnabled();
  await expect(page.locator("details")).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reconnect", exact: true })).toHaveCount(0);
  const firstPurchase = (await page.getByRole("heading", { name: "First Purchase", exact: true }).boundingBox())!;
  expect(firstPurchase.y).toBeLessThan(250);
  const row = (await page.locator(".libro-connection-row").boundingBox())!;
  expect(row.height).toBeLessThan(100);
  for (const action of [manage, page.getByRole("button", { name: "Refresh all accounts", exact: true })]) {
    const box = (await action.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(await foregroundContrast(action)).toBeGreaterThanOrEqual(4.5);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("Manage edits a nickname only on demand and returns focus to the shelf", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto(`${url}test/libro-management.html`);
  const manage = page.getByRole("button", { name: "Manage Libro.fm", exact: true });
  await manage.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Libro.fm accounts", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("details")).toHaveCount(0);
  await expect(dialog.getByRole("textbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Rename personal@example.test", exact: true }).press("Enter");
  const nickname = dialog.getByRole("textbox", { name: "Nickname for personal@example.test", exact: true });
  expect(await nickname.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  await nickname.fill("Library");
  await dialog.getByRole("button", { name: "Save nickname", exact: true }).press("Enter");
  await expect(nickname).toHaveCount(0);
  await expect(dialog.getByText("Library", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(manage).toBeFocused();
  await expect(page.getByText("Library · Connected", { exact: true })).toBeVisible();
  await expect(page.locator(".libro-purchase-account")).toContainText("Library");
});

test("reconnect targets one account and discards a cancelled password", async ({ page }) => {
  await page.goto(`${url}test/libro-management.html?multiple`);
  await page.getByRole("button", { name: "Manage Libro.fm", exact: true }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Libro.fm accounts", exact: true });
  await dialog.locator("article").filter({ hasText: "Family" }).getByRole("button", { name: "Reconnect", exact: true }).press("Enter");
  await expect(dialog.getByLabel("Email", { exact: true })).toHaveValue("family@example.test");
  await dialog.getByLabel("Password", { exact: true }).fill("discard-me");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Manage Libro.fm", exact: true }).press("Enter");
  await dialog.locator("article").filter({ hasText: "Family" }).getByRole("button", { name: "Reconnect", exact: true }).press("Enter");
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Password", { exact: true }).fill("fixture-password");
  await dialog.getByRole("button", { name: "Connect Libro.fm", exact: true }).press("Enter");
  await expect(dialog.locator("article")).toHaveCount(2);
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { libroCalls: { method: string; body: unknown }[] }).libroCalls.filter(call => call.method === "POST").map(call => call.body))).toContainEqual({ email: "family@example.test", password: "fixture-password" });
});

test("adding and disconnecting an account preserves the other library", async ({ page }) => {
  await page.goto(`${url}test/libro-management.html`);
  await page.getByRole("button", { name: "Manage Libro.fm", exact: true }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Libro.fm accounts", exact: true });
  await dialog.getByRole("button", { name: "Add Libro.fm account", exact: true }).press("Enter");
  await expect(dialog.getByLabel("Email", { exact: true })).toHaveValue("");
  await dialog.getByLabel("Email", { exact: true }).fill("family@example.test");
  await dialog.getByLabel("Password", { exact: true }).fill("fixture-password");
  await dialog.getByRole("button", { name: "Connect Libro.fm", exact: true }).press("Enter");
  await expect(dialog.locator("article")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Disconnect family@example.test", exact: true }).press("Enter");
  await expect(dialog.locator("article")).toHaveCount(1);
  await expect(dialog.getByText("Personal", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("heading", { name: "First Purchase", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Second Purchase", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Import First Purchase", exact: true }).press("Enter");
  expect(await page.evaluate(() => (window as unknown as { libroCalls: { path: string; method: string }[] }).libroCalls.some(call => call.method === "POST" && call.path.endsWith("/import?email=personal%40example.test")))).toBe(true);
});

test("the first connection returns focus to Manage and exposes purchases", async ({ page }) => {
  await page.goto(`${url}test/libro-management.html?empty`);
  const connect = page.getByRole("button", { name: "Connect Libro.fm", exact: true });
  await expect(connect).toBeEnabled();
  await connect.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Libro.fm accounts", exact: true });
  await dialog.getByLabel("Email", { exact: true }).fill("personal@example.test");
  await dialog.getByLabel("Password", { exact: true }).fill("fixture-password");
  await dialog.getByRole("button", { name: "Connect Libro.fm", exact: true }).press("Enter");
  await expect(dialog.locator("article")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Manage Libro.fm", exact: true })).toBeFocused();
  await expect(page.getByRole("heading", { name: "First Purchase", exact: true })).toBeVisible();
});

test("a failed connection clears the password and remains retryable", async ({ page }) => {
  await page.goto(`${url}test/libro-management.html?empty&failure`);
  await page.getByRole("button", { name: "Connect Libro.fm", exact: true }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Libro.fm accounts", exact: true });
  await dialog.getByLabel("Email", { exact: true }).fill("personal@example.test");
  await dialog.getByLabel("Password", { exact: true }).fill("fixture-password");
  await dialog.getByRole("button", { name: "Connect Libro.fm", exact: true }).press("Enter");
  await expect(dialog.getByRole("alert")).toContainText("Libro.fm sign-in failed");
  await expect(dialog.getByLabel("Password", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Connect Libro.fm", exact: true })).toBeEnabled();
});

test("a failed refresh stays visible outside account management", async ({ page }) => {
  await page.goto(`${url}test/libro-management.html?refresh-failure`);
  await page.getByRole("button", { name: "Refresh all accounts", exact: true }).press("Enter");
  await expect(page.getByRole("alert")).toHaveText("Libro.fm connection expired. Reconnect your account.");
  await page.getByRole("button", { name: "Manage Libro.fm", exact: true }).press("Enter");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Reconnect", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(1);
});

for (const dark of [false, true]) {
  test(`native ${dark ? "dark" : "light"} settings show account actions without an inner dropdown`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${url}test/libro-management.html?native${dark ? "&dark" : ""}`);
    const reconnect = page.getByRole("button", { name: "Reconnect", exact: true });
    await expect(reconnect).toBeEnabled();
    await expect(page.locator("details")).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);
    expect(await foregroundContrast(reconnect)).toBeGreaterThanOrEqual(4.5);
    await reconnect.press("Enter");
    await expect(page.getByLabel("Email", { exact: true })).toHaveValue("personal@example.test");
    expect(await page.getByLabel("Email", { exact: true }).evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    expect(await foregroundContrast(page.getByRole("button", { name: "Connect Libro.fm", exact: true }))).toBeGreaterThanOrEqual(4.5);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

for (const dark of [false, true]) {
  test(`administration purchases have readable text in ${dark ? "iOS dark" : "light"} list and grid views`, async ({ page }) => {
    await page.goto(`${url}test/libro-management.html?admin${dark ? "&native&dark" : ""}`);
    for (const view of ["Compact list", "Cover grid"]) {
      const toggle = page.getByRole("button", { name: view, exact: true });
      await expect(toggle).toBeEnabled();
      await toggle.press("Enter");
      expect(await foregroundContrast(toggle)).toBeGreaterThanOrEqual(4.5);
      const copy = page.locator(".libro-purchase-copy");
      const title = copy.getByRole("heading", { name: "First Purchase", exact: true });
      const author = copy.getByText("Fixture Author", { exact: true });
      const account = copy.locator(".libro-purchase-account");
      for (const label of [title, author, account]) {
        await expect(label).toBeVisible();
        expect(await foregroundContrast(label)).toBeGreaterThanOrEqual(4.5);
      }
      if (view === "Compact list") {
        const narrator = copy.getByText("Narrated by Fixture Narrator", { exact: true });
        await expect(narrator).toBeVisible();
        expect(await foregroundContrast(narrator)).toBeGreaterThanOrEqual(4.5);
      }
      expect(await foregroundContrast(page.getByRole("button", { name: "Import First Purchase", exact: true }))).toBeGreaterThanOrEqual(4.5);
    }
  });
}
