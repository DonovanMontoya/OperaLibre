import { test, expect } from '@playwright/test';
import { library, wav } from './fixtures';

const count = Number(process.env.PERF_BOOKS ?? 1000);
if (!Number.isInteger(count) || count < 20 || count > 10_000) throw new Error('PERF_BOOKS must be 20..10000');

test('large shelf search and real playback remain functional', async ({ page }, testInfo) => {
  const books = library(count);
  const user = { id: 'perf-reader', username: 'Performance reader', isAdmin: false, isOwner: false,
    canApproveLibationRequests: false, allowedBookIds: null, libationAccess: 'none',
    shareProgress: false, announceFinishes: false, notifyFinishes: false, createdAt: '1700000000' };
  const unexpected: string[] = [];
  const errors: string[] = [];
  const writes: Record<string, unknown>[] = [];
  const requests: Record<string, number> = {};
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const timing = { frames: [] as number[], collecting: false };
    (window as any).__performanceTiming = timing;
    let previous = performance.now();
    function frame(now: number) {
      if (timing.collecting) timing.frames.push(now - previous);
      previous = now;
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    localStorage.setItem('operalibre.serverUrl', location.origin);
    localStorage.setItem('operalibre.serverType', 'operalibre');
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const key = `${request.method()} ${path}`;
    requests[key] = (requests[key] ?? 0) + 1;
    let body: unknown;
    if (path === '/api/auth/status') body = { setupRequired: false, user, mediaToken: 'fixture' };
    else if (path === '/api/auth/me') body = user;
    else if (path === '/api/books') body = books;
    else if (path === '/api/libation/books') body = [];
    else if (/\/progress$/.test(path) && request.method() === 'GET') body = null;
    else if (/\/progress$/.test(path) && request.method() === 'PUT') {
      const update = request.postDataJSON(); writes.push(update);
      body = { ...update, bookId: path.split('/')[3], updatedAt: String(Date.now()) };
    } else {
      unexpected.push(key);
      return route.fulfill({ status: 500, json: { error: `Unexpected fixture request: ${key}` } });
    }
    await route.fulfill({ json: body });
  });
  await page.route('**/fixture.wav*', route => route.fulfill({ contentType: 'audio/wav', body: wav() }));
  const started = performance.now();
  await page.goto('/');
  await expect(page.locator('.book-row')).toHaveCount(count);
  const shelfReadyMs = performance.now() - started;
  const openLibrary = page.getByRole('button', { name: 'Open library', exact: true });
  if (await openLibrary.isVisible()) await openLibrary.click();
  const search = page.getByRole('searchbox', { name: 'Search library' });
  const searchTimes: number[] = [];
  for (let i = 0; i < 6; i++) {
    const start = performance.now();
    await search.fill(`Fixture Book ${String(i).padStart(4, '0')}`);
    await expect(page.locator('.book-row')).toHaveCount(1);
    await expect(page.locator('.book-row')).toContainText(`Fixture Book ${String(i).padStart(4, '0')}`);
    searchTimes.push(performance.now() - start);
  }
  await search.fill('');
  await expect(page.locator('.book-row')).toHaveCount(count);
  expect(writes, 'browsing must not persist untouched playback').toHaveLength(0);
  await page.locator('.book-row').first().click();
  await page.getByRole('button', { name: 'Play Fixture Book 0000', exact: true }).click();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(2);
  await page.evaluate(() => { (window as any).__performanceTiming.collecting = true; });
  const before = await page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime);
  if (await openLibrary.isVisible()) await openLibrary.click();
  await search.fill('Fixture Book 0001');
  await expect(page.locator('.book-row')).toHaveCount(1);
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(before + 3);
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  expect(writes.every(write => write.trackId === 'track-0-0')).toBe(true);
  expect(unexpected).toEqual([]);
  expect(errors).toEqual([]);
  const playbackFramesMs = await page.evaluate(() => {
    const timing = (window as any).__performanceTiming; timing.collecting = false; return timing.frames;
  });
  await testInfo.attach('measurements', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
    schema: 1, project: testInfo.project.name, books: count, shelfReadyMs, searchTimesMs: searchTimes,
    requests, progressWrites: writes.length, playbackFramesMs,
  }, null, 2)) });
});
