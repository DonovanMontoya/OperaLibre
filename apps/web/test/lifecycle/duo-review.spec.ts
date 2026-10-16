import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { library, wav } from '../performance/fixtures';
import type { DeviceFoldState } from '../../src/deviceFold';

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
    else if (path === '/api/libation/setup') body = { canSignIn: true, busy: false,
      checks: [{ id: 'installed', label: 'Libation installed', ready: true, message: 'Libation is installed.' }] };
    else if (path === '/api/libation/status') body = { enabled: true, authenticated: true,
      accounts: admin ? [{ id: 'personal', name: 'Personal', accountId: 'owner@example.test', locale: 'us', authenticated: true, managed: true, scanLibrary: true }] : [],
      cliPath: null, libationFilesDir: null, libraryRoot: '', message: null, autoRefreshHours: null, manualRefreshesPerHour: 2 };
    else if (path === '/api/libation/sync') body = { jobId: 'refresh-fixture' };
    await route.fulfill({ json: body });
  });
  await page.goto(native ? `${url}test/duo-shell.html` : url);
  await expect(page.locator('.book-row')).toHaveCount(books.length + extraDeviceRows);
  return { books, writes };
}

async function serveFixtureAudio(page: Page) {
  const audio = wav();
  await page.route('**/fixture-*.wav*', route => {
    const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
    if (!range) return route.fulfill({ contentType: 'audio/wav', body: audio, headers: { 'Accept-Ranges': 'bytes' } });
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : audio.length - 1;
    return route.fulfill({ status: 206, contentType: 'audio/wav', body: audio.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${audio.length}` } });
  });
}

test('removing the selected offline download closes playback without a format error', async ({ page }) => {
  const books = library(2);
  const book = books[0];
  book.tracks.forEach(track => { track.streamUrl = `/fixture-${track.index}.wav`; });
  await openShell(page, false, false, true, books);
  await serveFixtureAudio(page);
  await page.route(`**/api/books/${book.id}/progress`, route => route.fulfill({ json: {
    bookId: book.id, trackId: book.tracks[0].id, positionSeconds: 60,
    bookPositionSeconds: 60, durationSeconds: 240, updatedAt: '2026-09-30T12:00:00Z'
  } }));
  await page.evaluate(async book => {
    // @ts-expect-error Browser-only Vite import, resolved by the fixture server.
    const offline = await import('/src/offline.ts');
    await offline.downloadBookForOffline(book, (path: string) => path, () => {});
  }, book);
  await page.reload();
  await page.getByRole('button', { name: `Continue reading ${book.title}` }).click();
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBe(60);
  await page.locator('.native-now-utility').getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Full book page', exact: true }).click();
  // Keep the shell available while the media server disappears.
  let remoteAudioRequests = 0;
  await page.route('**/fixture-*.wav*', route => {
    remoteAudioRequests++;
    return route.abort('connectionrefused');
  });
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: `Remove ${book.title} from this device`, exact: true }).click();
  await expect(page.getByText('Nothing playing', { exact: true })).toBeVisible();
  await expect(audio).not.toHaveAttribute('src', /.+/);
  await expect.poll(() => page.evaluate(async book => {
    // @ts-expect-error Browser-only Vite import, resolved by the fixture server.
    const offline = await import('/src/offline.ts');
    return offline.isBookDownloaded(book);
  }, book)).toBe(false);
  await page.locator('.book-row').filter({ hasText: book.title }).click();
  await expect(page.getByText('Download removed', { exact: true })).toBeVisible();
  await expect(page.getByText('This audio format is not supported on this device.', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Nothing playing', { exact: true })).toBeVisible();
  await expect(audio).not.toHaveAttribute('src', /.+/);
  expect(remoteAudioRequests).toBe(0);
});

test('Duo paused playback survives folding, rotation, and window resizing without saving progress', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 951, height: 669 });
  const fixtureBooks = library(2);
  const book = fixtureBooks[0];
  book.tracks.forEach(track => { track.streamUrl = `/fixture-${track.index}.wav`; });
  await openShell(page, true, false, true, fixtureBooks);
  await serveFixtureAudio(page);
  const progressWrites: string[] = [];
  page.on('request', request => {
    if (/\/progress(?:\?|$)/.test(request.url()) && ['PUT', 'POST', 'PATCH'].includes(request.method())) {
      progressWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  await page.route(`**/api/books/${book.id}/progress`, route => route.fulfill({ json: {
    bookId: book.id, trackId: book.tracks[1].id, positionSeconds: 30,
    bookPositionSeconds: 150, durationSeconds: 240, updatedAt: '2026-09-30T12:00:00Z'
  } }));
  await page.getByRole('button', { name: `Continue reading ${book.title}` }).click();
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBe(30);
  const states: { name: string; width: number; height: number; state: DeviceFoldState }[] = [
    { name: 'open', width: 951, height: 669, state: { posture: 'flat', angle: 180,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: false } } },
    { name: 'book', width: 951, height: 669, state: { posture: 'half-open', angle: 110,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } } },
    { name: 'acute-book', width: 951, height: 669, state: { posture: 'half-open', angle: 65,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } } },
    { name: 'hinge-status-lag', width: 951, height: 669, state: { posture: 'closed', angle: 0,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } } },
    { name: 'flat-status-lag', width: 951, height: 669, state: { posture: 'flat', angle: 180,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } } },
    { name: 'unknown-status-lag', width: 951, height: 669, state: { posture: 'unknown',
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } } },
    { name: 'tabletop', width: 669, height: 951, state: { posture: 'half-open', angle: 110,
      fold: { x: 0, y: 460, width: 669, height: 31, axis: 'horizontal', active: true } } },
    { name: 'open-rotated', width: 669, height: 951, state: { posture: 'flat', angle: 180,
      fold: { x: 0, y: 460, width: 669, height: 31, axis: 'horizontal', active: false } } },
    { name: 'closed', width: 466, height: 678, state: { posture: 'closed', angle: 0 } },
    { name: 'closed-landscape', width: 678, height: 466, state: { posture: 'closed', angle: 0 } },
    { name: 'narrow-window', width: 320, height: 600, state: { posture: 'flat', angle: 180 } },
    { name: 'short-window', width: 720, height: 360, state: { posture: 'flat', angle: 180 } },
    { name: 'reopened', width: 951, height: 669, state: { posture: 'flat', angle: 180,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: false } } }
  ];
  for (const { name, width, height, state } of states) {
    await test.step(name, async () => {
      await page.setViewportSize({ width, height });
      await page.evaluate(async state => {
        const path = '/src/deviceFold.ts';
        const { applyDeviceFold } = await import(path);
        applyDeviceFold(document.documentElement, state);
      }, state);
      await expect(page.locator('html')).toHaveAttribute('data-fold-posture', state.fold?.active ? 'half-open' : state.posture);
      await expect(page.locator('.native-now-copy > p')).toHaveText(book.title);
      await expect(page.locator('.native-now-play')).toHaveAccessibleName('Play');
      await expect(async () => {
        for (const selector of ['.native-now-timeline', '.native-now-transport', '.native-now-utility']) {
          const bounds = await page.locator(selector).boundingBox();
          expect(bounds, `${name}: ${selector} exists`).not.toBeNull();
          expect(bounds!.x, `${name}: ${selector} left`).toBeGreaterThanOrEqual(0);
          expect(bounds!.y, `${name}: ${selector} top`).toBeGreaterThanOrEqual(0);
          expect(bounds!.x + bounds!.width, `${name}: ${selector} right`).toBeLessThanOrEqual(width + 1);
          expect(bounds!.y + bounds!.height, `${name}: ${selector} bottom`).toBeLessThanOrEqual(height + 1);
          if (state.fold?.active) {
            if (state.fold.axis === 'vertical') {
              expect(bounds!.x, `${name}: ${selector} clears hinge`).toBeGreaterThanOrEqual(state.fold.x + state.fold.width);
            } else {
              expect(bounds!.y, `${name}: ${selector} clears hinge`).toBeGreaterThanOrEqual(state.fold.y + state.fold.height);
            }
          }
        }
      }).toPass({ timeout: 5000 });
      expect(await audio.evaluate((element: HTMLAudioElement) => ({
        paused: element.paused, time: element.currentTime, source: new URL(element.currentSrc).pathname
      }))).toEqual({ paused: true, time: 30, source: '/fixture-1.wav' });
      expect(progressWrites).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
    });
  }
});

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

test('native phone Continue Reading opens paused, plays explicitly, and remembers autoplay', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const fixtureBooks = library(6);
  fixtureBooks[0].tracks.forEach(track => { track.streamUrl = `/fixture-${track.index}.wav`; });
  const { books } = await openShell(page, true, false, true, fixtureBooks);
  const book = books[0];
  const progressWrites: unknown[] = [];
  await serveFixtureAudio(page);
  await page.route(`**/api/books/${book.id}/progress`, route => {
    if (route.request().method() !== 'GET') progressWrites.push(route.request().postDataJSON());
    return route.fulfill({ json: { bookId: book.id, trackId: book.tracks[1].id,
      positionSeconds: 30, bookPositionSeconds: 150, durationSeconds: 240,
      updatedAt: '2026-09-30T12:00:00Z' } });
  });
  await page.reload();
  const shelf = page.getByRole('region', { name: 'Up Next' });
  const resume = shelf.getByRole('button', { name: `Continue reading ${book.title}` });
  const play = shelf.getByRole('button', { name: `Play ${book.title}`, exact: true });
  await expect(resume).toBeVisible();
  await expect(resume).toHaveCSS('border-radius', '14px');
  await expect(shelf.locator('.continue-reading-meter')).toHaveCSS('border-radius', '999px');
  await expect(shelf.getByRole('button')).toHaveCount(2);
  await resume.click();
  await expect(page.locator('.native-shell')).toHaveClass(/tab-reading/);
  await expect(page.getByRole('region', { name: 'Now playing' })).toBeVisible();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBe(30);
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  expect(progressWrites).toEqual([]);
  await page.getByRole('button', { name: 'Shelf', exact: true }).click();
  await play.click();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  await page.getByRole('button', { name: 'Shelf', exact: true }).click();
  await resume.click();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.settings-shell').getByText('Cadence', { exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Games tab', exact: true })).toBeHidden();
  await page.locator('.behavior-settings > summary').scrollIntoViewIfNeeded();
  await page.locator('.behavior-settings > summary').click();
  const toggle = page.getByRole('switch', { name: 'Play when opening a book in progress' });
  await expect(toggle).toBeVisible();
  await page.locator('.behavior-settings > summary').click();
  await expect(toggle).toBeHidden();
  await page.locator('.behavior-settings > summary').focus();
  await page.locator('.behavior-settings > summary').press('Enter');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.behavior-settings > summary').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Shelf', exact: true }).click();
  await resume.click();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.behavior-settings > summary').click();
  await toggle.click();
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.behavior-settings > summary').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');

});

test('browser Continue Reading keeps listed progress when the server fails and exposes autoplay', async ({ page }) => {
  const fixtureBooks = library(2);
  const book = fixtureBooks[1];
  book.tracks.forEach(track => { track.streamUrl = `/fixture-${track.index}.wav`; });
  book.progress = { status: 'inProgress', bookPositionSeconds: 150, durationSeconds: 240,
    remainingSeconds: 90, percentComplete: 62.5, updatedAt: '2026-09-30T12:00:00Z' };
  await openShell(page, false, false, false, fixtureBooks);
  await serveFixtureAudio(page);
  const progressWrites: unknown[] = [];
  await page.route(`**/api/books/${book.id}/progress`, route => {
    if (route.request().method() !== 'GET') progressWrites.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: 'Server unavailable' } });
  });
  await page.getByRole('button', { name: `Continue reading ${book.title}` }).click();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBe(30);
  expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  expect(progressWrites).toEqual([]);
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.locator('.behavior-settings > summary').click();
  const toggle = page.getByRole('switch', { name: 'Play when opening a book in progress' });
  await expect(toggle).toBeVisible();
  await page.locator('.behavior-settings > summary').click();
  await expect(toggle).toBeHidden();
  await page.locator('.behavior-settings > summary').focus();
  await page.locator('.behavior-settings > summary').press('Enter');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.locator('.behavior-settings > summary').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
});

for (const native of [false, true]) {
  test(`${native ? 'native' : 'web'} Continue Reading preserves the current book's playback state`, async ({ page }) => {
    const fixtureBooks = library(2);
    for (const book of fixtureBooks) {
      book.tracks.forEach(track => { track.streamUrl = `/fixture-${book.id}-${track.index}.wav`; });
      book.progress = { status: 'inProgress', bookPositionSeconds: 60, durationSeconds: 240,
        remainingSeconds: 180, percentComplete: 25, updatedAt: '2026-09-30T12:00:00Z' };
    }
    await openShell(page, native, false, false, fixtureBooks);
    await serveFixtureAudio(page);
    await page.route('**/api/books/*/progress', route =>
      route.fulfill({ status: 503, json: { error: 'Server unavailable' } }));
    const [book, otherBook] = fixtureBooks;
    const audio = page.locator('audio');
    const openFromShelf = async (title: string) => {
      if (native) await page.getByRole('button', { name: 'Shelf', exact: true }).click();
      await page.getByRole('button', { name: `Continue reading ${title}`, exact: true }).click();
    };
    await openFromShelf(book.title);
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBe(60);
    await page.locator('.native-now-play').click();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(61);
    await audio.evaluate(element => {
      element.dataset.pauseCount = '0';
      element.addEventListener('pause', () => {
        element.dataset.pauseCount = String(Number(element.dataset.pauseCount) + 1);
      });
    });
    const before = await audio.evaluate((element: HTMLAudioElement) => element.currentTime);
    await openFromShelf(book.title);
    await expect(page.locator('.native-now-play')).toHaveAttribute('aria-label', 'Pause');
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(before + 1);
    await expect(audio).toHaveAttribute('data-pause-count', '0');

    await page.locator('.native-now-play').click();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    const paused = await audio.evaluate((element: HTMLAudioElement) => element.currentTime);
    await openFromShelf(book.title);
    expect(await audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    expect(await audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBe(paused);

    await page.locator('.native-now-play').click();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
    await openFromShelf(otherBook.title);
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBe(60);
    expect(await audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    await expect(audio).toHaveAttribute('src', new RegExp(otherBook.tracks[0].streamUrl));
  });

  test(`${native ? 'native' : 'web'} Play after paused Continue Reading accepts delayed server progress`, async ({ page }) => {
    const fixtureBooks = library(2);
    const book = fixtureBooks[1];
    book.tracks.forEach(track => { track.streamUrl = `/fixture-${track.index}.wav`; });
    book.progress = { status: 'inProgress', bookPositionSeconds: 150, durationSeconds: 240,
      remainingSeconds: 90, percentComplete: 62.5, updatedAt: '2026-09-26T12:00:00Z' };
    await openShell(page, native, false, false, fixtureBooks);
    await serveFixtureAudio(page);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const writes: Record<string, unknown>[] = [];
    await page.route(`**/api/books/${book.id}/progress`, async route => {
      if (route.request().method() === 'GET') await held;
      else writes.push(route.request().postDataJSON());
      await route.fulfill({ json: { bookId: book.id, trackId: book.tracks[1].id,
        positionSeconds: 90, bookPositionSeconds: 210, durationSeconds: 240,
        updatedAt: '2026-09-30T12:00:00Z' } });
    });
    await page.getByRole('button', { name: `Continue reading ${book.title}` }).click();
    const audio = page.locator('audio');
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBe(30);
    await page.locator('.native-now-play').click();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => !element.paused && element.currentTime > 31)).toBe(true);
    expect(writes).toEqual([]);
    release();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThanOrEqual(90);
    await page.locator('.native-now-play').click();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    expect(writes.every(write => Number(write.bookPositionSeconds) >= 210)).toBe(true);
  });
}

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
  await page.getByRole('button', { name: 'Get books', exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Open Settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Connect Libro.fm', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Connect Libro.fm', exact: true }).press('Enter');
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill('reader@example.com');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Connect Libro.fm', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Close Libro.fm management' }).press('Enter');
  await expect(page.getByRole('button', { name: 'Manage Libro.fm', exact: true })).toBeVisible();
  await expect(page.getByText('0 of 0 purchases', { exact: true })).toBeVisible();
  expect(writes).toContain('/api/me/libro');
});

