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

async function openShell(page: Page, native: boolean, admin = false, inProgress = false, books = library(6), extraDeviceRows = 0) {
  const user = { id: 'review-reader', username: 'Reader', isAdmin: admin, isOwner: admin,
    canApproveLibationRequests: admin, allowedBookIds: null, libationAccess: 'direct',
    shareProgress: false, announceFinishes: false, notifyFinishes: false, createdAt: '1700000000' };
  if (inProgress) {
    books[0].progress = {
      status: 'inProgress', bookPositionSeconds: 60, durationSeconds: 240,
      remainingSeconds: 180, percentComplete: 25, updatedAt: '2026-09-26T12:00:00Z'
    };
  }
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
  await expect(page.locator('.book-row')).toHaveCount(books.length + extraDeviceRows);
  return { books, writes };
}

test('native audiobook upload preserves device books and paired local copies', async ({ page }) => {
  const serverBooks = library(6);
  const paired = { ...serverBooks[0], id: 'device-paired', source: 'device', deviceBookId: 'device-paired',
    tracks: serverBooks[0].tracks.map(track => ({ ...track, id: `device-${track.id}`, localFilePath: `device-library/paired/${track.fileName}` })) };
  const deviceOnly = { ...library(1)[0], id: 'device-only', title: 'My imported book', source: 'device', deviceBookId: 'device-only',
    tracks: library(1)[0].tracks.map(track => ({ ...track, id: `import-${track.id}`, localFilePath: `device-library/import/${track.fileName}` })) };
  await page.addInitScript(books => localStorage.setItem('operalibre.deviceLibrary.v1', JSON.stringify(books)), [paired, deviceOnly]);
  await openShell(page, true, true, false, serverBooks, 1);
  const uploaded = { ...library(7)[6], title: 'Uploaded audiobook' };
  await page.route('**/api/library/upload', route => route.fulfill({ json: [...serverBooks, uploaded] }));
  await page.getByRole('button', { name: 'Upload audiobook', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Upload audiobook' });
  await dialog.getByLabel('Book name', { exact: true }).fill(uploaded.title);
  await dialog.locator('input[type=file]').setInputFiles({ name: 'chapter.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('fixture') });
  await dialog.getByRole('button', { name: 'Upload to library', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Return from the uploaded book to the shelf; every native copy is still visible.
  await page.getByRole('button', { name: 'Shelf', exact: true }).click();
  await expect(page.locator('.book-row')).toHaveCount(8);
  await expect(page.locator('.book-row').filter({ hasText: deviceOnly.title })).toBeVisible();
  await page.locator('.book-row').filter({ hasText: paired.title }).click();
  await expect(page.getByLabel('Imported from this device')).toBeVisible();
});

test('native phone shelf shows in-progress books and resumes playback', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const { books } = await openShell(page, true, false, true);
  const shelf = page.getByRole('region', { name: 'Continue Reading' });
  await expect(shelf).toBeVisible();
  const resume = shelf.getByRole('button', { name: `Continue reading ${books[0].title}` });
  await expect(resume).toBeVisible();
  await expect(resume).toHaveCSS('border-radius', '14px');
  await expect(shelf.locator('.continue-reading-meter')).toHaveCSS('border-radius', '999px');
  await expect(shelf.getByRole('button')).toHaveCount(1);
  await resume.click();
  await expect(page.locator('.native-shell')).toHaveClass(/tab-reading/);
  await expect(page.getByRole('region', { name: 'Now playing' })).toBeVisible();
});

test('an offline CarPlay restart survives native acknowledgement and reload', async ({ page }) => {
  await page.addInitScript(() => {
    const bridge = window as unknown as {
      carSessions: unknown[];
      carAcknowledgements: number;
      Capacitor: unknown;
    };
    bridge.carSessions = [];
    bridge.carAcknowledgements = 0;
    bridge.Capacitor = {
      PluginHeaders: [{ name: 'CarPlayBridge', methods: ['getState', 'acknowledgeSessions', 'setLibrary', 'addListener', 'removeListener']
        .map(name => ({ name, rtype: 'promise' })) }],
      nativePromise: async (_plugin: string, method: string) => {
        if (method === 'getState') return { connected: false, sessions: JSON.stringify(bridge.carSessions) };
        if (method === 'acknowledgeSessions') {
          bridge.carSessions = [];
          bridge.carAcknowledgements += 1;
        }
        return {};
      }
    };
  });
  const { books } = await openShell(page, true, false, true);
  const book = books[0];
  let disconnected = true;
  const writes: Record<string, unknown>[] = [];
  await page.route(`**/api/books/${book.id}/progress`, async route => {
    const initial = { bookId: book.id, trackId: book.tracks[0].id, positionSeconds: 60,
      bookPositionSeconds: 60, durationSeconds: 240, updatedAt: book.progress!.updatedAt };
    if (route.request().method() === 'GET') return route.fulfill({ json: initial });
    if (disconnected) return route.abort('internetdisconnected');
    const saved = route.request().postDataJSON() as Record<string, unknown>;
    writes.push(saved);
    await route.fulfill({ json: { ...initial, ...saved, updatedAt: new Date().toISOString() } });
  });
  await page.evaluate(session => {
    (window as unknown as { carSessions: unknown[] }).carSessions = [session];
    document.dispatchEvent(new Event('visibilitychange'));
  }, { bookId: book.id, trackId: book.tracks[0].id, positionSeconds: 0, bookPositionSeconds: 0,
    durationSeconds: 240, updatedAt: Date.now() - 1_000, intentionalRegression: true });
  await expect.poll(() => page.evaluate(() => (window as unknown as { carAcknowledgements: number }).carAcknowledgements)).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('operalibre.progressSeekIntent.v1.')).length)).toBe(1);
  disconnected = false;
  await page.reload();
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes[0]).toMatchObject({ bookPositionSeconds: 0, intentionalSeek: true, intentionalRegression: true });
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('operalibre.progressSeekIntent.v1.')).length)).toBe(0);
});

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

