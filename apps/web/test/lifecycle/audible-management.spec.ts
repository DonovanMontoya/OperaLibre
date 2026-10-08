import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

for (const native of [false, true]) {
  test(`Audible sign-in completes and returns focus at ${native ? "phone" : "desktop"} width`, async ({ page }) => {
    await page.setViewportSize(native ? { width: 390, height: 844 } : { width: 1280, height: 800 });
    await page.goto(`${url}test/audible-management.html${native ? "?native" : ""}`);
    await page.getByRole("button", { name: "Connect Audible", exact: true }).press("Enter");
    const dialog = page.getByRole("dialog");
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

test("closing during a slow start cancels the session when its response arrives", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?slow`);
  await page.getByRole("button", { name: "Connect Audible", exact: true }).press("Enter");
  await page.getByLabel("Account label", { exact: true }).fill("Personal");
  await page.getByLabel("Audible email or login").fill("personal@example.test");
  await page.getByRole("button", { name: "Continue to Amazon" }).press("Enter");
  await expect(page.getByRole("button", { name: "Preparing sign-in…" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel Audible sign-in" }).press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { finishAudibleStart: () => void }).finishAudibleStart());
  await expect.poll(() => page.evaluate(() => (window as unknown as { audibleCalls: { path: string; method: string; }[] }).audibleCalls.some(call => call.method === "DELETE" && call.path.endsWith("fixture-session")))).toBe(true);
});

test("an unfinished sign-in can be resumed and cancelled after reopening settings", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?pending`);
  await page.getByRole("button", { name: "Continue sign-in", exact: true }).press("Enter");
  await expect(page.getByLabel("Paste the final sign-in address")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect Audible", exact: true })).toBeEnabled();
});

test("failed sign-in stays retryable and ICU failures provide the specific repair", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?failure&icu`);
  await expect(page.getByText(/Libation needs the ICU system dependency/)).toBeVisible();
  await page.getByRole("button", { name: "Reconnect", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Continue to Amazon" }).press("Enter");
  await page.getByLabel("Paste the final sign-in address").fill("https://www.amazon.com/ap/maplanding?code=fixture");
  await page.getByRole("button", { name: "Finish connecting" }).press("Enter");
  await expect(page.getByRole("dialog").getByText(/Reconnect this Audible account/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue to Amazon" })).toBeEnabled();
});

test("an unnamed account managed in Libation can reconnect with its original identity", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?legacy`);
  await page.getByRole("button", { name: "Reconnect", exact: true }).press("Enter");
  await expect(page.getByLabel("Account label", { exact: true })).toBeDisabled();
  await expect(page.getByLabel("Audible email or login")).toHaveValue("family@example.test");
  await page.getByRole("button", { name: "Continue to Amazon" }).press("Enter");
  await expect(page.getByRole("link", { name: "Open Amazon sign-in" })).toBeVisible();
  await page.getByLabel("Paste the final sign-in address").fill("https://www.amazon.com/ap/maplanding?code=fixture");
  await page.getByRole("button", { name: "Finish connecting" }).press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("US · Connected", { exact: true })).toBeVisible();
});

test("reader settings expose refresh without credentials or account administration", async ({ page }) => {
  await page.goto(`${url}test/audible-management.html?reader&native`);
  await expect(page.getByRole("button", { name: "Refresh purchases" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Connect Audible", exact: true })).toHaveCount(0);
  await expect(page.getByText("family@example.test")).toHaveCount(0);
  await expect(page.getByText("Audible setup", { exact: true })).toHaveCount(0);
});
