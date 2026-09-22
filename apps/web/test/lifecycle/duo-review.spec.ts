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

async function openShell(page: Page, native: boolean, admin = false) {
  const user = { id: 'review-reader', username: 'Reader', isAdmin: admin, isOwner: admin,
    canApproveLibationRequests: admin, allowedBookIds: null, libationAccess: 'direct',
    shareProgress: false, announceFinishes: false, notifyFinishes: false, createdAt: '1700000000' };
  const books = library(6);
  const writes: string[] = [];
  let connected = false;
  await page.addInitScript(() => {
    localStorage.setItem('operalibre.serverUrl', location.origin);
    localStorage.setItem('operalibre.serverType', 'operalibre');
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (method === 'POST') writes.push(path);
    let body: unknown = [];
    if (path === '/api/auth/status') body = { setupRequired: false, user, mediaToken: 'fixture' };
    else if (path === '/api/auth/me') body = user;
    else if (path === '/api/books') body = books;
    else if (path === '/api/me/libro' && method === 'POST') { connected = true; body = {}; }
    else if (path === '/api/me/libro') body = { connected, email: connected ? 'reader@example.com' : null,
      accounts: connected ? [{ email: 'reader@example.com', syncedAt: null }] : [], syncedAt: null, books: [], jobs: [] };
    else if (path === '/api/libation/status') body = { enabled: true, authenticated: true, accounts: [],
      cliPath: null, libationFilesDir: null, libraryRoot: '', message: null, autoRefreshHours: null, manualRefreshesPerHour: 2 };
    else if (path === '/api/libation/sync') body = { jobId: 'refresh-fixture' };
    await route.fulfill({ json: body });
  });
  await page.goto(native ? `${url}test/duo-shell.html` : url);
  await expect(page.locator('.book-row')).toHaveCount(6);
  return { books, writes };
}

test('web readers can connect Libro.fm without native Settings', async ({ page }) => {
  const { writes } = await openShell(page, false);
  await page.getByRole('button', { name: 'Get books', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Settings', exact: true })).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('reader@example.com');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Connect Libro.fm', exact: true }).click();
  await expect(page.getByText('Libro.fm accounts (1)', { exact: true })).toBeVisible();
  expect(writes).toContain('/api/me/libro');
});

test('web Audible management can request a purchase refresh', async ({ page }) => {
  const { writes } = await openShell(page, false, true);
  await page.getByRole('button', { name: 'Get books', exact: true }).click();
  await page.getByText('Audible accounts & downloads', { exact: true }).click();
  await page.getByRole('button', { name: 'Refresh purchases', exact: true }).click();
  await expect.poll(() => writes).toContain('/api/libation/sync');
});

test('native server clients can manage Libro.fm without the device plugin', async ({ page }) => {
  await openShell(page, true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.store-settings-group > summary').filter({ hasText: 'Libro.fm' }).click();
  await expect(page.getByRole('button', { name: 'Connect Libro.fm', exact: true })).toBeVisible();
  await expect(page.getByLabel('Download purchases to')).toHaveCount(0);
});

test('closing with retained hinge geometry restores the sorted single shelf', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 951, height: 669 });
  const { books } = await openShell(page, true);
  await page.evaluate(async () => {
    const path = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(path);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 110,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } });
  });
  await expect(page.locator('.book-leaf')).toHaveCount(2);
  await page.setViewportSize({ width: 466, height: 678 });
  await page.evaluate(async () => {
    const path = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(path);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 65,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: false } });
  });
  await expect(page.locator('html')).toHaveAttribute('data-fold-posture', 'closed');
  await expect(page.locator('.book-row strong')).toHaveText(books.map(book => book.title));
  await expect(page.locator('.book-leaf')).toHaveCount(1);
});

test('web book details offer one primary playback action', async ({ page }) => {
  const { books } = await openShell(page, false);
  await page.locator('.book-row').first().click();
  const play = page.getByRole('button', { name: `Play ${books[0].title}`, exact: true });
  await expect(play).toHaveCount(1);
  await expect(play).toBeVisible();
});

test('native Audible settings show failed refresh requests', async ({ page }) => {
  await openShell(page, true, true);
  await page.route('**/api/libation/sync', route => route.fulfill({ status: 429, json: { message: 'Refresh limit reached. Try again later.' } }));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.store-settings-group > summary').filter({ hasText: 'Audible' }).click();
  await page.getByRole('button', { name: 'Refresh purchases', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Refresh limit reached. Try again later.' })).toBeVisible();
});

test('native Libro.fm settings show failed background refreshes', async ({ page }) => {
  await openShell(page, true);
  let refreshed = false;
  await page.route('**/api/me/libro', route => route.fulfill({ json: {
    connected: true, email: 'reader@example.com', syncedAt: null,
    accounts: [{ email: 'reader@example.com', syncedAt: null }], books: [],
    jobs: refreshed ? [{ id: 'failed-refresh', kind: 'libro-refresh', status: 'failed',
      error: 'Libro.fm connection expired. Reconnect your account.' }] : []
  } }));
  await page.route('**/api/me/libro/refresh', route => {
    refreshed = true;
    return route.fulfill({ json: { jobId: 'failed-refresh' } });
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.store-settings-group > summary').filter({ hasText: 'Libro.fm' }).click();
  await page.getByText('Manage connected accounts (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Refresh all accounts', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Libro.fm connection expired. Reconnect your account.' })).toBeVisible();
});
