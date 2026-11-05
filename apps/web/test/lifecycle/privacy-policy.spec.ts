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

test('server selection exposes privacy before connecting', async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: { setupRequired: false, user: null } }));
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Connect your library' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Jellyfin/ })).toHaveCount(0);
  await openPolicy(page);
});

for (const native of [false, true]) {
  test(`${native ? 'macOS shell' : 'web'} with a saved Jellyfin connection opens the server picker`, async ({ page }) => {
    const requests: string[] = [];
    page.on('request', request => {
      if (!request.url().startsWith(url)) requests.push(request.url());
    });
    await page.route('https://media.example/**', route => route.abort());
    await page.addInitScript(native => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', 'true');
      if (native) Object.assign(window, { __OPERALIBRE_NATIVE_SHELL__: true });
      localStorage.setItem('operalibre.serverType', 'jellyfin');
      localStorage.setItem('operalibre.serverUrl', 'https://media.example');
      localStorage.setItem('operalibre.serverIdentityUrl', 'https://media.example');
      localStorage.setItem('operalibre.serverId', 'f00d');
      localStorage.setItem('operalibre.jellyfinDeviceId', 'device');
      localStorage.setItem('operalibre.credentials.v2', JSON.stringify({
        'https://media.example': { token: 'jellyfin-token', mediaToken: 'jellyfin-token' }
      }));
    }, native);
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Connect your library' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('connects only to OperaLibre servers');
    await expect(page.getByLabel('OperaLibre server address')).toBeVisible();
    const stored = await page.evaluate(() => ({ ...localStorage }));
    for (const key of ['operalibre.serverType', 'operalibre.serverUrl', 'operalibre.serverIdentityUrl',
      'operalibre.serverId', 'operalibre.jellyfinDeviceId']) {
      expect(stored[key], key).toBeUndefined();
    }
    expect(stored['operalibre.credentials.v2'] ?? '{}').not.toContain('jellyfin-token');
    // Nothing was sent to the forgotten server.
    expect(requests.filter(request => request.startsWith('https://media.example'))).toEqual([]);

    // The next launch is an ordinary first run, without the notice.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Connect your library' })).toBeVisible();
    await expect(page.getByText('connects only to OperaLibre servers')).toHaveCount(0);
  });
}
