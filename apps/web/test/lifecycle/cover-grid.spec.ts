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

async function coverLibrary(page: Page) {
  const books = library(1);
  books[0].coverArtUrl = '/cover.svg';
  const state: { userId: string; books: typeof books; color: string; stallCover: boolean;
    isAdmin: boolean; allowedBookIds: string[] | null } = {
    userId: 'cover-owner', books, color: '#822', stallCover: false, isAdmin: true, allowedBookIds: null
  };
  await page.addInitScript(() => localStorage.setItem('operalibre.games.enabled', 'true'));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const user = { id: state.userId, username: state.userId, isAdmin: state.isAdmin, isOwner: state.isAdmin,
      allowedBookIds: state.allowedBookIds, libationAccess: 'none', createdAt: '1700000000' };
    let body: unknown = [];
    if (path.endsWith('/api/auth/status')) body = { setupRequired: false, user, mediaToken: 'fixture' };
    else if (path.endsWith('/api/auth/me')) body = user;
    else if (path.endsWith('/api/books')) body = state.books;
    else if (path.endsWith('/api/libation/status')) body = { accounts: [], configured: false, available: false };
    else if (path.endsWith('/api/me/libro')) body = { connected: false, accounts: [], books: [], jobs: [] };
    await route.fulfill({ json: body });
  });
  await page.route('**/cover.svg*', route => {
    if (state.stallCover && route.request().resourceType() === 'fetch') return;
    return route.fulfill({ contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="${state.color}"/></svg>` });
  });
  return state;
}

async function openCoverGrid(page: Page) {
  await page.waitForFunction(() => !document.querySelector('.native-launch-cover'));
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  await page.getByRole('tab', { name: 'Cover Grid', exact: true }).click();
  const game = page.getByRole('region', { name: 'Cover Grid game' });
  await expect(game.getByRole('button', { name: 'Peek at the cover', exact: true })).toBeEnabled();
  return game;
}

for (const change of ['another reader', 'another server', 'a removed book'] as const) {
  test(`Cover Grid isolates saved artwork after ${change}`, async ({ page }) => {
    const state = await coverLibrary(page);
    await page.goto(`${url}test/duo-shell.html`);
    let game = await openCoverGrid(page);
    await game.getByRole('button', { name: 'Peek at the cover', exact: true }).click();
    const originalPicture = await game.locator('.slide-peek img').getAttribute('src');
    await game.getByRole('button', { name: 'Hide the cover' }).click();
    await game.getByRole('button', { name: /can slide/ }).first().click();
    await expect(game.locator('.game-stat')).toHaveText('1 move');

    await page.reload();
    game = await openCoverGrid(page);
    await expect(game.locator('.game-stat')).toHaveText('1 move');

    if (change === 'another reader') state.userId = 'cover-reader';
    else if (change === 'a removed book') state.books = [];
    else await page.evaluate(async serverUrl => {
      const modulePath = '/src/api.ts';
      const { setServerConnection } = await import(modulePath);
      setServerConnection(serverUrl, 'second-server');
    }, new URL('second-server', url).href);
    state.color = '#228';
    await page.reload();
    game = await openCoverGrid(page);
    await expect(game.locator('.game-stat')).toHaveText('0 moves');
    if (change !== 'another reader') {
      await game.getByRole('button', { name: 'Peek at the cover', exact: true }).click();
      await expect(game.locator('.slide-peek img')).not.toHaveAttribute('src', originalPicture ?? '');
    }
  });
}

test('Cover Grid discards unscoped legacy artwork', async ({ page }) => {
  await coverLibrary(page);
  await page.addInitScript(() => {
    localStorage.setItem('operalibre.games.cover-grid', JSON.stringify({
      puzzle: { bookId: 'restricted-book', title: 'Private legacy title',
        image: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480"><rect width="480" height="480" fill="red"/></svg>') },
      size: 3, tiles: [0, 1, 2, 3, 4, 5, 6, 8, 7], moves: 12, numbers: false, solved: 0, recent: []
    }));
  });
  await page.goto(`${url}test/duo-shell.html`);
  const game = await openCoverGrid(page);
  await expect(game.locator('.game-stat')).toHaveText('0 moves');
  expect(await page.evaluate(() => localStorage.getItem('operalibre.games.cover-grid'))).toBeNull();
});

test('Cover Grid reuses the only readable cover for a new puzzle', async ({ page }) => {
  await coverLibrary(page);
  await page.goto(`${url}test/duo-shell.html`);
  const game = await openCoverGrid(page);
  await game.getByRole('button', { name: 'Peek at the cover', exact: true }).click();
  const picture = await game.locator('.slide-peek img').getAttribute('src');
  await game.getByRole('button', { name: 'Hide the cover' }).click();
  await game.getByRole('button', { name: 'New picture', exact: true }).click();
  await expect(game.getByRole('button', { name: 'Peek at the cover', exact: true })).toBeEnabled();
  await game.getByRole('button', { name: 'Peek at the cover', exact: true }).click();
  await expect(game.locator('.slide-peek img')).toHaveAttribute('src', picture ?? '');
});

test('Cover Grid recovers from a stalled cover request', async ({ page }) => {
  const state = await coverLibrary(page);
  state.stallCover = true;
  await page.clock.install();
  await page.goto(`${url}test/duo-shell.html`);
  await page.waitForFunction(() => !document.querySelector('.native-launch-cover'));
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  const request = page.waitForRequest(request => request.url().includes('/cover.svg') && request.resourceType() === 'fetch');
  await page.getByRole('tab', { name: 'Cover Grid', exact: true }).click();
  await request;
  const game = page.getByRole('region', { name: 'Cover Grid game' });
  await expect(game.locator('.slide-board')).toHaveAttribute('aria-busy', 'true');
  await page.clock.fastForward(10_000);
  await expect(game.getByRole('button', { name: 'New picture', exact: true })).toBeEnabled();
  await expect(game.getByRole('button', { name: 'Peek at the cover', exact: true })).toBeEnabled();
});

test('Cover Grid drops an in-flight cover when the account changes', async ({ page }) => {
  const state = await coverLibrary(page);
  state.stallCover = true;
  await page.goto(`${url}test/duo-shell.html`);
  await page.waitForFunction(() => !document.querySelector('.native-launch-cover'));
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  const request = page.waitForRequest(request => request.url().includes('/cover.svg') && request.resourceType() === 'fetch');
  await page.getByRole('tab', { name: 'Cover Grid', exact: true }).click();
  await request;
  state.userId = 'cover-reader';
  state.stallCover = false;
  state.color = '#228';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const game = page.getByRole('region', { name: 'Cover Grid game' });
  await expect(game.getByRole('button', { name: 'Peek at the cover', exact: true })).toBeEnabled();
  await expect(game.locator('.game-stat')).toHaveText('0 moves');
});

test('Cover Grid hides a displayed cover when its book leaves the permitted library', async ({ page }) => {
  const state = await coverLibrary(page);
  await page.goto(`${url}test/duo-shell.html`);
  await page.waitForFunction(() => !document.querySelector('.native-launch-cover'));
  const fixture = await page.evaluateHandle(async books => {
    const reactPath = '/node_modules/.vite/deps/react.js';
    const domPath = '/node_modules/.vite/deps/react-dom_client.js';
    const gamePath = '/src/CoverGrid.tsx';
    const { createElement } = (await import(reactPath)).default;
    const { createRoot } = (await import(domPath)).default;
    const { CoverGrid } = await import(gamePath);
    const host = document.createElement('div');
    host.id = 'live-cover-grid';
    document.body.append(host);
    const root = createRoot(host);
    root.render(createElement(CoverGrid, { books, libraryKey: 'live-permissions' }));
    return { root, createElement, CoverGrid };
  }, state.books);
  const game = page.locator('#live-cover-grid');
  await expect(game.getByRole('button', { name: 'Peek at the cover', exact: true })).toBeEnabled();
  await game.getByRole('button', { name: 'Peek at the cover', exact: true }).click();
  const picture = await game.locator('.slide-peek img').getAttribute('src');
  await fixture.evaluate(({ root, createElement, CoverGrid }) => {
    root.render(createElement(CoverGrid, { books: [], libraryKey: 'live-permissions' }));
  });
  await expect(game.locator('.slide-peek img')).toHaveCount(0);
  await expect(game.getByRole('button', { name: 'Peek at the cover', exact: true })).toBeEnabled();
  await game.getByRole('button', { name: 'Peek at the cover', exact: true }).click();
  await expect(game.locator('.slide-peek img')).not.toHaveAttribute('src', picture ?? '');
  await fixture.evaluate(({ root }) => root.unmount());
  await fixture.dispose();
});

test('Cover Grid removes revoked artwork after refreshing reader permissions', async ({ page }) => {
  const state = await coverLibrary(page);
  state.isAdmin = false;
  await page.goto(`${url}test/duo-shell.html`);
  const game = await openCoverGrid(page);
  await game.getByRole('button', { name: 'Peek at the cover', exact: true }).click();
  const picture = await game.locator('.slide-peek img').getAttribute('src');
  state.allowedBookIds = [];
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/auth/me'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await refreshed;
  await expect(game.locator('.slide-peek img')).toHaveCount(0);
  await expect(game.getByRole('button', { name: 'Peek at the cover', exact: true })).toBeEnabled();
  await game.getByRole('button', { name: 'Peek at the cover', exact: true }).click();
  await expect(game.locator('.slide-peek img')).not.toHaveAttribute('src', picture ?? '');
  const stored = await page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith('operalibre.games.cover-grid'))
    .map(key => localStorage.getItem(key)));
  expect(stored.join('')).not.toContain(picture);
});

for (const mode of ['administrator', 'device book'] as const) {
  test(`Cover Grid keeps ${mode} artwork independent of reader restrictions`, async ({ page }) => {
    const state = await coverLibrary(page);
    if (mode === 'device book') {
      state.isAdmin = false;
      const deviceBook = { ...state.books[0], id: 'device:cover-fixture' };
      await page.addInitScript(book => {
        localStorage.setItem('operalibre.deviceLibrary.v1', JSON.stringify([book]));
      }, deviceBook);
      state.books = [];
    }
    await page.goto(`${url}test/duo-shell.html`);
    const game = await openCoverGrid(page);
    await game.getByRole('button', { name: 'Peek at the cover', exact: true }).click();
    const picture = await game.locator('.slide-peek img').getAttribute('src');
    state.allowedBookIds = [];
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/auth/me'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await refreshed;
    await expect(game.locator('.slide-peek img')).toHaveAttribute('src', picture ?? '');
  });
}