for (const native of [false, true]) {
  test(`${native ? 'native' : 'web'} full book page from Now Playing uses the library details view`, async ({ page }) => {
    const { books } = await openShell(page, native);
    await page.locator('.book-row').first().click();
    await page.getByRole('button', { name: `Play ${books[0].title}`, exact: true }).click();
    await page.locator('.native-now-utility').getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByRole('button', { name: 'Full book page', exact: true }).click();

    await expect(page.locator('.details-sheet')).toHaveCount(0);
    await expect(page.locator('.book-heading h2')).toHaveText(books[0].title);
    for (const selector of ['.track-line', '.transport', '.timeline', '.controls-grid']) {
      await expect(page.locator(`.player-pane > ${selector}`)).toBeHidden();
    }
    if (native) {
      await expect(page.locator('.native-shell')).toHaveClass(/tab-shelf.*library-book-open/);
      await expect(page.getByRole('button', { name: 'Back to Library', exact: true })).toBeVisible();
    } else {
      await expect(page.locator('.book-colophon')).toBeVisible();
      const returnToPlayer = page.getByRole('button', { name: 'Return to Now Playing', exact: true });
      await expect(returnToPlayer).toBeVisible();
      await returnToPlayer.click();
      await expect(page.getByRole('region', { name: 'Now playing', exact: true })).toBeVisible();
    }
  });
}

test('web Back to Now Playing carries the page through a view transition', async ({ page }) => {
  await page.addInitScript(() => {
    const transitions = (window as unknown as { transitionCount: number });
    transitions.transitionCount = 0;
    const start = document.startViewTransition?.bind(document);
    if (!start) return;
    document.startViewTransition = ((update: () => void) => {
      transitions.transitionCount += 1;
      return start(update);
    }) as typeof document.startViewTransition;
  });
  const { books } = await openShell(page, false);
  await page.locator('.book-row').first().click();
  await page.getByRole('button', { name: `Play ${books[0].title}`, exact: true }).click();
  await page.locator('.book-row').nth(1).click();
  const back = page.getByRole('button', { name: 'Back to Now Playing', exact: true });
  await expect(back).toBeVisible();
  const before = await page.evaluate(() => (window as unknown as { transitionCount: number }).transitionCount);
  await back.click();
  await expect(back).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { transitionCount: number }).transitionCount)).toBe(before + 1);
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

