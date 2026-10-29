import { test, expect, type Page } from '@playwright/test';
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

async function openShelf(page: Page, source: string) {
  const user = { id: 'reader', username: 'Reader', isAdmin: false, isOwner: false,
    allowedBookIds: null, libationAccess: 'approval', createdAt: '1700000000' };
  const email = 'reader@example.test';
  const requests = { libro: 0, audible: 0 };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = [];
    if (path === '/api/auth/status') body = { setupRequired: false, user, mediaToken: 'fixture' };
    else if (path === '/api/auth/me') body = user;
    else if (path === '/api/books') body = library(1);
    else if (path === '/api/libation/books') requests.audible++;
    else if (path === '/api/libation/access') body = { enabled: true, autoRefreshHours: null, manualRefreshesPerHour: 2 };
    else if (path === '/api/libation/status') body = { accounts: [], configured: false, available: false };
    else if (path === '/api/me/libro') body = {
      connected: true, email, accounts: [{ email, syncedAt: null }], syncedAt: null, jobs: [],
      books: [{ accountEmail: email, isbn: '9780000000001', title: 'Retained purchase',
        authors: ['Fixture Author'], cover_url: null, audiobook_info: { narrators: [], duration: 600 },
        description: '', localBookId: null }]
    };
    else if (path === '/api/me/libro/refresh') requests.libro++;
    await route.fulfill({ json: body });
  });
  await page.goto(`${url}test/duo-shell.html`);
  await expect(page.locator('.book-row')).toHaveCount(1);
  await expect(page.locator('.native-launch-cover')).toHaveCount(0);
  await page.getByRole('button', { name: 'Get books', exact: true }).click();
  await page.getByRole('tab', { name: source === 'libro' ? 'Libro.fm' : 'All accounts', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Retained purchase', exact: true })).toBeVisible();
  return requests;
}

async function pull(page: Page, ending: 'touchend' | 'touchcancel') {
  const shelf = page.locator('.library-pane');
  await shelf.evaluate(element => { element.scrollTop = 0; });
  await shelf.evaluate(element => element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: element, clientY: 0 })] })));
  await shelf.evaluate(element => element.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [new Touch({ identifier: 1, target: element, clientY: 200 })] })));
  await expect(page.locator('.pull-indicator')).toHaveCSS('opacity', '1');
  await shelf.dispatchEvent(ending, { touches: [] });
}

for (const source of ['libro', 'all']) {
  test(`${source} purchase shelf displays refresh failure, retains books, and allows retry`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const requests = await openShelf(page, source);
    const audibleBefore = requests.audible;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/me/libro/refresh', async route => {
      requests.libro++;
      if (requests.libro === 1) await pending;
      await route.fulfill({ status: requests.libro === 1 ? 503 : 200,
        json: requests.libro === 1 ? { message: 'Libro.fm refresh unavailable' } : { jobId: 'refresh-job' } });
    });
    await pull(page, 'touchend');
    await expect(page.locator('.pull-indicator')).toHaveClass(/refreshing/);
    release();
    await expect(page.getByRole('alert')).toHaveText('Libro.fm refresh unavailable');
    await expect(page.locator('.pull-indicator')).not.toHaveClass(/refreshing/);
    await expect(page.getByRole('heading', { name: 'Retained purchase', exact: true })).toBeVisible();
    if (source === 'all') expect(requests.audible).toBeGreaterThan(audibleBefore);
    await pull(page, 'touchend');
    await expect.poll(() => requests.libro).toBe(2);
    await expect(page.locator('.pull-indicator')).not.toHaveClass(/refreshing/);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Retained purchase', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('canceling a threshold-crossing pull clears it without refreshing', async ({ page }) => {
  const requests = await openShelf(page, 'libro');
  await pull(page, 'touchcancel');
  await expect(page.locator('.pull-indicator')).toHaveCSS('opacity', '0');
  await expect(page.locator('.pull-indicator')).not.toHaveClass(/refreshing/);
  await page.locator('.library-pane').dispatchEvent('touchend', { touches: [] });
  expect(requests.libro).toBe(0);
  await pull(page, 'touchend');
  await expect.poll(() => requests.libro).toBe(1);
  await expect(page.locator('.pull-indicator')).not.toHaveClass(/refreshing/);
});
