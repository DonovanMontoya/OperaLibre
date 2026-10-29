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

test("confirmation, cancellation, retry and successful sign-out", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let calls = 0;
  await page.route("**/api/auth/me", async (route) => {
    calls++;
    expect(route.request().method()).toBe("DELETE");
    expect(route.request().postDataJSON()).toEqual({ password: "my-password" });
    await route.fulfill({ status: calls === 1 ? 403 : 200, contentType: "application/json", body: JSON.stringify(calls === 1 ? { error: "The password is incorrect." } : { ok: true }) });
  });
  await page.goto(`${url}test/account-deletion.html`);
  await page.getByRole("button", { name: "Delete my account…", exact: true }).click();
  const submit = page.getByRole("button", { name: "Permanently delete my account", exact: true });
  await expect(submit).toBeDisabled();
  await page.getByLabel("Current password").fill("my-password");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(calls).toBe(0);
  await page.getByRole("button", { name: "Delete my account…", exact: true }).click();
  await expect(page.getByLabel("Current password")).toHaveValue("");
  await expect(page.getByRole("checkbox")).not.toBeChecked();
  await page.getByLabel("Current password").fill("my-password");
  await page.getByRole("checkbox").check();
  await submit.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Signed out" })).toHaveCount(0);
  await submit.click();
  await expect(page.getByRole("heading", { name: "Signed out" })).toBeVisible();
});

test("owner sees transfer warning and unsupported modes cannot submit", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${url}test/account-deletion.html?owner`);
  await page.getByRole("button", { name: "Delete my account…", exact: true }).click();
  await expect(page.getByLabel("Transfer ownership to (username)")).toBeVisible();
  await expect(page.getByText(/server must keep an owner/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("account-deletion-owner.png"), fullPage: true });
  await page.goto(`${url}test/account-deletion.html?unsupported`);
  await expect(page.getByText("This mode has no OperaLibre account to delete.")).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
});