const longCast = Array.from({ length: 24 }, (_, i) => `Narrator ${i + 1} Example`).join(', ');

async function foldDetails(page: Page, posture: 'closed' | 'half-open' | 'flat') {
  await page.setViewportSize(posture === 'closed' ? { width: 466, height: 678 } : { width: 951, height: 669 });
  // WKWebView puts the overlay scroll indicator at the safe-area edge, not
  // necessarily at the viewport edge. Include the native trailing rail.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { right: posture === 'closed' ? 0 : 84 } });
  await cdp.detach();
  await page.evaluate(async posture => {
    const root = document.documentElement;
    root.classList.toggle('side-rail', posture !== 'closed');
    for (const [name, value] of Object.entries({ '--rail-x': '867px', '--rail-width': '84px',
      '--rail-top': '120px', '--rail-bottom': '380px' })) root.style.setProperty(name, value);
    const path = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(path);
    applyDeviceFold(document.documentElement, { posture, angle: posture === 'closed' ? 0 : posture === 'flat' ? 180 : 110,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: posture !== 'closed' } });
  }, posture);
  await expect(page.locator('html')).toHaveAttribute('data-fold-posture', posture);
}

async function expectCompactDetails(page: Page) {
  const heading = page.locator('.book-heading');
  await expect(async () => {
    const cover = await heading.locator('.large-cover').boundingBox();
    const title = await heading.locator('h2').boundingBox();
    const credits = await heading.locator('.book-credits').boundingBox();
    const runtime = await heading.locator('.book-runtime').boundingBox();
    const play = await heading.locator('.book-quick-start').boundingBox();
    const actions = await heading.locator('.heading-actions').boundingBox();
    expect(cover && title && credits && runtime && play && actions).toBeTruthy();
    expect(title!.x).toBeGreaterThan(cover!.x + cover!.width);
    expect(credits!.x).toBeCloseTo(title!.x, 0);
    expect(title!.y).toBeLessThan(cover!.y + cover!.height);
    expect(play!.y).toBeGreaterThanOrEqual(Math.max(cover!.y + cover!.height, runtime!.y + runtime!.height) - 1);
    expect(actions!.y).toBeGreaterThanOrEqual(play!.y + play!.height - 1);
    expect(actions!.x).toBeCloseTo(cover!.x, 0);
    expect(actions!.width).toBeGreaterThan(cover!.width * 2);
    if (await page.locator('html.side-rail').count()) {
      const pane = page.locator('.native-shell > .player-pane');
      const bounds = (await pane.boundingBox())!;
      // Measure actual content clearance; scrollbar-gutter alone does not
      // reserve space for WebKit's overlay indicator inside the safe area.
      const indicatorEdge = bounds.x + bounds.width - 84;
      expect(indicatorEdge - (play!.x + play!.width)).toBeGreaterThanOrEqual(12);
      expect(indicatorEdge - (actions!.x + actions!.width)).toBeGreaterThanOrEqual(12);
      await expect(pane).toHaveCSS('overflow-y', 'auto');
    }
  }).toPass({ timeout: 5000 });
  await expect(heading.locator('.heading-actions')).toHaveCSS('display', 'grid');
}

