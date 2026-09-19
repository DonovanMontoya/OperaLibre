import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import type { DeviceFoldState } from '../../src/deviceFold';
import { library } from '../performance/fixtures';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

test('cover-screen transport stays inside its rail as Now Playing consumes space', async ({ page }) => {
  await page.setViewportSize({ width: 466, height: 678 });
  await page.setContent(`<html class="native-app side-rail"><head>
    <link rel="stylesheet" href="${url}src/styles.css?direct">
    </head><body><main class="native-shell tab-shelf has-mini-player">
    <aside class="mini-player" aria-label="Mini player">
      <button class="mini-cover-button" aria-label="Open current book">Book</button>
      <button class="mini-meta">Book title</button>
      <div class="mini-progress">Progress</div>
      <div class="mini-actions">
        <button class="mini-chapter">Chapter</button>
        <button class="mini-seek" aria-label="Rewind">15</button>
        <button class="mini-play" aria-label="Pause">Pause</button>
        <button class="mini-seek" aria-label="Forward">30</button>
      </div>
    </aside></main></body></html>`);
  for (const [height, controls] of [[216, 'full'], [180, 'transport'], [164, 'transport'], [100, 'play'], [60, 'play'], [216, 'full']] as const) {
    await page.evaluate(({ height, controls }) => {
      const root = document.documentElement;
      root.dataset.railControls = controls;
      root.style.setProperty('--rail-x', '382px');
      root.style.setProperty('--rail-width', '84px');
      root.style.setProperty('--rail-bottom', '390px');
      root.style.setProperty('--rail-top', `${390 - height}px`);
    }, { height, controls });
    const player = await page.getByRole('complementary', { name: 'Mini player' }).boundingBox();
    expect(player!.x).toBeGreaterThanOrEqual(382);
    expect(player!.y).toBeGreaterThanOrEqual(390 - height);
    expect(player!.y + player!.height).toBeLessThanOrEqual(390);
    for (const button of await page.locator('.mini-player button:visible').all()) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeGreaterThanOrEqual(player!.y);
      expect(box.y + box.height).toBeLessThanOrEqual(player!.y + player!.height);
    }
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect(page.locator('.mini-cover-button')).toBeVisible({ visible: controls === 'full' });
    await expect(page.getByRole('button', { name: 'Rewind', exact: true })).toBeVisible({ visible: controls !== 'play' });
  }
});

test('unfolded spread keeps the mini player in the side rail, off the fold', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 669 });
  await page.setContent(`<html class="native-app side-rail" data-fold-posture="flat" data-fold-axis="vertical" data-fold-active><head>
    <link rel="stylesheet" href="${url}src/styles.css?direct">
    </head><body><main class="native-shell tab-shelf has-mini-player shelf-landscape">
    <section class="library-pane"></section><section class="player-pane"></section>
    <aside class="mini-player" aria-label="Mini player">
      <button class="mini-cover-button" aria-label="Open current book">Book</button>
      <div class="mini-actions"><button class="mini-play" aria-label="Pause">Pause</button></div>
    </aside></main></body></html>`);
  await page.evaluate(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries({ '--fold-x': '475px', '--fold-y': '0px', '--fold-width': '1px',
      '--fold-height': '669px', '--rail-x': '867px', '--rail-width': '84px', '--rail-top': '120px', '--rail-bottom': '380px' })) {
      root.style.setProperty(name, value);
    }
  });
  const player = (await page.getByRole('complementary', { name: 'Mini player' }).boundingBox())!;
  expect(player.x).toBeGreaterThanOrEqual(867);
  expect(player.x + player.width).toBeLessThanOrEqual(951);
  expect(player.y).toBeGreaterThanOrEqual(120);
  expect(player.y + player.height).toBeLessThanOrEqual(380);
});

