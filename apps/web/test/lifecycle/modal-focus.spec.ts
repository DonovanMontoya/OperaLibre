import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

for (const name of ['upload', 'ebook', 'sync', 'unplayed', 'speed']) {
  test(`${name} contains focus, dismisses on Escape and restores its opener repeatedly`, async ({ page }) => {
    await page.goto(`${url}test/modal-focus.html`);
    const opener = page.getByRole('button', { name: `Open ${name}`, exact: true });
    for (let cycle = 0; cycle < 2; cycle++) {
      await opener.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
      // Even a scripted focus from a background control stays in the modal.
      await page.locator('#outside').evaluate(element => (element as HTMLElement).focus());
      await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
      for (const key of ['Shift+Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab']) {
        await page.keyboard.press(key);
        await expect.poll(() => dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
    }
  });
}

for (const name of ['upload', 'ebook', 'unplayed']) {
  test(`${name} remains contained when every action is disabled`, async ({ page }) => {
    await page.goto(`${url}test/modal-focus.html`);
    await page.getByLabel('Busy', { exact: true }).check();
    await page.getByRole('button', { name: `Open ${name}`, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
  });
}
