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

for (const [target, other] of [["audible", "Libro.fm"], ["libro", "Audible"]] as const) {
  test(`opening Settings for ${target} expands and centers only that book store`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${url}test/book-store-settings.html?target=${target}`);
    const wanted = page.locator("details.store-settings-group", { hasText: target === "audible" ? "Audible" : "Libro.fm" });
    const unwanted = page.locator("details.store-settings-group", { hasText: other });
    await expect(wanted).toHaveAttribute("open", "");
    await expect(unwanted).not.toHaveAttribute("open", "");
    // The Libro.fm group grows once its connection loads, after the first scroll.
    if (target === "libro") await expect(wanted.getByRole("button", { name: "Connect Libro.fm" })).toBeVisible();
    await expect.poll(async () => {
      const box = (await wanted.boundingBox())!;
      return Math.abs(box.y + box.height / 2 - 422);
    }).toBeLessThan(2);
  });
}

test("a book store taller than the screen keeps its heading on screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${url}test/book-store-settings.html?target=audible&tall`);
  await expect(page.locator("details.store-settings-group[open] > summary")).toBeInViewport({ ratio: 1 });
});

test("Settings opened without a destination leaves the book stores collapsed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${url}test/book-store-settings.html`);
  await expect(page.locator("details.store-settings-group")).toHaveCount(2);
  await expect(page.locator("details.store-settings-group[open]")).toHaveCount(0);
});
