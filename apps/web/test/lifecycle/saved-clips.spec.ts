import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { library, wav } from '../performance/fixtures';
import type { Clip } from '../../src/clips';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

async function setup(page: Page, progressAvailable = true) {
  const books = library(2);
  const user = { id: 'clip-reader', username: 'Reader', isAdmin: false, isOwner: false,
    allowedBookIds: null, libationAccess: 'none', createdAt: '1700000000' };
  const clips = new Map<string, Clip[]>(books.map((book, index) => [book.id, [{
    id: String(index).repeat(32), bookId: book.id, startSeconds: 10, endSeconds: 11,
    title: `Passage from book ${index + 1}`, note: null, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z'
  }]]));
  const writes: { bookId: string; position: number }[] = [];
  let failList = false;
  for (const [index, book] of books.entries()) {
    book.chapters = [{ id: `${book.id}-chapter`, title: "A beginning", trackId: book.tracks[0].id, trackIndex: 0, startSeconds: 0, endSeconds: 240, source: "embedded" }];
    book.tracks.forEach(track => { track.streamUrl = `/fixture-${book.id}-${track.index}.wav`; });
    book.progress = { status: 'inProgress', bookPositionSeconds: 60 + index * 30,
      durationSeconds: 240, remainingSeconds: 180 - index * 30, percentComplete: 25,
      updatedAt: '2026-10-01T00:00:00Z' };
  }
  const audio = wav();
  await page.route('**/fixture-*.wav*', route => {
    const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
    if (!range) return route.fulfill({ contentType: 'audio/wav', body: audio, headers: { 'Accept-Ranges': 'bytes' } });
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : audio.length - 1;
    return route.fulfill({ status: 206, contentType: 'audio/wav', body: audio.subarray(start, end + 1),
      headers: { 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${audio.length}` } });
  });
  await page.addInitScript(() => {
    localStorage.setItem('operalibre.serverUrl', location.origin);
    localStorage.setItem('operalibre.serverType', 'operalibre');
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const bookId = path.match(/\/books\/([^/]+)/)?.[1];
    let body: unknown = [];
    if (path === '/api/auth/status') body = { setupRequired: false, user, mediaToken: 'fixture' };
    else if (path === '/api/auth/me') body = user;
    else if (path === '/api/books') body = books;
    else if (path === '/api/me/libro') body = { connected: false, accounts: [], books: [], jobs: [] };
    else if (path === '/api/libation/status') body = { available: false, accounts: [], configured: false };
    else if (bookId && path.endsWith('/clips')) {
      if (failList) return route.fulfill({ status: 503, json: { error: 'Server temporarily unavailable' } });
      body = { clips: clips.get(bookId) ?? [], canExportAudio: true };
    } else if (bookId && path.includes('/clips/') && request.method() === 'PUT') {
      const previous = clips.get(bookId)![0];
      const changed = { ...previous, ...request.postDataJSON() };
      clips.set(bookId, [changed]);
      body = changed;
    } else if (bookId && path.endsWith('/progress')) {
      if (!progressAvailable && bookId === books[1].id && request.method() === 'GET') {
        return route.fulfill({ status: 503, json: { error: 'Progress temporarily unavailable' } });
      }
      const book = books.find(book => book.id === bookId)!;
      if (request.method() !== 'GET') {
        const progress = request.postDataJSON();
        writes.push({ bookId, position: progress.bookPositionSeconds });
        body = { ...progress, accepted: true, updatedAt: '2026-10-01T00:00:01Z' };
      } else body = { bookId, trackId: book.tracks[0].id, positionSeconds: book.progress!.bookPositionSeconds,
        bookPositionSeconds: book.progress!.bookPositionSeconds, durationSeconds: 240, updatedAt: book.progress!.updatedAt };
    }
    await route.fulfill({ json: body });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(url);
  await expect(page.locator('.book-row')).toHaveCount(2);
  const openLibrary = page.getByRole('button', { name: 'Open library', exact: true });
  if (await openLibrary.isVisible()) await openLibrary.click();
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.locator('.book-row')).toHaveCount(2);
  return { books, writes, clips, fail: (value: boolean) => { failList = value; } };
}

for (const width of [390, 1280]) {
  test(`book details opens its clips without starting playback at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const fixture = await setup(page);
    await page.locator('.book-row').nth(1).click();
    const entry = page.getByRole('tab', { name: 'Clips', exact: true });
    await expect(entry).toBeVisible();
    expect(Math.round((await entry.boundingBox())!.height)).toBeGreaterThanOrEqual(44);
    await entry.scrollIntoViewIfNeeded();
    await expect(entry).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath(`details-${width}.png`), animations: 'disabled' });
    await entry.click();
    await expect(page.locator('.book-clip-detail')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`clips-${width}.png`), animations: 'disabled' });
    await page.locator('.book-clip-detail').filter({ hasText: 'Passage from book 2' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Edit clip' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: /Passage from book 2/ })).toBeVisible();
    await expect(dialog.getByText('Passage from book 1', { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Name', { exact: true }).fill('Remember this passage');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('button', { name: 'Saved', exact: true })).toBeVisible();
    expect(fixture.clips.get(fixture.books[1].id)![0].title).toBe('Remember this passage');
    expect(fixture.writes).toEqual([]);
    expect(await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(entry).toBeVisible();
    await expect(page.locator('.book-clip-detail')).toContainText('Remember this passage');
    await page.getByRole('tab', { name: 'Chapters', exact: true }).click();
    await expect(entry).toHaveAttribute('aria-selected', 'false');
    await expect(page.locator('.book-clips')).toHaveCount(0);
    await expect(page.locator('.track-list')).toBeVisible();
    expect(fixture.writes).toEqual([]);
  });
}

for (const progressAvailable of [true, false]) {
  test(`browsing leaves playback alone; preview restores the book’s place with progress ${progressAvailable ? 'available' : 'unavailable'}`, async ({ page }, testInfo) => {
    const fixture = await setup(page, progressAvailable);
    await page.getByRole('button', { name: `Play ${fixture.books[0].title}`, exact: true }).click();
    const audio = page.locator('audio');
    await expect.poll(() => audio.evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(60);
    const playingSource = await audio.getAttribute('src');
    const shortcut = page.getByRole('button', { name: 'Save a clip of the last 30 seconds and the next 10', exact: true });
    await expect(shortcut).toBeVisible();
    const ribbon = (await shortcut.boundingBox())!;
    const cover = (await page.locator('.native-now-artwork > .large-cover').boundingBox())!;
    expect(Math.round(ribbon.height)).toBeGreaterThanOrEqual(44);
    expect(ribbon.x).toBeGreaterThanOrEqual(cover.x);
    expect(ribbon.x + ribbon.width).toBeLessThanOrEqual(cover.x + cover.width);
    expect(Math.abs(ribbon.y - cover.y)).toBeLessThanOrEqual(3);
    await page.screenshot({ path: testInfo.outputPath('cover-ribbon.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Saved clips/ }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: /Passage from book 1/ })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('.book-row').nth(1).click();
    await page.getByRole('tab', { name: 'Clips', exact: true }).click();
    await expect(page.locator('.book-clip-detail').filter({ hasText: 'Passage from book 2' })).toBeVisible();
    expect(await audio.getAttribute('src')).toBe(playingSource);
    expect(await audio.evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(false);
    expect(fixture.writes.filter(write => write.bookId === fixture.books[1].id)).toEqual([]);
    await page.getByRole('button', { name: 'Preview Passage from book 2', exact: true }).click();
    await expect.poll(() => audio.evaluate((audio: HTMLAudioElement) => !audio.paused && audio.currentTime >= 10 && audio.currentTime < 11)).toBe(true);
    await expect.poll(() => audio.evaluate((audio: HTMLAudioElement) => ({ time: audio.currentTime, paused: audio.paused }))).toEqual({ time: 90, paused: true });
    await expect.poll(() => fixture.writes.filter(write => write.bookId === fixture.books[1].id).slice(-1)[0]?.position).toBe(90);
    expect(fixture.writes.some(write => write.position === 0)).toBe(false);
  });
}

test('saved clips exposes loading failures and retry rather than claiming the book is empty', async ({ page }) => {
  const fixture = await setup(page);
  fixture.fail(true);
  await page.locator('.book-row').nth(1).click();
  await page.getByRole('tab', { name: 'Clips', exact: true }).click();
  const dialog = page;
  await expect(dialog.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(dialog.getByText(/No saved clips in this book yet/)).toHaveCount(0);
  fixture.fail(false);
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.book-clip-detail').filter({ hasText: 'Passage from book 2' })).toBeVisible();
  expect(fixture.writes).toEqual([]);
});

test('a book with no clips explains how to save the first passage', async ({ page }) => {
  const fixture = await setup(page);
  fixture.clips.set(fixture.books[1].id, []);
  await page.locator('.book-row').nth(1).click();
  await page.getByRole('tab', { name: 'Clips', exact: true }).click();
  const dialog = page;
  await expect(dialog.getByText(/No saved clips in this book yet/)).toBeVisible();
  await expect(dialog.getByText(/Tap the gold ribbon while listening/)).toBeVisible();
  expect(fixture.writes).toEqual([]);
});

test('Audio clips behavior preference persists and restores saved passages without changing playback', async ({ page }) => {
  const fixture = await setup(page);
  await page.getByRole('button', { name: `Play ${fixture.books[0].title}`, exact: true }).click();
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(60);
  const source = await audio.getAttribute('src');
  const ribbon = page.getByRole('button', { name: 'Save a clip of the last 30 seconds and the next 10', exact: true });
  await expect(ribbon).toBeVisible();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.locator('.user-menu .behavior-settings summary').click();
  const preference = page.getByRole('switch', { name: 'Audio clips', exact: true });
  await expect(preference).toHaveAttribute('aria-checked', 'true');
  await preference.click();
  await expect(ribbon).toHaveCount(0);
  expect(await audio.getAttribute('src')).toBe(source);
  expect(await audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  await page.reload();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.locator('.user-menu .behavior-settings summary').click();
  await expect(preference).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.locator('.book-row').nth(1).click();
  await expect(page.getByRole('tab', { name: 'Clips', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.locator('.user-menu .behavior-settings summary').click();
  await preference.click();
  await expect(preference).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('tab', { name: 'Clips', exact: true }).click();
  await expect(page.locator('.book-clip-detail')).toContainText('Passage from book 2');
  expect(fixture.clips.get(fixture.books[1].id)).toHaveLength(1);
  expect(fixture.writes.some(write => write.position === 0)).toBe(false);
});

test('expanded clip editor shows only its passage and returns to the list', async ({ page }) => {
  const fixture = await setup(page);
  const book = fixture.books[1];
  const first = fixture.clips.get(book.id)![0];
  fixture.clips.set(book.id, [first, { ...first, id: 'a'.repeat(32), title: 'Another saved passage', startSeconds: 30, endSeconds: 40 }]);
  await page.locator('.book-row').nth(1).click();
  await page.getByRole('tab', { name: 'Clips', exact: true }).click();
  await page.getByRole('button', { name: 'Manage clips', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('.clip-row')).toHaveCount(2);
  await dialog.getByRole('button', { name: /Another saved passage/ }).click();
  await expect(dialog.getByRole('heading', { name: 'Edit clip', exact: true })).toBeVisible();
  await expect(dialog.locator('.clip-row')).toHaveCount(1);
  await expect(dialog.getByText('Passage from book 2', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('Another saved passage');
  await dialog.getByRole('button', { name: 'Back to clips', exact: true }).click();
  await expect(dialog.getByRole('heading', { name: 'Saved clips', exact: true })).toBeVisible();
  await expect(dialog.locator('.clip-row')).toHaveCount(2);
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
});

test('interrupted preview never checkpoints its temporary position or seek intent', async ({ page }) => {
  const fixture = await setup(page);
  const book = fixture.books[1];
  fixture.clips.get(book.id)![0].endSeconds = 25;
  await page.locator('.book-row').nth(1).click();
  await page.getByRole('tab', { name: 'Clips', exact: true }).click();
  await page.getByRole('button', { name: 'Preview Passage from book 2', exact: true }).click();
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(13);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const durable = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('operalibre.progressCheckpoint.v1')).map(([, value]) => JSON.parse(value)));
  expect(durable.find(progress => progress.bookId === book.id)?.bookPositionSeconds).toBe(90);
  expect(fixture.writes.filter(write => write.bookId === book.id).every(write => write.position === 90)).toBe(true);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('operalibre.progressSeekIntent.v1')))).toEqual([]);
  await page.reload();
  await page.getByRole('button', { name: `Play ${book.title}`, exact: true }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThanOrEqual(90);
});

test('Continue from here makes a preview position an intentional listening position', async ({ page }) => {
  const fixture = await setup(page);
  const book = fixture.books[1];
  fixture.clips.get(book.id)![0].endSeconds = 25;
  await page.locator('.book-row').nth(1).click();
  await page.getByRole('tab', { name: 'Clips', exact: true }).click();
  await page.getByRole('button', { name: 'Preview Passage from book 2', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(11);
  await page.locator('.book-clip-detail').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Continue from here', exact: true }).click();
  await expect.poll(() => fixture.writes.some(write => write.bookId === book.id && write.position >= 10 && write.position < 25)).toBe(true);
  const durable = await page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('operalibre.progressCheckpoint.v1')).map(([, value]) => JSON.parse(value)));
  expect(durable.find(progress => progress.bookId === book.id)?.bookPositionSeconds).toBeGreaterThanOrEqual(10);
  expect(durable.find(progress => progress.bookId === book.id)?.bookPositionSeconds).toBeLessThan(25);
});