test('half open, Ledger and Settings scroll each page on its own; flat keeps the one continuous flow', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 669 });
  await page.setContent(`<html class="native-app" data-fold-axis="vertical" data-fold-active><head>
    <link rel="stylesheet" href="${url}src/styles.css?direct">
    </head><body>
    <article class="profile-page ledger-dashboard">
      <div class="ledger-upper"><p style="height:1200px">Upper</p></div>
      <div class="ledger-lower"><p style="height:1200px">Lower</p></div>
    </article>
    <section class="settings-shell">
      <header class="settings-head"><h1>Settings</h1></header>
      <div class="settings-cards">
        <div class="settings-upper"><p style="height:1200px">Upper</p></div>
        <div class="settings-lower"><p style="height:1200px">Lower</p></div>
      </div>
    </section>
    </body></html>`);
  await page.evaluate(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries({ '--fold-x': '460px', '--fold-width': '31px',
      '--status-h': '44px', '--tabs-h': '80px' })) {
      root.style.setProperty(name, value);
    }
  });
  const columnCount = () => page.locator('.ledger-dashboard').evaluate(el => getComputedStyle(el).columnCount);
  const overflowY = (selector: string) => page.locator(selector).evaluate(el => getComputedStyle(el).overflowY);

  await page.evaluate(() => { document.documentElement.dataset.foldPosture = 'flat'; });
  expect(await columnCount()).toBe('2');
  expect(await overflowY('.ledger-upper')).not.toBe('auto');
  expect(await overflowY('.settings-upper')).not.toBe('auto');

  await page.evaluate(() => { document.documentElement.dataset.foldPosture = 'half-open'; });
  expect(await columnCount()).toBe('auto');
  for (const selector of ['.ledger-upper', '.ledger-lower', '.settings-upper', '.settings-lower']) {
    expect(await overflowY(selector)).toBe('auto');
  }
  const ledgerUpper = (await page.locator('.ledger-upper').boundingBox())!;
  const ledgerLower = (await page.locator('.ledger-lower').boundingBox())!;
  expect(ledgerUpper.x + ledgerUpper.width).toBeLessThanOrEqual(460);
  expect(ledgerLower.x).toBeGreaterThanOrEqual(491);
  const settingsUpper = (await page.locator('.settings-upper').boundingBox())!;
  const settingsLower = (await page.locator('.settings-lower').boundingBox())!;
  expect(settingsUpper.x + settingsUpper.width).toBeLessThanOrEqual(460);
  expect(settingsLower.x).toBeGreaterThanOrEqual(491);

  await page.locator('.ledger-upper').evaluate(el => { el.scrollTop = 500; });
  expect(await page.locator('.ledger-lower').evaluate(el => el.scrollTop)).toBe(0);
});

test('half-open reader clears the horizontal hinge and keeps its transport on the lower half', async ({ page }) => {
  await page.setViewportSize({ width: 669, height: 951 });
  await page.goto(`${url}test/reader-catch-up.html?immersive`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  await expect(page.locator('.epub-stage iframe')).toHaveCount(1);
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, {
      posture: 'half-open', angle: 90,
      fold: { x: 0, y: 460, width: 669, height: 30, axis: 'horizontal', active: true }
    });
  });
  const stage = (await page.locator('.epub-stage').boundingBox())!;
  const transport = (await page.locator('.epub-audiobar').boundingBox())!;
  expect(stage.y + stage.height).toBeLessThanOrEqual(460);
  expect(transport.y).toBeGreaterThanOrEqual(490);
  expect(transport.y + transport.height).toBeLessThanOrEqual(951);
});

