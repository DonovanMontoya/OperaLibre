import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import type { Clip } from '../../src/clips';
import { library, wav } from '../performance/fixtures';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

type Platform = 'web' | 'ios' | 'android';

/** Signs in to a fixture server and starts its first book, forward of 0:00. */
async function startPlayback(page: Page, platform: Platform, bookCount = 1) {
  await page.addInitScript(() => {
    localStorage.setItem('operalibre.serverUrl', location.origin);
    localStorage.setItem('operalibre.serverType', 'operalibre');
  });
  const books = library(bookCount);
  books[0].title = 'The Adventures of Sherlock Holmes';
  const user = { id: 'reader', username: 'Reader', isAdmin: false, isOwner: false,
    allowedBookIds: null, libationAccess: 'none', createdAt: '1700000000' };
  const writes: number[] = [];
  const clips: Clip[] = [];
  const clipSaves = { fail: false };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body: unknown = [];
    if (path === '/api/auth/status') body = { setupRequired: false, user, mediaToken: 'fixture' };
    else if (path === '/api/auth/me') body = user;
    else if (path === '/api/books') body = books;
    else if (path.endsWith('/clips')) {
      if (request.method() === 'POST') {
        if (clipSaves.fail) return route.fulfill({ status: 503, json: { error: 'Offline' } });
        const clip = { ...request.postDataJSON(), bookId: books[0].id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        clips.push(clip);
        body = clip;
      } else body = { clips, canExportAudio: false };
    }
    else if (path.endsWith('/progress')) {
      body = null;
      if (request.method() === 'PUT') {
        body = { ...request.postDataJSON(), accepted: true, updatedAt: new Date().toISOString() };
        writes.push(request.postDataJSON().positionSeconds);
      }
    }
    else if (path === '/api/libation/status') body = { accounts: [], configured: false, available: false };
    else if (path === '/api/me/libro') body = { connected: false, accounts: [], books: [], jobs: [] };
    await route.fulfill({ json: body });
  });
  const media = wav();
  await page.route('**/fixture.wav*', route => {
    const range = route.request().headers().range?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Number(range[2]) : media.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav',
      headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${media.length}` } : {}) },
      body: media.subarray(start, end + 1) });
  });
  await page.goto(platform === 'web' ? url : `${url}test/duo-shell.html?platform=${platform}`);
  if (platform === 'web') await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await page.locator('.book-row').filter({ hasText: books[0].title }).click();
  await page.getByRole('button', { name: `Play ${books[0].title}`, exact: true }).click();
  const player = page.getByRole('region', { name: 'Now playing', exact: true });
  const audio = page.locator('audio');
  const position = () => audio.evaluate((element: HTMLAudioElement) => element.currentTime);
  await expect.poll(position).toBeGreaterThan(0);
  await player.getByRole('button', { name: 'Forward 30 seconds', exact: true }).click();
  await expect.poll(position).toBeGreaterThan(30);
  return { books, writes, clips, clipSaves, player, audio, position };
}

for (const platform of ['web', 'ios', 'android'] as const) {
  test(`${platform} car mode preserves playback, seeks and returns to the normal player`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { books, writes, clips, clipSaves, player, audio, position } = await startPlayback(page, platform);
    const source = await audio.getAttribute('src');
    await page.getByRole('button', { name: 'Car mode', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Car mode', exact: true, pressed: true })).toBeFocused();
    await expect(player.getByRole('heading', { name: books[0].title })).toBeVisible();
    await expect(player.getByRole('slider')).toHaveCount(0);
    await expect(player.getByRole('button')).toHaveCount(4);
    await expect.poll(position).toBeGreaterThan(30);
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
    await player.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(true);
    const paused = await position();
    await player.getByRole('button', { name: 'Rewind 15 seconds', exact: true }).click();
    await expect.poll(position).toBeCloseTo(paused - 15, 0);
    await player.getByRole('button', { name: 'Forward 30 seconds', exact: true }).click();
    await expect.poll(position).toBeCloseTo(paused + 15, 0);
    const saved = await position();
    await expect.poll(() => writes.some(value => Math.abs(value - saved) < 1)).toBe(true);
    const writeCount = writes.length;
    const bookmark = player.getByRole('button', { name: 'Save a clip of the last 30 seconds and the next 10' });
    await bookmark.click();
    await expect.poll(() => clips.length).toBe(1);
    expect(clips[0].startSeconds).toBeCloseTo(saved - 30, 0);
    expect(clips[0].endSeconds).toBeCloseTo(saved + 10, 0);
    await expect(player.getByRole('status')).toHaveText('Clip saved');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect.poll(position).toBeCloseTo(saved, 0);

    // Saving in a tunnel keeps the moment queued without changing playback.
    clipSaves.fail = true;
    await bookmark.click();
    await expect.poll(() => page.evaluate(() => Object.entries(localStorage)
      .filter(([key]) => key.includes('pendingClips')).map(([, value]) => JSON.parse(value)).flat().length)).toBe(1);
    clipSaves.fail = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => clips.length).toBe(2);

    for (const [width, height] of [[320, 667], [390, 844], [844, 390], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      for (const button of [...await player.getByRole('button').all(), page.getByRole('button', { name: 'Car mode', exact: true, pressed: true })]) {
        await expect(button).toBeInViewport({ ratio: 1 });
        const box = (await button.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(52);
        expect(box.width).toBeGreaterThanOrEqual(52);
      }
      await expect.poll(() => player.locator('.car-player').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: test.info().outputPath(`${platform}-car-mode.png`) });
    await page.getByRole('button', { name: 'Car mode', exact: true, pressed: true }).click();
    await expect(page.getByRole('button', { name: 'Car mode', exact: true, pressed: false })).toBeFocused();
    await expect.poll(position).toBeCloseTo(saved, 0);
    await expect(player.getByRole('slider')).toHaveCount(1);
    await expect(player.getByRole('button', { name: 'Save a clip of the last 30 seconds and the next 10' })).toBeInViewport({ ratio: 1 });
    for (const [width, height] of [[320, 667], [390, 844], [844, 390], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await expect(page.getByRole('button', { name: 'Car mode', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(player.getByRole('button', { name: 'Play', exact: true })).toBeInViewport({ ratio: 1 });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Car mode', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Car mode', exact: true })).toBeFocused();
    await expect.poll(position).toBeCloseTo(saved, 0);
    expect(writes.length).toBe(writeCount);
    await expect(audio).toHaveAttribute('src', source!);
    await page.getByRole('button', { name: 'Car mode', exact: true }).click();
    await player.getByRole('button', { name: 'Play', exact: true }).click();
    await expect.poll(position).toBeGreaterThan(saved + 0.5);
    await player.getByRole('button', { name: 'Pause', exact: true }).click();
  });
}

test('car mode steps aside when its player goes away', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { books } = await startPlayback(page, 'web', 2);
  await page.getByRole('button', { name: 'Car mode', exact: true }).click();
  const pane = page.locator('.player-pane');
  await expect(pane).toHaveClass(/has-car-mode/);

  // Another book's page owns Escape while the car player is out of view. A
  // wide window shows the shelf beside the car player.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.book-row').filter({ hasText: books[1].title }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'More book actions' }).click();
  const finish = page.getByRole('button', { name: `Mark ${books[1].title} finished`, exact: true });
  await expect(finish).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(finish).toBeHidden();

  // The playing book leaving the library ends playback; the empty player
  // keeps its way back to the library.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.book-row').filter({ hasText: books[0].title }).click();
  await expect(pane).toHaveClass(/has-car-mode/);
  books.shift();
  await page.getByRole('button', { name: 'Refresh library', exact: true }).click();
  await expect(page.getByText('Choose a book from your shelf to begin listening.')).toBeVisible();
  await expect(pane).not.toHaveClass(/has-car-mode/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Open library', exact: true })).toBeVisible();
});

test('car mode fills a horizontally folded screen', async ({ page }) => {
  await page.setViewportSize({ width: 669, height: 951 });
  const { player } = await startPlayback(page, 'ios');
  await page.getByRole('button', { name: 'Car mode', exact: true }).click();
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 110,
      fold: { x: 0, y: 460, width: 669, height: 31, axis: 'horizontal', active: true } });
  });
  await expect(page.locator('.player-pane')).not.toHaveClass(/fit-playback/);
  const car = (await player.locator('.car-player').boundingBox())!;
  expect(car.y + car.height).toBeGreaterThan(491);
  await expect(player.getByRole('button', { name: 'Pause', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: test.info().outputPath('ios-fold-car-mode.png') });
});