test('web Audible management can request a purchase refresh', async ({ page }) => {
  const { writes } = await openShell(page, false, true);
  await page.getByRole('button', { name: 'Get books', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Manage Audible', exact: true }).press('Enter');
  const management = page.getByRole('dialog', { name: 'Audible accounts & imports', exact: true });
  await expect(management).toBeVisible();
  await management.getByRole('button', { name: 'Refresh purchases', exact: true }).press('Enter');
  await expect.poll(() => writes).toContain('/api/libation/sync');
});

test('native server clients can manage Libro.fm without the device plugin', async ({ page }) => {
  await openShell(page, true);
  await page.getByRole('button', { name: 'Settings', exact: true }).press('Enter');
  await page.locator('.store-settings-group > summary').filter({ hasText: 'Libro.fm' }).press('Enter');
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

test('the half-open Duo Shelf is one page: Up Next in a band off the hinge, progress filter above the books', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 951, height: 669 });
  const { books } = await openShell(page, true, false, true, library(12));
  await page.evaluate(async ids => {
    const queuePath = '/src/readingQueue.ts', apiPath = '/src/api.ts';
    const { readingQueueKey } = await import(queuePath);
    const { getServerStorageKey } = await import(apiPath);
    localStorage.setItem(readingQueueKey(getServerStorageKey(), 'review-reader'), JSON.stringify(ids));
  }, books.slice(1, 5).map(book => book.id));
  await page.reload();
  await expect(page.locator('.book-row')).toHaveCount(books.length);
  await page.evaluate(async () => {
    const path = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(path);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 110,
      fold: { x: 455, y: 0, width: 41, height: 669, axis: 'vertical', active: true } });
  });
  await expect(page.locator('.book-leaf')).toHaveCount(2);

  const upNext = page.getByRole('region', { name: 'Up Next', exact: true });
  const entries = upNext.getByRole('listitem');
  await expect(entries).toHaveCount(5);
  const lead = (await entries.first().boundingBox())!;
  expect(lead.x + lead.width).toBeLessThanOrEqual(455);
  const row = (await upNext.getByRole('list').last().boundingBox())!;
  expect(row.x).toBeGreaterThanOrEqual(496);
  for (const entry of (await entries.all()).slice(1)) {
    const box = (await entry.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(496);
    expect(Math.abs(box.y - lead.y)).toBeLessThanOrEqual(1);
  }
  for (const book of await page.locator('.book-row').all()) {
    const box = (await book.boundingBox())!;
    expect(box.x + box.width <= 455 || box.x >= 496).toBe(true);
  }

  // Nothing is pinned: the band leaves with the books it sits above.
  const firstBook = page.locator('.book-row').first();
  const before = { band: (await upNext.boundingBox())!.y, book: (await firstBook.boundingBox())!.y };
  await page.locator('.library-pane').evaluate(pane => pane.scrollTo(0, 150));
  expect((await upNext.boundingBox())!.y).toBeCloseTo(before.band - 150, 0);
  expect((await firstBook.boundingBox())!.y).toBeCloseTo(before.book - 150, 0);
  await page.locator('.library-pane').evaluate(pane => pane.scrollTo(0, 0));

  const progress = page.getByRole('group', { name: 'Filter by reading progress' });
  const filters = (await progress.boundingBox())!;
  expect(filters.x + filters.width).toBeLessThanOrEqual(455);
  await progress.getByRole('button', { name: /^Reading/ }).click();
  await expect(page.locator('.book-row')).toHaveCount(1);
  // The selected word is the only sign of the choice: no count on Filters,
  // and no summary of filters that are on.
  await expect(progress.getByRole('button', { name: /^Reading/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.library-active-filters')).toBeHidden();
  await expect(page.locator('.library-filter-toggle em:visible')).toHaveCount(0);
  // Up Next is the reader's plan: narrowing the shelf to books that leave out
  // the one in progress must not drop it and promote the next into its place.
  const leadTitle = await entries.first().locator('strong').innerText();
  await progress.getByRole('button', { name: /^Not started/ }).click();
  await expect(progress.getByRole('button', { name: /^Not started/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(entries).toHaveCount(5);
  await expect(entries.first().locator('strong')).toHaveText(leadTitle);
  expect((await entries.first().boundingBox())!).toEqual(lead);
  await page.getByRole('button', { name: /^Filters/ }).click();
  await expect(page.getByRole('group', { name: 'Filter by reading progress' })).toHaveCount(1);
  await expect(page.getByRole('group', { name: 'Filter by availability' })).toBeVisible();
});

test('a fully open Duo sets the Shelf as one slab, with no gap kept for the hinge', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 951, height: 669 });
  const fixtureBooks = library(14);
  fixtureBooks.forEach((book, index) => {
    book.metadata = { ...book.metadata, series: index < 8 ? 'Long Series' : null, seriesPosition: index < 8 ? String(index + 1) : null };
  });
  await openShell(page, true, false, false, fixtureBooks);
  await page.evaluate(async () => {
    const path = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(path);
    applyDeviceFold(document.documentElement, { posture: 'flat', angle: 180,
      fold: { x: 455, y: 0, width: 41, height: 669, axis: 'vertical', active: false } });
  });
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  const edges = async () => Promise.all((await page.locator('.book-row').all()).slice(0, 7).map(async book => (await book.boundingBox())!));
  const even = (boxes: { x: number; y: number; width: number }[]) => {
    const steps = boxes.slice(1).map((box, index) => box.x - boxes[index].x);
    return steps.every(step => Math.abs(step - steps[0]) < 1);
  };
  // Six covers to a row at one even pitch: the step over the hinge is the same as any other.
  let covers = await edges();
  expect(covers.slice(0, 6).every(box => Math.abs(box.y - covers[0].y) < 1)).toBe(true);
  expect(even(covers.slice(0, 6))).toBe(true);
  expect(covers[3].x).toBeLessThan(455 + 41);
  expect(covers[6].y).toBeGreaterThan(covers[0].y);

  // A long series is one row that carries on to the right instead of wrapping.
  await page.getByLabel('Sort library by').selectOption({ label: 'Series' });
  const series = page.locator('.book-sort-run', { hasText: 'Long Series' });
  await expect(series.locator('.book-row')).toHaveCount(8);
  covers = await Promise.all((await series.locator('.book-row').all()).map(async book => (await book.boundingBox())!));
  expect(covers.every(box => Math.abs(box.y - covers[0].y) < 1)).toBe(true);
  expect(even(covers)).toBe(true);
  const row = series.locator('.book-run-books');
  expect(await row.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  // Part of the seventh cover stands in view, so the row is seen to go on.
  const edge = (await row.boundingBox())!;
  expect(covers[6].x).toBeLessThan(edge.x + edge.width - 30);
  expect(covers[6].x + covers[6].width).toBeGreaterThan(edge.x + edge.width + 30);
  expect(await row.evaluate(element => getComputedStyle(element).overflowY)).toBe('hidden');
});

test('sorted by title, the open Duo files covers under their letters with an index to jump between them', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 951, height: 669 });
  const shelf = { A: 8, B: 3, D: 7, M: 5, S: 6, T: 9 };
  const titles = ['1984', 'Émile', ...Object.entries(shelf).flatMap(([letter, count]) =>
    Array.from({ length: count }, (_, index) => `${letter}${letter.toLowerCase()} volume ${index + 1}`))];
  const fixtureBooks = library(titles.length);
  fixtureBooks.forEach((book, index) => { book.title = titles[index]; });
  await openShell(page, true, false, false, fixtureBooks);
  const fold = (posture: 'flat' | 'half-open') => page.evaluate(async state => {
    const path = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(path);
    applyDeviceFold(document.documentElement, { posture: state, angle: state === 'flat' ? 180 : 110,
      fold: { x: 455, y: 0, width: 41, height: 669, axis: 'vertical', active: state !== 'flat' } });
  }, posture);
  await fold('flat');
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();

  // A digit files under "#", and an accented letter with the plain one.
  const letters = page.locator('.book-letter');
  await expect(letters.locator('strong')).toHaveText(['#', 'A', 'B', 'D', 'E', 'M', 'S', 'T']);
  await expect(page.getByRole('heading', { name: 'A, 8 books' })).toBeVisible();
  const section = (letter: string) => page.locator(`.book-sort-run[data-letter="${letter}"]`);
  const covers = await Promise.all((await section('A').locator('.book-row').all()).map(async book => (await book.boundingBox())!));
  // The letter stands in the margin; its books run six to a row beside it.
  const letter = (await section('A').locator('.book-letter').boundingBox())!;
  expect(letter.x + letter.width).toBeLessThanOrEqual(covers[0].x);
  expect(covers.slice(0, 6).every(box => Math.abs(box.y - covers[0].y) < 1)).toBe(true);
  expect(covers[6].y).toBeGreaterThan(covers[0].y);
  expect(Math.abs(covers[6].x - covers[0].x)).toBeLessThan(1);

  const index = page.getByRole('navigation', { name: 'Jump to a letter' });
  await expect(index.getByRole('button', { name: 'Numbers and symbols', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(index.getByRole('button', { name: 'Q', exact: true })).toBeDisabled();
  const strip = (await index.boundingBox())!;
  expect(strip.y + strip.height).toBeLessThanOrEqual(669);
  expect(strip.x).toBeGreaterThanOrEqual(covers[5].x + covers[5].width);

  await index.getByRole('button', { name: 'S', exact: true }).click();
  await expect.poll(async () => (await section('S').boundingBox())!.y).toBeLessThan(40);
  await expect(index.getByRole('button', { name: 'S', exact: true })).toHaveAttribute('aria-current', 'true');
  // Its heading holds level with the first row of its books.
  const held = (await section('S').locator('.book-letter').boundingBox())!;
  expect(Math.abs(held.y - (await section('S').locator('.book-row').first().boundingBox())!.y)).toBeLessThan(3);
  // The index stays put while the page moves under it.
  expect((await index.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  expect((await index.boundingBox())!.y + strip.height).toBeLessThanOrEqual(669);

  // Drawing along the strip moves through the letters under the pointer.
  const key = async (name: string) => {
    const box = (await index.getByRole('button', { name, exact: true }).boundingBox())!;
    return [box.x + box.width / 2, box.y + box.height / 2] as const;
  };
  await page.mouse.move(...await key('M'));
  await page.mouse.down();
  await page.mouse.move(...await key('B'), { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await section('B').boundingBox())!.y).toBeLessThan(40);
  await expect(index.getByRole('button', { name: 'B', exact: true })).toHaveAttribute('aria-current', 'true');
  await page.locator('.library-pane').evaluate(pane => pane.scrollTo(0, 0));
  await expect(index.getByRole('button', { name: 'Numbers and symbols', exact: true })).toHaveAttribute('aria-current', 'true');

  // Half open, each row still breaks at the hinge.
  await fold('half-open');
  await expect(letters).toHaveCount(8);
  for (const book of await page.locator('.book-row').all()) {
    const box = (await book.boundingBox())!;
    expect(box.x + box.width <= 455 || box.x >= 496).toBe(true);
  }
  await fold('flat');

  // Only covers sorted by title are filed this way.
  await page.getByLabel('Sort library by').selectOption({ label: 'Author' });
  await expect(letters).toHaveCount(0);
  await expect(index).toHaveCount(0);
  await page.getByLabel('Sort library by').selectOption({ label: 'Title' });
  await expect(letters).toHaveCount(8);
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(letters).toHaveCount(0);
});

test('grid tiles keep their title, facts and reading state in the same places whatever a book carries', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  const fixtureBooks = library(4);
  fixtureBooks[0].title = 'A Title Long Enough That It Has To Wrap Onto A Second Line';
  fixtureBooks[0].sharedProgress = [
    { userId: 'other', username: 'Victoria', status: 'finished', percentComplete: 100, updatedAt: '2026-09-26T12:00:00Z' }
  ];
  fixtureBooks[1].title = 'Short';
  await openShell(page, true, false, false, fixtureBooks);
  await page.getByRole('button', { name: 'Grid view', exact: true }).click();
  const tiles = page.locator('.book-row');
  const offsets = async (index: number) => {
    const tile = tiles.nth(index);
    const top = (await tile.boundingBox())!.y;
    const part = async (selector: string) => Math.round((await tile.locator(selector).boundingBox())!.y - top);
    return { byline: await part('.book-text > strong + span'), facts: await part('.book-runtime-tag'), state: await part('.book-progress') };
  };
  expect(await offsets(1)).toEqual(await offsets(0));
  // Who else has read it sits on the facts line, not on a line of its own.
  const readers = (await tiles.first().locator('.book-shared-readers').boundingBox())!;
  const runtime = (await tiles.first().locator('.book-runtime-tag').boundingBox())!;
  expect(Math.abs(readers.y + readers.height / 2 - (runtime.y + runtime.height / 2))).toBeLessThanOrEqual(2);
  await expect(tiles.first().locator('.book-shared-readers')).toHaveText('1');
  await expect(tiles.first().locator('.book-shared-readers')).toHaveAttribute('aria-label', /Victoria/);
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

test('native Get books keeps a way to each connected store\'s Settings', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openShell(page, true, true);
  await page.route('**/api/me/libro', route => route.fulfill({ json: {
    connected: true, email: 'reader@example.com', syncedAt: '2026-10-01T12:00:00Z',
    accounts: [{ email: 'reader@example.com', syncedAt: '2026-10-01T12:00:00Z' }], books: [], jobs: []
  } }));
  await page.getByRole('button', { name: 'Get books', exact: true }).press('Enter');
  const libro = page.getByRole('button', { name: 'Libro.fm accounts & settings', exact: true });
  const audible = page.getByRole('button', { name: 'Audible accounts & settings', exact: true });
  await expect(libro).toBeVisible();
  await expect(audible).toBeVisible();
  await expect(page.getByText('0 of 0 purchases', { exact: true })).toHaveCount(0);
  const [libroBox, audibleBox] = [(await libro.boundingBox())!, (await audible.boundingBox())!];
  expect(Math.abs(libroBox.x + libroBox.width - audibleBox.x - audibleBox.width)).toBeLessThan(1);
  const heading = (await page.getByRole('heading', { name: 'Libro.fm', exact: true }).boundingBox())!;
  expect(libroBox.y).toBeLessThan(heading.y + heading.height);
  await libro.press('Enter');
  await expect(page.locator('details.store-settings-group[open]')).toContainText('Libro.fm');
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
  await page.getByRole('button', { name: 'Settings', exact: true }).press('Enter');
  await page.locator('.store-settings-group > summary').filter({ hasText: 'Libro.fm' }).press('Enter');
  await page.getByRole('button', { name: 'Refresh all accounts', exact: true }).press('Enter');
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
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: posture === 'half-open' } });
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
  await expect(page.getByRole('region', { name: 'Up Next' })).toBeVisible();
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


test('a shelf warning opens book details and clears after retrying only missing files', async ({ page, context }) => {
  const books = library(2);
  const book = books[0];
  book.readingFile = { id: 'ebook', fileName: 'book.epub', extension: 'epub', contentType: 'application/epub+zip', url: '/fixture-book.epub' };
  book.syncFile = { fileName: 'sync.json', source: 'sidecar', url: '/fixture-sync.json' };
  book.tracks.forEach(track => { track.streamUrl = `/fixture-${track.index}.wav`; });
  let filesAvailable = false;
  let audioRequests = 0;
  let ebookRequests = 0;
  let syncRequests = 0;
  const progressWrites: string[] = [];
  page.on('request', request => {
    if (/\/fixture-\d+\.wav/.test(request.url())) audioRequests++;
    if (/\/progress(?:\?|$)/.test(request.url()) && request.method() !== 'GET') progressWrites.push(request.method());
  });
  await openShell(page, false, false, true, books);
  await serveFixtureAudio(page);
  await page.route('**/fixture-book.epub*', route => {
    ebookRequests++;
    return route.fulfill({ status: filesAvailable ? 200 : 503, contentType: 'application/epub+zip', body: 'fixture ebook bytes' });
  });
  await page.route('**/fixture-sync.json*', route => {
    syncRequests++;
    return route.fulfill({ status: filesAvailable ? 200 : 503, json: { version: 1, fragments: [{ startSeconds: 0, endSeconds: 1, href: 'chapter.xhtml', text: 'Fixture sentence.' }] } });
  });
  await page.evaluate(async book => {
    // @ts-expect-error Browser-only Vite import, resolved by the fixture server.
    const offline = await import('/src/offline.ts');
    await offline.downloadBookForOffline(book, (path: string) => path, () => {});
  }, book);
  await page.reload();
  const row = page.locator('.book-row').filter({ hasText: book.title });
  const warning = row.locator('.offline-warning-icon');
  await expect(warning).toBeVisible();
  await expect(row.getByRole('img')).toHaveAccessibleName(/Some offline files are missing.*Open book details to retry/);
  await expect(page.locator('.book-row').filter({ hasText: books[1].title }).locator('.offline-warning-icon')).toHaveCount(0);
  await expect(row.locator('.offline-readiness')).toHaveCount(0);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    if (width === 390) await page.getByRole('button', { name: 'Open library', exact: true }).click();
    await expect(row).toBeInViewport();
    await expect(warning).toBeVisible();
    await expect(async () => {
      const badge = await row.locator('.book-availability').boundingBox();
      const title = await row.locator('.book-text strong').boundingBox();
      expect(title!.x + title!.width).toBeLessThanOrEqual(badge!.x);
    }).toPass();
  }
  await row.getByRole('img').click();
  const panel = page.getByRole('region', { name: 'Offline files', exact: true });
  const retry = panel.getByRole('button', { name: `Retry missing files for ${book.title}` });
  await expect(panel).toContainText('Ebook: missing');
  await expect(panel).toContainText('Missing: book.epub, follow-along timing');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(retry).toBeInViewport();
    await expect(async () => {
      const bounds = await retry.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    }).toPass();
  }
  await context.setOffline(true);
  await expect(retry).toBeDisabled();
  await expect(panel).toContainText('Connect to your server to retry missing files.');
  await context.setOffline(false);
  await expect(retry).toBeEnabled();
  const originalAudioRequests = audioRequests;
  await retry.click();
  await expect(page.locator('.player-pane').getByRole('status')).toContainText('Retry missing files when connected.');
  await expect(retry).toBeEnabled();
  await expect(warning).toHaveCount(1);
  const failedEbookRequests = ebookRequests;
  const failedSyncRequests = syncRequests;
  filesAvailable = true;
  await retry.click();
  await expect(panel).toContainText('Ebook: ready');
  await expect(panel).toContainText('Sentence sync: ready');
  await expect(retry).toHaveCount(0);
  await expect(warning).toHaveCount(0);
  expect(audioRequests).toBe(originalAudioRequests);
  expect(ebookRequests).toBe(failedEbookRequests + 1);
  expect(syncRequests).toBe(failedSyncRequests + 1);
  expect(progressWrites).toEqual([]);
  expect(await page.evaluate(async book => {
    // @ts-expect-error Browser-only Vite import, resolved by the fixture server.
    const offline = await import('/src/offline.ts');
    return offline.isBookDownloaded(book);
  }, book)).toBe(true);
});

test('a wide browser window can give the whole page to the Shelf', async ({ page }) => {
  const books = library(8);
  const book = books[0];
  book.tracks.forEach(track => { track.streamUrl = `/fixture-${track.index}.wav`; });
  books[3].readingFile = { id: 'ebook', fileName: 'book.epub', extension: 'epub', contentType: 'application/epub+zip', url: '/fixture-book.epub' };
  // Opening, closing and putting the Shelf away never save a position; only
  // playing does.
  const progressWrites: Array<{ bookId: string; position: number }> = [];
  page.on('request', request => {
    const match = /\/api\/books\/([^/]+)\/progress(?:\?|$)/.exec(request.url());
    if (!match || request.method() === 'GET') return;
    const body = request.postDataJSON() as { bookPositionSeconds?: number; positionSeconds?: number } | null;
    progressWrites.push({ bookId: decodeURIComponent(match[1]), position: body?.bookPositionSeconds ?? body?.positionSeconds ?? -1 });
  });
  await openShell(page, false, false, true, books);
  await serveFixtureAudio(page);
  await page.route('**/fixture-book.epub*', route => route.fulfill({ contentType: 'application/epub+zip', body: 'fixture ebook bytes' }));
  await page.route(`**/api/books/${book.id}/progress`, route => route.fulfill({ json: {
    bookId: book.id, trackId: book.tracks[0].id, positionSeconds: 60,
    bookPositionSeconds: 60, durationSeconds: 240, updatedAt: '2026-09-30T12:00:00Z'
  } }));
  const shell = page.locator('.web-shell');
  await page.getByRole('button', { name: 'Expand shelf' }).click();
  await expect(shell).toHaveClass(/shelf-expanded/);
  await expect(page.locator('.player-pane')).toBeHidden();
  // One page, not the Duo's two leaves: covers by default, reading across, then down.
  await expect(page.locator('.book-list')).toHaveClass(/is-grid/);
  await expect(page.locator('.book-list > .book-leaf')).toHaveCount(1);
  const [first, second] = await page.locator('.book-row').evaluateAll(rows =>
    rows.slice(0, 2).map(row => row.getBoundingClientRect()).map(({ top, left }) => ({ top, left })));
  expect(second.top).toBe(first.top);
  expect(second.left).toBeGreaterThan(first.left);

  await page.reload();
  await expect(shell).toHaveClass(/shelf-expanded/);

  // A book chosen from the whole Shelf opens in a popup over it; closing the
  // popup finds the Shelf where it was, with focus back on the book.
  const pane = page.locator('.library-pane');
  await pane.evaluate(el => el.scrollTo(0, 400));
  const scrolled = await pane.evaluate(el => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  const row = page.locator('.book-row').filter({ hasText: books[3].title });
  await row.click();
  const popup = page.getByRole('dialog', { name: books[3].title });
  await expect(popup.getByRole('heading', { name: books[3].title })).toBeVisible();
  await expect(shell).toHaveClass(/shelf-expanded/);
  await expect(pane).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(row).toBeFocused();
  expect(await pane.evaluate(el => el.scrollTop)).toBe(scrolled);
  // The reading room opens over the Shelf; the popup steps aside until the
  // reader closes.
  await row.click();
  await popup.getByRole('button', { name: 'Open reader' }).click();
  await expect(shell).toHaveClass(/reader-open/);
  await expect(popup).toBeHidden();
  await page.getByRole('button', { name: 'Close the reader', exact: true }).click();
  await expect(shell).not.toHaveClass(/reader-open/);
  await popup.getByRole('button', { name: 'Close book details' }).click();
  await expect(popup).toBeHidden();
  expect(progressWrites).toEqual([]);

  // A book picked up from the Shelf plays beneath it in the mini player, and
  // the Shelf can still be put away; the mini player leads to the reading room.
  await page.getByRole('button', { name: `Continue reading ${book.title}` }).click();
  const miniPlayer = page.getByRole('complementary', { name: 'Mini player' });
  await expect(miniPlayer).toBeVisible();
  await expect(shell).toHaveClass(/shelf-expanded/);
  await expect(page.getByRole('button', { name: 'Collapse shelf' })).toBeVisible();
  await miniPlayer.getByRole('button', { name: 'Open current book' }).click();
  await expect(shell).not.toHaveClass(/shelf-expanded/);
  await expect(page.locator('.player-pane')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Expand shelf' })).toBeVisible();

  // The Player tab beside Library does the same from the Shelf's own bar.
  await page.getByRole('button', { name: 'Expand shelf' }).click();
  await expect(shell).toHaveClass(/shelf-expanded/);
  await page.getByRole('group', { name: 'Library navigation' }).getByRole('button', { name: 'Player' }).click();
  await expect(shell).not.toHaveClass(/shelf-expanded/);
  await expect(page.locator('.player-pane')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Library navigation' }).getByRole('button', { name: 'Player' })).toHaveCount(0);

  // Without motion the popup closes at once.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Expand shelf' }).click();
  await row.click();
  await expect(popup).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(row).toBeFocused();

  // Playing saved the playing book's place, never another book's, and never 0:00.
  expect(progressWrites.every(write => write.bookId === book.id && write.position > 0)).toBe(true);
});

test('a narrow browser window keeps the Shelf beside the reading room', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await page.addInitScript(() => localStorage.setItem('operalibre.shelfExpanded', 'true'));
  await openShell(page, false);
  await expect(page.locator('.web-shell')).not.toHaveClass(/shelf-expanded/);
  await expect(page.locator('.shelf-expand-button')).toHaveCount(0);
});