test('the reader remembers a different text size for the closed screen than the open one', async ({ page }) => {
  await page.goto(`${url}test/reader-catch-up.html`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  const size = page.locator('.epub-font-controls span');
  const grow = page.getByRole('button', { name: 'Increase reader text size' });
  const setPosture = (state: DeviceFoldState) => page.evaluate(async state => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, state);
  }, state);

  await expect(size).toHaveText(/100%/);
  await grow.click();
  await expect(size).toHaveText(/110%/);

  await setPosture({ posture: 'closed', angle: 0 });
  await expect(size).toHaveText(/100%/);
  await grow.click();
  await grow.click();
  await expect(size).toHaveText(/120%/);

  await setPosture({ posture: 'flat', angle: 180,
    fold: { x: 475, y: 0, width: 1, height: 669, axis: 'vertical', active: false } });
  await expect(size).toHaveText(/110%/);

  await setPosture({ posture: 'closed', angle: 0 });
  await expect(size).toHaveText(/120%/);
});

test('a sentence near the left of the reader seeks narration instead of turning back', async ({ page }) => {
  await page.setViewportSize({ width: 669, height: 951 });
  await page.goto(`${url}test/reader-catch-up.html?immersive&narration`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  const paragraph = page.frameLocator('.epub-stage iframe').locator('p').nth(1);
  await expect(paragraph).toBeVisible();
  const box = (await paragraph.boundingBox())!;
  const stage = (await page.locator('.epub-stage').boundingBox())!;
  const x = box.x + 10;
  expect(x - stage.x).toBeGreaterThan(32);
  expect(x - stage.x).toBeLessThan(stage.width / 4);
  await page.mouse.click(x, box.y + 10);
  await expect(page.getByLabel('Narration position')).toHaveValue('20');
});

test('reader survives folding, rotating, flattening and closing without replacing its book', async ({ page }) => {
  await page.goto(`${url}test/reader-catch-up.html?immersive`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  await expect(page.locator('.epub-stage iframe')).toHaveCount(1);
  const rendition = await page.evaluateHandle(() => (window as any).__operalibreReader.rendition);
  await expect.poll(() => rendition.evaluate(value => value.currentLocation()?.start?.href)).toContain('c1.xhtml');
  const states: Array<{ width: number; height: number; state: DeviceFoldState; spread: string }> = [
    { width: 951, height: 669, spread: 'always', state: { posture: 'half-open', angle: 90,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } } },
    { width: 669, height: 951, spread: 'none', state: { posture: 'half-open', angle: 90,
      fold: { x: 0, y: 460, width: 669, height: 31, axis: 'horizontal', active: true } } },
    { width: 951, height: 669, spread: 'always', state: { posture: 'half-open', angle: 110,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } } },
    { width: 951, height: 669, spread: 'none', state: { posture: 'flat', angle: 180,
      fold: { x: 475, y: 0, width: 1, height: 669, axis: 'vertical', active: false } } },
    { width: 466, height: 678, spread: 'none', state: { posture: 'closed', angle: 0 } }
  ];
  for (const { width, height, state, spread } of states) {
    await page.setViewportSize({ width, height });
    await page.evaluate(async state => {
      const modulePath = '/src/deviceFold.ts';
      const { applyDeviceFold } = await import(modulePath);
      applyDeviceFold(document.documentElement, state);
    }, state);
    await expect.poll(() => rendition.evaluate(value => value.settings.spread)).toBe(spread);
    expect(await rendition.evaluate(value => value === (window as any).__operalibreReader.rendition)).toBe(true);
    await expect.poll(() => rendition.evaluate(value => value.currentLocation()?.start?.href), { message: `${state.posture} ${state.fold?.axis}` }).toContain('c1.xhtml');
    await expect(page.locator('.epub-error')).toHaveCount(0);
  }
  await expect(page.locator('html')).not.toHaveAttribute('data-fold-axis');
  await expect(page.locator('html')).not.toHaveAttribute('data-fold-active');
});

