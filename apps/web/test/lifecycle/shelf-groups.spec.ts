import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { library } from '../performance/fixtures';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

for (const platform of ['web', 'ios', 'android'] as const) {
  test(`${platform} expands filtered-out shelf groups and remembers them after reload`, async ({ page }) => {
    await page.setViewportSize({ width: platform === 'web' ? 1280 : 320, height: 800 });
    const books = library(6).map((book, index) => ({
      ...book, metadata: { ...book.metadata, series: ['Alice', 'Oz', 'Sherlock'][Math.floor(index / 2)] }
    }));
    await page.addInitScript(() => {
      localStorage.setItem('operalibre.serverUrl', location.origin);
      localStorage.setItem('operalibre.serverType', 'operalibre');
      if (!localStorage.getItem('shelfFixtureSeeded')) {
        localStorage.setItem('operalibre.sortMode.local', 'series');
        localStorage.setItem('operalibre.collapsedShelfGroups', JSON.stringify({
          series: ['Alice', 'Oz', 'Sherlock'], genre: ['Fantasy']
        }));
        localStorage.setItem('shelfFixtureSeeded', 'true');
      }
    });
    const user = { id: 'shelf-reader', username: 'Reader', isAdmin: false, isOwner: false,
      allowedBookIds: null, libationAccess: 'none', createdAt: '1700000000' };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = [];
      if (path === '/api/auth/status') body = { setupRequired: false, user, mediaToken: 'fixture' };
      else if (path === '/api/auth/me') body = user;
      else if (path === '/api/books') body = books;
      else if (path.endsWith('/progress')) body = null;
      await route.fulfill({ json: body });
    });
    await page.goto(platform === 'web' ? url : `${url}test/duo-shell.html?platform=${platform}`);
    const expand = page.getByRole('button', { name: 'Expand all', exact: true });
    await expect(page.locator('.book-sort-run.is-collapsed')).toHaveCount(3);
    const bounds = await expand.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(platform === 'web' ? 1280 : 320);

    // Search temporarily opens matches, but Expand all must also clear the
    // saved folds for groups that search currently hides.
    await page.getByRole('searchbox', { name: 'Search library' }).fill('Alice');
    await expect(page.locator('.book-row')).toHaveCount(2);
    await expand.click();
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(page.locator('.book-row')).toHaveCount(6);
    await expect(expand).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.book-row')).toHaveCount(6);
    await expect(page.locator('.book-sort-run.is-collapsed')).toHaveCount(0);

    // The other grouping retains its folds, and individual folds still work.
    await page.getByRole('combobox', { name: 'Sort library by' }).selectOption('genre');
    await expect(page.locator('.book-sort-run.is-collapsed')).toHaveCount(1);
    await page.getByRole('combobox', { name: 'Sort library by' }).selectOption('series');
    await page.locator('.book-sort-group-toggle').first().click();
    await expect(page.locator('.book-row')).toHaveCount(4);
    await expand.click();
    await expect(page.locator('.book-row')).toHaveCount(6);
  });
}