for (const playing of [false, true]) {
  test(`Duo credits and compact grid survive fold transitions with playback ${playing ? 'present' : 'absent'}`, async ({ page }, testInfo) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 466, height: 678 });
    const books = library(6);
    books[0].narrator = longCast;
    await openShell(page, true, false, false, books);
    await foldDetails(page, 'closed');
    await page.locator('.book-row').nth(playing ? 1 : 0).click();
    if (playing) {
      await page.getByRole('button', { name: `Play ${books[1].title}`, exact: true }).click();
      await page.locator('.native-now-utility').getByRole('button', { name: 'Details', exact: true }).click();
      await page.getByRole('button', { name: 'Full book page', exact: true }).click();
      await page.getByRole('button', { name: 'Back to Library', exact: true }).click();
      await page.locator('.book-row').first().click();
    }
    for (const posture of ['closed', 'half-open', 'flat', 'closed'] as const) {
      await foldDetails(page, posture);
      await expectCompactDetails(page);
      const toggle = page.getByRole('button', { name: /^Show all narrators/ });
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
      const narrator = page.locator('.book-narrator:not(.book-narrator-measure)');
      await expect(narrator).toHaveAttribute('id', (await toggle.getAttribute('aria-controls'))!);
      const collapsed = (await narrator.boundingBox())!.height;
      const lineHeight = await narrator.evaluate(el => parseFloat(getComputedStyle(el).lineHeight));
      expect(collapsed).toBeCloseTo(lineHeight * 2, 0);
      if (!playing) await page.screenshot({ path: testInfo.outputPath(`${posture}-collapsed.png`) });
      await toggle.focus();
      await page.keyboard.press('Enter');
      const less = page.getByRole('button', { name: /^Show less/ });
      await expect(less).toHaveAttribute('aria-expanded', 'true');
      expect((await narrator.boundingBox())!.height).toBeGreaterThan(collapsed);
      await expect(page.locator('.book-author')).toHaveText(books[0].author!);
      await expectCompactDetails(page);
      if (posture !== 'closed') {
        const pane = page.locator('.native-shell > .player-pane');
        await pane.evaluate(el => { el.scrollTop = el.scrollHeight; });
        expect(await pane.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
        await expectCompactDetails(page);
        await pane.evaluate(el => { el.scrollTop = 0; });
      }
      if (!playing) await page.screenshot({ path: testInfo.outputPath(`${posture}-expanded.png`) });
      await less.click();
      await expect(toggle).toBeVisible();
    }
  });
}

for (const native of [true, false]) {
  test(`${native ? 'tall phone' : 'desktop'} credits disclose only overflow and reset between books`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize(native ? { width: 393, height: 852 } : { width: 1440, height: 900 });
    const books = library(6);
    books[0].narrator = longCast;
    books[2].author = null; books[2].narrator = null;
    books[3].author = null;
    books[4].narrator = null;
    await openShell(page, native, false, false, books);
    let selected = false;
    async function select(index: number) {
      if (native && selected) {
        await page.getByRole('button', { name: 'Back to Library', exact: true }).click();
      }
      await page.locator('.book-row').nth(index).click();
      await expect(page.locator('.book-heading h2')).toHaveText(books[index].title);
      selected = true;
    }
    await select(0);
    await page.getByRole('button', { name: /^Show all narrators/ }).click();
    await expect(page.getByRole('button', { name: /^Show less/ })).toBeVisible();
    const cover = (await page.locator('.book-heading .large-cover').boundingBox())!;
    const title = (await page.locator('.book-heading h2').boundingBox())!;
    if (native) expect(title.y).toBeGreaterThanOrEqual(cover.y + cover.height);
    else expect(title.x).toBeGreaterThan(cover.x + cover.width);
    await select(1);
    await expect(page.locator('.book-credits-toggle')).toHaveCount(0);
    await expect(page.locator('.book-author')).toHaveText(books[1].author!);
    await expect(page.locator('.book-narrator:not(.book-narrator-measure)')).toHaveText(`Narrated by ${books[1].narrator}`);
    await select(0);
    await expect(page.getByRole('button', { name: /^Show all narrators/ })).toHaveAttribute('aria-expanded', 'false');
    for (const index of [2, 3, 4]) {
      await select(index);
      await expect(page.locator('.book-credits-toggle')).toHaveCount(0);
      if (index === 2) await expect(page.locator('.book-credits')).toHaveText('2 tracks');
      if (index === 3) await expect(page.locator('.book-author')).toHaveCount(0);
      if (index === 4) await expect(page.locator('.book-narrator')).toHaveCount(0);
    }
  });
}

