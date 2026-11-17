import { test, expect, type CDPSession, type Page } from '@playwright/test';
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

test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

const planned = ['book-0', 'book-1', 'book-2'];

async function openShelf(page: Page) {
  const user = { id: 'reader', username: 'Reader', isAdmin: false, isOwner: false,
    allowedBookIds: null, libationAccess: 'approval', createdAt: '1700000000' };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = [];
    if (path === '/api/auth/status') body = { setupRequired: false, user, mediaToken: 'fixture' };
    else if (path === '/api/auth/me') body = user;
    else if (path === '/api/books') body = library(4);
    await route.fulfill({ json: body });
  });
  // The queue key depends on the server identity; hand every plan the same
  // starting order until the app writes its own.
  await page.addInitScript(ids => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key: string) {
      const value = getItem.call(this, key);
      return value === null && key.startsWith('operalibre.readingQueue.') && !key.endsWith('.collapsed') ? JSON.stringify(ids) : value;
    };
  }, planned);
  await page.goto(`${url}test/duo-shell.html`);
  await expect(page.locator('.queue-row')).toHaveCount(3);
  await expect(page.locator('.native-launch-cover')).toHaveCount(0);
}

const titles = (page: Page) => page.locator('.queue-row strong').allTextContents();
const storedPlan = (page: Page) => page.evaluate(() => {
  const key = Object.keys(localStorage).find(entry => entry.startsWith('operalibre.readingQueue.') && !entry.endsWith('.collapsed'));
  return key ? JSON.parse(localStorage.getItem(key)!) : null;
});

async function centre(page: Page, title: string) {
  const box = (await page.locator('.queue-row', { hasText: title }).locator('.continue-reading-book').boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', point?: { x: number; y: number }) {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] });
}

test('holding a planned book drags it to a new place without opening it', async ({ page }) => {
  await openShelf(page);
  const cdp = await page.context().newCDPSession(page);
  const from = await centre(page, 'Fixture Book 0000');
  const to = await centre(page, 'Fixture Book 0002');

  await touch(cdp, 'touchStart', from);
  await expect(page.locator('.queue-row.is-lifted')).toHaveCount(1);
  const scrollBefore = await page.locator('.library-pane').evaluate(element => element.scrollTop);
  for (let step = 1; step <= 6; step++) {
    await touch(cdp, 'touchMove', { x: from.x, y: from.y + (to.y + 12 - from.y) * step / 6 });
  }
  await touch(cdp, 'touchEnd');

  await expect(page.locator('.queue-row.is-lifted')).toHaveCount(0);
  expect(await titles(page)).toEqual(['Fixture Book 0001', 'Fixture Book 0002', 'Fixture Book 0000']);
  expect(await storedPlan(page)).toEqual(['book-1', 'book-2', 'book-0']);
  // The drag moved the book, not the shelf, and the book stayed closed.
  expect(await page.locator('.library-pane').evaluate(element => element.scrollTop)).toBe(scrollBefore);
  await expect(page.locator('.pull-indicator')).toHaveCSS('opacity', '0');
  await expect(page.getByRole('heading', { name: 'Fixture Book 0000', exact: true })).toHaveCount(0);
});

test('a quick swipe across a planned book scrolls instead of lifting it', async ({ page }) => {
  await openShelf(page);
  const cdp = await page.context().newCDPSession(page);
  const from = await centre(page, 'Fixture Book 0001');

  await touch(cdp, 'touchStart', from);
  await touch(cdp, 'touchMove', { x: from.x, y: from.y - 40 });
  await touch(cdp, 'touchMove', { x: from.x, y: from.y - 120 });
  // Wait out the hold delay with the finger still down; it must not lift now.
  await page.waitForFunction(() => new Promise(resolve => setTimeout(() => resolve(true), 500)));
  await expect(page.locator('.queue-row.is-lifted')).toHaveCount(0);
  await touch(cdp, 'touchEnd');
  expect(await titles(page)).toEqual(['Fixture Book 0000', 'Fixture Book 0001', 'Fixture Book 0002']);
  expect(await storedPlan(page)).toBeNull();
});

test('dropping a book back in its own place saves nothing', async ({ page }) => {
  await openShelf(page);
  const cdp = await page.context().newCDPSession(page);
  const from = await centre(page, 'Fixture Book 0001');
  await touch(cdp, 'touchStart', from);
  await expect(page.locator('.queue-row.is-lifted')).toHaveCount(1);
  await touch(cdp, 'touchMove', { x: from.x, y: from.y + 10 });
  await touch(cdp, 'touchEnd');
  await expect(page.locator('.queue-row.is-lifted')).toHaveCount(0);
  expect(await storedPlan(page)).toBeNull();
  await expect(page.getByRole('heading', { name: 'Fixture Book 0001', exact: true })).toHaveCount(0);
});
