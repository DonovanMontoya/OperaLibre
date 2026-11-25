import { expect, test } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { SyncAddonStatus } from "../../src/types";

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

for (const source of ["path", "manual", "managed", "older-server"] as const) {
  for (const role of ["owner", "admin", "reader"]) {
    test(`${source} runtime controls for ${role}`, async ({ page }, testInfo) => {
      const managed = source === "managed" || source === "older-server";
      let status: SyncAddonStatus = {
        id: "readalong-sync", installed: true, enabled: true, managed,
        ...(source === "older-server" ? {} : { canToggle: source !== "manual" }),
        installedVersion: null, latestVersion: null, updateAvailable: false, canInstall: false,
        packageBytes: null, releaseUrl: null, cliPath: "/fixture/echogarden",
        message: source === "path" ? "Using echogarden found on the server's PATH."
          : source === "manual" ? "This generator is configured manually in server.config and is always enabled." : null
      };
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/experimental-features/readalong-sync/enabled") {
          const body: unknown = route.request().postDataJSON();
          if (typeof body !== "object" || body === null || !("enabled" in body) || typeof body.enabled !== "boolean") {
            throw new Error("Expected an enabled boolean");
          }
          status = { ...status, enabled: body.enabled };
          await route.fulfill({ json: status });
        } else if (path === "/api/experimental-features/readalong-sync") {
          await route.fulfill({ json: status });
        } else if (path === "/api/users" || path === "/api/libation/requests") {
          await route.fulfill({ json: [] });
        } else {
          await route.fulfill({ status: 503, json: { error: "Unavailable in this fixture" } });
        }
      });
      await page.goto(`${url}test/readalong-runtime.html?role=${role}`);
      await page.getByRole("button", { name: "Experiments", exact: true }).click();
      // The list is the page on a narrow window and sits beside the open experiment on a wide one.
      await page.getByRole("button", { name: /^Follow along/ }).filter({ visible: true }).click();
      const runtime = page.getByRole("region", { name: "Follow along", exact: true });
      await runtime.getByRole("tab", { name: "Add-on", exact: true }).click();
      await expect(runtime.getByText("External installation", { exact: true })).toBeVisible();
      if (source === "path" && role === "owner") {
        await runtime.screenshot({ path: testInfo.outputPath("readalong-runtime.png") });
      }
      const enabled = runtime.getByRole("switch", { name: "Follow along", exact: true });
      const remove = runtime.getByRole("button", { name: "Remove add-on", exact: true });
      if (role !== "owner" || source === "manual") {
        await expect(enabled).toHaveCount(0);
        await expect(remove).toHaveCount(0);
        return;
      }
      await expect(enabled).toBeChecked();
      await expect(remove).toHaveCount(managed ? 1 : 0);
      await enabled.click();
      await expect(enabled).not.toBeChecked();
      await expect(page.getByLabel("Sentence following")).toHaveText("Unavailable");
      await enabled.click();
      await expect(enabled).toBeChecked();
      await expect(page.getByLabel("Sentence following")).toHaveText("Available");
    });
  }
}