test('credits remeasure width and font changes even while expanded or hidden', async ({ page }) => {
  await page.setViewportSize({ width: 466, height: 678 });
  const books = library(6);
  books[0].narrator = 'Alice Example, Bob Example, Carol Example, David Example';
  await openShell(page, true, false, false, books);
  await page.locator('.book-row').first().click();
  const credits = page.locator('.book-credits');
  await credits.evaluate(el => { el.style.width = '110px'; });
  await page.getByRole('button', { name: /^Show all narrators/ }).click();
  await credits.evaluate(el => { el.style.display = 'none'; });
  await page.setViewportSize({ width: 480, height: 678 });
  await credits.evaluate(el => { el.style.display = ''; el.style.width = '600px'; });
  await expect(page.locator('.book-credits-toggle')).toHaveCount(0);
  await credits.evaluate(el => { el.style.fontSize = '60px'; });
  await expect(page.getByRole('button', { name: /^Show all narrators/ })).toBeVisible();
  await credits.evaluate(el => { el.style.fontSize = '10px'; document.fonts.dispatchEvent(new Event('loadingdone')); });
  await expect(page.locator('.book-credits-toggle')).toHaveCount(0);
});

test('a cached in-progress shelf stays resumable when its server disappears', async ({ page }) => {
  const books = library(2);
  const deviceCopy = { ...books[0], id: 'device-saved', source: 'device', deviceBookId: 'device-saved',
    tracks: books[0].tracks.map(track => ({ ...track, id: `device-${track.id}`, localFilePath: `device-library/saved/${track.fileName}` })) };
  await page.addInitScript(book => localStorage.setItem('operalibre.deviceLibrary.v1', JSON.stringify([book])), deviceCopy);
  await openShell(page, true, false, true, books);
  await expect.poll(async () => page.evaluate(async () => {
    // @ts-expect-error Browser-only Vite import, resolved by the fixture server.
    const offline = await import('/src/offline.ts');
    return (await offline.getCachedLibrary('review-reader')).length;
  })).toBe(books.length);
  await page.route('**/api/books', route => route.abort('failed'));
  await page.reload();
  await expect(page.getByText('Offline mode — showing downloaded books and cached library.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Continue Reading' })).toBeVisible();
  await expect(page.getByRole('button', { name: `Continue reading ${books[0].title}` })).toBeVisible();
});

test('a device import failure is announced on the shelf with a retry', async ({ page }) => {
  await openShell(page, true);
  const notice = page.locator('.library-pane').getByRole('alert');
  for (let attempt = 0; attempt < 2; attempt++) {
    const chosen = page.waitForEvent('filechooser');
    const action = attempt === 0
      ? page.getByRole('button', { name: 'Add audiobook from device', exact: true })
      : notice.getByRole('button', { name: 'Try importing again' });
    await action.click();
    // A browser-picked file has no native path, reproducing the platform's
    // missing-access failure through the real picker and import hook.
    await (await chosen).setFiles({ name: 'sample.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('fixture') });
    await expect(notice).toContainText('The file picker did not provide access');
    await expect(notice.getByRole('button', { name: 'Try importing again' })).toBeEnabled();
  }
});

test('cancelling the device picker stays silent and leaves the shelf usable', async ({ page }) => {
  await openShell(page, true);
  const chosen = page.waitForEvent('filechooser');
  const action = page.getByRole('button', { name: 'Add audiobook from device', exact: true });
  await action.click();
  await (await chosen).element().evaluate(input => input.dispatchEvent(new Event('cancel')));
  await expect(action).toBeEnabled();
  await expect(page.locator('.library-pane').getByRole('alert')).toHaveCount(0);
});