test('portrait fold bounds the shelf, settings and administration to independent surfaces', async ({ page }) => {
  await page.setViewportSize({ width: 669, height: 951 });
  const books = library(30);
  books[0].tracks[0].title = 'Part Two: Our Calling: 30. The Betrayal';
  books[0].chapters = [{ id: 'chapter-1', title: books[0].tracks[0].title,
    trackId: books[0].tracks[0].id, trackIndex: 0, startSeconds: 0, endSeconds: 120, source: 'embedded' }];
  books[0].readingFile = { id: 'ebook', fileName: 'fixture.epub', extension: 'epub', contentType: 'application/epub+zip', url: '/fixture.epub' };
  await page.addInitScript(() => {
    localStorage.setItem('operalibre.readalong.enabled', 'true');
    localStorage.setItem('operalibre.games.enabled', 'true');
  });
  const user = { id: 'layout-owner', username: 'Layout owner', isAdmin: true, isOwner: true,
    canApproveLibationRequests: true, allowedBookIds: null, libationAccess: 'none',
    shareProgress: false, announceFinishes: false, notifyFinishes: false, createdAt: '1700000000' };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = [];
    if (path === '/api/auth/status') body = { setupRequired: false, user, mediaToken: 'fixture' };
    else if (path === '/api/auth/me') body = user;
    else if (path === '/api/books') body = books;
    else if (path === '/api/users') body = [user];
    else if (path === '/api/libation/status') body = { accounts: [], configured: false, available: false };
    else if (path === '/api/update') body = { currentVersion: '0.4.2', updateAvailable: false };
    else if (path === '/api/profile/stats') body = { totalHoursRead: 12, booksFinished: 2, totalTracksCompleted: 4,
      currentStreakDays: 1, longestStreakDays: 2, avgDailyMinutes: 20, lastListenedAt: null,
      favoriteNarrator: null, favoriteGenre: null, daysActive: 2, memberSince: '1700000000',
      streakCalendar: [], recentBooks: [], measuringSince: null };
    await route.fulfill({ json: body });
  });
  await page.goto(`${url}test/duo-shell.html`);
  await expect(page.locator('.book-row')).toHaveCount(30);
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 110,
      fold: { x: 0, y: 460, width: 669, height: 31, axis: 'horizontal', active: false } });
  });
  const checkPanes = async (upper: string, lower: string) => {
    const top = (await page.locator(upper).boundingBox())!;
    const bottom = (await page.locator(lower).boundingBox())!;
    expect(top.y).toBeGreaterThanOrEqual(0);
    expect(top.y + top.height).toBeLessThanOrEqual(460.5);
    expect(bottom.y).toBeGreaterThanOrEqual(490.5);
    expect(bottom.y + bottom.height).toBeLessThanOrEqual(951.5);
    for (const selector of [upper, lower]) {
      expect(await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
  };
  // Just browsing, the library keeps the whole screen and the transport is
  // the floating mini-player — no player page forced onto the lower screen.
  const browsingLibrary = (await page.locator('.library-pane').boundingBox())!;
  expect(browsingLibrary.y).toBeLessThanOrEqual(0.5);
  expect(browsingLibrary.y + browsingLibrary.height).toBeGreaterThan(460.5);
  await expect(page.locator('.player-pane')).toBeHidden();

  await page.locator('.book-row').first().click();
  await checkPanes('.library-pane', '.player-pane');
  await expect(page.locator('.readalong-invite')).toBeVisible();
  expect(await page.locator('.readalong-invite').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '../../output/duo-shelf-portrait.png' });
  await page.getByRole('button', { name: `Play ${books[0].title}`, exact: true }).click();
  await expect(page.locator('.native-now-playing')).toBeVisible();
  for (const [width, height, axis] of [[951, 669, 'vertical'], [850, 600, 'vertical'], [669, 951, 'horizontal'], [466, 678, 'closed'], [844, 390, 'closed']] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(async ({ width, height, axis }) => {
      const modulePath = '/src/deviceFold.ts';
      const { applyDeviceFold } = await import(modulePath);
      applyDeviceFold(document.documentElement, axis === 'closed' ? { posture: 'closed', angle: 0 } : {
        posture: 'half-open', angle: 110,
        fold: axis === 'vertical'
          ? { x: (width - 31) / 2, y: 0, width: 31, height, axis, active: true }
          : { x: 0, y: 460, width, height: 31, axis, active: true }
      });
      document.documentElement.style.setProperty('--tabs-h', axis === 'vertical' ? '0px' : '80px');
    }, { width, height, axis });
    for (const tab of axis === 'closed' ? ['Reading'] : ['Reading', 'Shelf']) {
      // The fixture has HTML tabs instead of UIKit's side rail; zero bottom
      // inset intentionally hides them in landscape. Exercise their handlers.
      await page.locator('.spine-tab').filter({ hasText: tab }).dispatchEvent('click');
      // Browsing the horizontal-fold Shelf keeps the library full screen and
      // the transport a floating mini-player — no player page is forced onto
      // the lower screen just because a book happens to be playing.
      if (tab === 'Shelf' && axis === 'horizontal') {
        await expect(page.locator('.player-pane')).toBeHidden();
        await expect(page.locator('.mini-player')).toBeVisible();
        const library = (await page.locator('.library-pane').boundingBox())!;
        expect(library.height).toBeGreaterThan(height / 2);
        await page.screenshot({ path: `../../output/playwright/duo-static-${width}-${tab}.png` });
        continue;
      }
      const pane = page.locator('.player-pane');
      await expect.poll(() => pane.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
      expect(await pane.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const bounds = (await pane.boundingBox())!;
      for (const element of await page.locator('.native-now-playing button, .native-now-artwork, .native-now-copy, .native-now-timeline').all()) {
        const box = (await element.boundingBox())!;
        expect(box.y, `${axis} ${width} top`).toBeGreaterThanOrEqual(bounds.y);
        expect(box.y + box.height, `${axis} ${width} bottom`).toBeLessThanOrEqual(bounds.y + bounds.height - (axis === 'vertical' ? 0 : 80) + 1);
      }
      await expect(page.locator('.player-pane > .folio')).toBeHidden();
      await page.screenshot({ path: `../../output/playwright/duo-static-${width}-${tab}.png` });
    }
  }
  await page.setViewportSize({ width: 669, height: 951 });
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 110,
      fold: { x: 0, y: 460, width: 669, height: 31, axis: 'horizontal', active: false } });
  });
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  await checkPanes('.games-shell', '.match-board-frame');
  await page.getByRole('tab', { name: 'Word Grid', exact: true }).click();
  await checkPanes('.games-shell', '.word-keys');
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();
  await expect(page.locator('.ledger-upper')).toBeVisible();
  await checkPanes('.ledger-upper', '.ledger-lower');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await checkPanes('.settings-upper', '.settings-lower');
  await page.screenshot({ path: '../../output/duo-settings-portrait.png' });
  await page.getByRole('button', { name: 'Administration', exact: true }).click();
  await checkPanes('.admin-navigation', '.admin-content');
  await page.getByRole('button', { name: 'Users & access', exact: true }).click();
  await checkPanes('.admin-navigation', '.admin-content');
  await page.screenshot({ path: '../../output/duo-admin-portrait.png' });
  await page.setViewportSize({ width: 951, height: 669 });
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 90,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } });
  });
  const left = (await page.locator('.admin-navigation').boundingBox())!;
  const right = (await page.locator('.admin-content').boundingBox())!;
  expect(left.x + left.width).toBeLessThanOrEqual(460);
  expect(right.x).toBeGreaterThanOrEqual(491);
  expect(right.x).toBeLessThanOrEqual(492);
  expect(right.width).toBeGreaterThan(450);
  expect(await page.locator('.admin-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '../../output/duo-admin-landscape.png' });
  await page.getByRole('button', { name: 'Shelf', exact: true }).click();
  await page.locator('.book-row').first().click();
  await expect(page.locator('.readalong-invite')).toBeVisible();
  expect(await page.locator('.readalong-invite').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '../../output/duo-shelf-landscape.png' });
});
