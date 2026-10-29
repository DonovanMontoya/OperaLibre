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

for (const name of ['upload', 'ebook', 'sync', 'unplayed', 'speed', 'metadata']) {
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

test('Escape closes metadata suggestions before dismissing unsaved edits', async ({ page }) => {
  await page.goto(`${url}test/modal-focus.html`);
  const opener = page.getByRole('button', { name: 'Open metadata', exact: true });
  await opener.click();
  const dialog = page.getByRole('dialog');
  const title = dialog.getByLabel('Title', { exact: true });
  await title.fill('Unsaved title');
  const series = dialog.getByRole('combobox', { name: 'Series', exact: true });
  await series.fill('Example');
  await expect(dialog.getByRole('listbox')).toBeVisible();
  await series.press('Escape');
  await expect(dialog.getByRole('listbox')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(title).toHaveValue('Unsaved title');
  await expect(series).toHaveValue('Example');
  await expect(series).toBeFocused();
  await series.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

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
