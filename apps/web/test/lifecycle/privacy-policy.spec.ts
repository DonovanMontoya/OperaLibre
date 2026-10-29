import { expect, test, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let url: string;
const policy = 'https://donovanmontoya.github.io/OperaLibre/privacy-policy.html';
const user = { id: 'reader', username: 'Reader', isAdmin: false, isOwner: false,
  allowedBookIds: null, libationAccess: 'none', createdAt: '1700000000' };

test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

async function openPolicy(page: Page, menu = false) {
  await page.context().route(policy, route => route.fulfill({ contentType: 'text/html', body: '<h1>Privacy policy destination</h1>' }));
  const link = page.getByRole(menu ? 'menuitem' : 'link', { name: 'Privacy policy', exact: true });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeInViewport();
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  const original = page.url();
  const opened = page.waitForEvent('popup');
  await link.click();
  const popup = await opened;
  await expect(popup).toHaveURL(policy);
  await expect(popup.getByRole('heading')).toHaveText('Privacy policy destination');
  expect(page.url()).toBe(original);
  await popup.close();
}

for (const native of [false, true]) {
  for (const state of ['login', 'setup', 'connected', 'demo', 'local'] as const) {
    if (!native && state === 'local') continue;
    test(`${native ? 'native shell' : 'web'} ${state} opens privacy without leaving the app`, async ({ page }) => {
      await page.setViewportSize({ width: native ? 390 : 1440, height: 844 });
      await page.addInitScript(state => {
        localStorage.setItem('operalibre.serverUrl', location.origin);
        localStorage.setItem('operalibre.serverType', 'operalibre');
        if (state === 'demo') localStorage.setItem('operalibre.demoMode', 'true');
        if (state === 'local') localStorage.setItem('operalibre.localMode', 'true');
      }, state);
      await page.route('**/api/**', route => {
        const pathname = new URL(route.request().url()).pathname;
        const path = pathname.slice(pathname.indexOf('/api/'));
        let json: unknown = [];
        if (path === '/api/auth/status') json = { setupRequired: state === 'setup', user: state === 'connected' ? user : null };
        if (path === '/api/auth/me') json = user;
        if (path === '/api/libation/status') json = { accounts: [], configured: false, available: false };
        if (path === '/api/me/libro') json = { connected: false, accounts: [], books: [], jobs: [] };
        return route.fulfill({ json });
      });
      await page.goto(native ? `${url}test/duo-shell.html` : url);
      const authenticated = ['connected', 'demo', 'local'].includes(state);
      if (authenticated) {
        await page.getByRole('button', { name: native ? 'Settings' : 'Account menu', exact: true }).click();
      } else {
        await page.getByLabel('Username', { exact: true }).fill('unfinished-reader');
      }
      await openPolicy(page, !native && authenticated);
      if (!authenticated) await expect(page.getByLabel('Username', { exact: true })).toHaveValue('unfinished-reader');
    });
  }
}

test('server selection exposes privacy for both server types before connecting', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: { setupRequired: false, user: null } }));
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Connect your library' })).toBeVisible();
  await openPolicy(page);
  await page.getByRole('button', { name: 'Use a Jellyfin server' }).click();
  await openPolicy(page);
});
