import type { Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, type AppServer } from './server';

async function setup(page: Page, server: AppServer) {
  await page.goto(server.url);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('owner');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password-123');
  await page.getByLabel('Confirm password', { exact: true }).fill('fixture-password-123');
  const response = page.waitForResponse(r => r.url().endsWith('/api/auth/setup') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create owner', exact: true }).click();
  server.token = (await (await response).json()).token;
  await expect(page.locator('.book-row')).toHaveCount(2);
  return server.books();
}

async function openPreview(page: Page, title = 'Second Book') {
  await page.locator('.book-row').filter({ hasText: title }).click();
  await page.getByRole('button', { name: `Listen to a preview of ${title}`, exact: true }).click();
  const preview = page.getByRole('region', { name: `Audio preview of ${title}`, exact: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(preview).toBeVisible();
  return preview;
}

test('a sample crosses tracks, stops at five minutes, and never starts a reading', async ({ page, server }, testInfo) => {
  const books = await setup(page, server);
  const book = books.find(b => b.title === 'Second Book')!;
  await page.getByRole('button', { name: 'Add books', exact: true }).click();
  await page.getByRole('button', { name: 'Add Second Book to Up Next', exact: true }).click();
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/(progress|playback|completion)(\/|$)/.test(new URL(request.url()).pathname)) {
      writes.push(request.url());
    }
  });
  const preview = await openPreview(page);
  const audio = preview.locator('audio');
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('preview-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(preview).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('preview-phone.png') });
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThanOrEqual(2);
  await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = 179.8; });
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentSrc)).toContain(book.tracks[1].id);
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = 119.8; });
  await expect(preview.getByRole('status')).toHaveText('Preview finished');
  expect(await audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await expect(preview.getByRole('progressbar')).toHaveAttribute('value', '300');
  await preview.getByRole('button', { name: 'Replay preview', exact: true }).click();
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentSrc)).toContain(book.tracks[0].id);
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await preview.getByRole('button', { name: 'Reset preview', exact: true }).click();
  await expect(preview.locator('audio')).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.queue-row')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Continue Reading', exact: true })).toHaveCount(0);
  expect(await server.progress(book.id)).toBeNull();
  expect(writes).toEqual([]);
});

test('preview pauses a current reading and preserves both books saved positions', async ({ page, server }) => {
  const books = await setup(page, server);
  const first = books.find(b => b.title === 'First Book')!;
  const second = books.find(b => b.title === 'Second Book')!;
  await server.json(`/api/books/${second.id}/progress`, 'PUT', {
    trackId: second.tracks[1].id, positionSeconds: 70, bookPositionSeconds: 250,
    durationSeconds: 180, intentionalSeek: true
  });
  const secondSaved = await server.progress(second.id);
  await page.locator('.book-row').filter({ hasText: 'First Book' }).click();
  await page.getByRole('button', { name: 'Play First Book', exact: true }).first().click();
  const main = page.locator('audio').first();
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Forward 30 seconds', exact: true }).first().click();
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(30);
  const preview = await openPreview(page);
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  const paused = await main.evaluate((a: HTMLAudioElement) => a.currentTime);
  await expect.poll(async () => Math.abs((await server.progress(first.id))!.positionSeconds - paused)).toBeLessThan(1);
  const sample = preview.locator('audio');
  await expect.poll(() => sample.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await preview.getByRole('button', { name: 'Pause preview', exact: true }).click();
  await expect.poll(() => sample.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  await preview.getByRole('button', { name: 'Listen to a preview of Second Book', exact: true }).click();
  await expect.poll(() => sample.evaluate((a: HTMLAudioElement) => a.paused)).toBe(false);
  await preview.getByRole('button', { name: 'Reset preview', exact: true }).click();
  expect(await server.progress(second.id)).toEqual(secondSaved);
  expect(await main.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeCloseTo(paused, 1);
  const mini = page.getByRole('complementary', { name: 'Mini player' });
  await mini.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(paused + 0.5);
  const anotherPreview = await openPreview(page);
  await expect.poll(() => anotherPreview.locator('audio').evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  // External media controls can resume the main element without clicking inside the modal.
  await main.evaluate((a: HTMLAudioElement) => a.play());
  await expect(anotherPreview.locator('audio')).toHaveCount(0);
});

test('short books end naturally and missing duration metadata still crosses tracks', async ({ page, server }) => {
  await setup(page, server);
  for (const track of ['01', '02']) {
    const path = join(server.directory, 'library', 'Second Book', `${track} Track.wav`);
    const original = await readFile(path);
    const short = original.subarray(0, 44 + 10 * 16000);
    short.writeUInt32LE(short.length - 8, 4);
    short.writeUInt32LE(short.length - 44, 40);
    await writeFile(path, short);
  }
  await server.json('/api/library/rescan', 'POST');
  await page.reload();
  const preview = await openPreview(page);
  const audio = preview.locator('audio');
  await expect(preview.getByRole('progressbar')).toHaveAttribute('max', '20');
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  const source = await audio.evaluate((a: HTMLAudioElement) => a.currentSrc);
  await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = 9.8; });
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentSrc)).not.toBe(source);
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = 9.8; });
  await expect(preview.getByRole('status')).toHaveText('Preview finished');
  await page.route('**/api/books', async route => {
    const response = await route.fetch();
    const books = await response.json();
    for (const book of books) for (const track of book.tracks) track.durationSeconds = null;
    await route.fulfill({ response, json: books });
  });
  await page.reload();
  const unknown = await openPreview(page);
  const sample = unknown.locator('audio');
  await expect.poll(() => sample.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await sample.evaluate((a: HTMLAudioElement) => { a.currentTime = 9.8; });
  await expect.poll(() => sample.evaluate((a: HTMLAudioElement) => a.currentSrc)).not.toBe(source);
  await expect.poll(() => sample.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await sample.evaluate((a: HTMLAudioElement) => { a.currentTime = 9.8; });
  await expect(unknown.getByRole('status')).toHaveText('Preview finished');
});

test('leaving the app pauses the preview without resuming the book', async ({ page, server }) => {
  const books = await setup(page, server);
  const preview = await openPreview(page);
  const audio = preview.locator('audio');
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  expect(await page.locator('audio').first().evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  expect(await server.progress(books.find(b => b.title === 'Second Book')!.id)).toBeNull();
});

test('a failed inline sample can retry and resetting it releases the stream', async ({ page, server }) => {
  await setup(page, server);
  await page.route('**/api/books/*/tracks/*/stream*', route => route.abort('failed'));
  const preview = await openPreview(page);
  await expect(preview.getByRole('alert')).toContainText(/preview.*(unavailable|could not play)/i);
  await page.unroute('**/api/books/*/tracks/*/stream*');
  await preview.getByRole('button', { name: 'Listen to a preview of Second Book', exact: true }).click();
  const audio = preview.locator('audio');
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await audio.evaluate(a => { (window as unknown as { sample: HTMLAudioElement }).sample = a as HTMLAudioElement; });
  await preview.getByRole('button', { name: 'Reset preview', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const audio = (window as unknown as { sample: HTMLAudioElement }).sample;
    return audio.paused && !audio.getAttribute('src');
  })).toBe(true);
});

async function finishFiveMinutePreview(page: Page, alreadyOpen = false) {
  const preview = alreadyOpen
    ? page.getByRole('region', { name: 'Audio preview of Second Book', exact: true })
    : await openPreview(page);
  if (alreadyOpen) await preview.getByRole('button', { name: 'Listen to a preview of Second Book', exact: true }).click();
  const audio = preview.locator('audio');
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  const firstSource = await audio.evaluate((a: HTMLAudioElement) => a.currentSrc);
  await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = 179.8; });
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentSrc)).not.toBe(firstSource);
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = 119.8; });
  await expect(preview.getByRole('status')).toHaveText('Preview finished');
  return preview;
}

for (const unknownDurations of [false, true]) {
test(`continuing a finished preview starts at the sample endpoint${unknownDurations ? ' with unknown durations' : ''}`, async ({ page, server }) => {
  const books = await setup(page, server);
  const book = books.find(b => b.title === 'Second Book')!;
  if (unknownDurations) {
    await page.route('**/api/books', async route => {
      const response = await route.fetch();
      const books = await response.json();
      for (const book of books) for (const track of book.tracks) track.durationSeconds = null;
      await route.fulfill({ response, json: books });
    });
    await page.reload();
  }
  const preview = await finishFiveMinutePreview(page);
  expect(await server.progress(book.id)).toBeNull();
  await preview.getByRole('button', { name: 'Continue listening', exact: true }).click();
  const main = page.locator('audio').first();
  await expect(preview.locator('audio')).toHaveCount(0);
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.currentSrc)).toContain(book.tracks[1].id);
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThanOrEqual(120);
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.paused)).toBe(false);
  await expect.poll(async () => (await server.progress(book.id))?.bookPositionSeconds || 0).toBeGreaterThanOrEqual(300);
});

}

test('continuing a preview respects a newer saved position on another device', async ({ page, server }) => {
  const books = await setup(page, server);
  const book = books.find(b => b.title === 'Second Book')!;
  const preview = await finishFiveMinutePreview(page);
  // The shelf still says not started; the live progress check must win.
  await server.json(`/api/books/${book.id}/progress`, 'PUT', {
    trackId: book.tracks[1].id, positionSeconds: 140, bookPositionSeconds: 320,
    durationSeconds: 180, intentionalSeek: true
  });
  await preview.getByRole('button', { name: 'Continue listening', exact: true }).click();
  const main = page.locator('audio').first();
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThanOrEqual(140);
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.paused)).toBe(false);
  expect((await server.progress(book.id))!.bookPositionSeconds).toBeGreaterThanOrEqual(320);
});

test('refreshing the library does not restart an inline preview', async ({ page, server }) => {
  await setup(page, server);
  const preview = await openPreview(page);
  const audio = preview.locator('audio');
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = 60; });
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThanOrEqual(60);
  await preview.getByRole('button', { name: 'Pause preview', exact: true }).click();
  const paused = await audio.evaluate((a: HTMLAudioElement) => a.currentTime);
  const refreshed = page.waitForResponse(r => r.url().endsWith('/api/library/rescan'));
  await page.getByRole('button', { name: 'Rescan library', exact: true }).click();
  await refreshed;
  await expect(page.getByRole('button', { name: 'Rescan library', exact: true })).toBeEnabled();
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeCloseTo(paused, 1);
  expect(await audio.evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  expect(await server.progress((await server.books()).find(b => b.title === 'Second Book')!.id)).toBeNull();
});

for (const failure of ['error', 'timeout'] as const) {
  test(`a ${failure} checking progress leaves continuation retryable without saving a seek`, async ({ page, server }) => {
    const books = await setup(page, server);
    const book = books.find(b => b.title === 'Second Book')!;
    const preview = await finishFiveMinutePreview(page);
    await server.json(`/api/books/${book.id}/progress`, 'PUT', {
      trackId: book.tracks[1].id, positionSeconds: 140, bookPositionSeconds: 320,
      durationSeconds: 180, intentionalSeek: true
    });
    const saved = await server.progress(book.id);
    const writes: string[] = [];
    page.on('request', r => {
      if (r.method() === 'PUT' && r.url().includes(`/api/books/${book.id}/progress`)) writes.push(r.url());
    });
    let failures = 0;
    await page.route(`**/api/books/${book.id}/progress`, async route => {
      if (route.request().method() !== 'GET' || failures++ > 0) return route.continue();
      if (failure === 'error') return route.fulfill({ status: 503, json: { message: 'Temporarily unavailable' } });
      // Hold the request until the client's timeout aborts it.
    });
    await preview.getByRole('button', { name: 'Continue listening', exact: true }).click();
    await expect(preview.getByRole('alert')).toContainText('Could not check your saved position');
    await expect(preview.getByRole('button', { name: 'Continue listening', exact: true })).toBeEnabled();
    expect(await page.locator('audio').first().evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
    expect(await server.progress(book.id)).toEqual(saved);
    expect(writes).toEqual([]);
    await preview.getByRole('button', { name: 'Continue listening', exact: true }).click();
    await expect.poll(() => page.locator('audio').first().evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThanOrEqual(140);
    expect((await server.progress(book.id))!.bookPositionSeconds).toBeGreaterThanOrEqual(320);
  });
}

test('continuing the loaded book adopts progress saved on another device during the preview', async ({ page, server }) => {
  const books = await setup(page, server);
  const book = books.find(b => b.title === 'Second Book')!;
  await page.locator('.book-row').filter({ hasText: 'Second Book' }).click();
  await page.getByRole('button', { name: 'Play Second Book', exact: true }).first().click();
  const main = page.locator('audio').first();
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Forward 30 seconds', exact: true }).first().click();
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThan(30);
  await page.getByRole('button', { name: 'View details', exact: true }).click();
  await page.getByRole('button', { name: 'Full book page', exact: true }).click();
  const preview = await finishFiveMinutePreview(page, true);
  await server.json(`/api/books/${book.id}/progress`, 'PUT', {
    trackId: book.tracks[1].id, positionSeconds: 140, bookPositionSeconds: 320,
    durationSeconds: 180, intentionalSeek: true
  });
  await preview.getByRole('button', { name: 'Continue listening', exact: true }).click();
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.currentSrc)).toContain(book.tracks[1].id);
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThanOrEqual(140);
  await expect.poll(() => main.evaluate((a: HTMLAudioElement) => a.paused)).toBe(false);
  expect((await server.progress(book.id))!.bookPositionSeconds).toBeGreaterThanOrEqual(320);
});

test('leaving the page while continuation checks progress cancels the pending handoff', async ({ page, server }) => {
  const books = await setup(page, server);
  const book = books.find(b => b.title === 'Second Book')!;
  const preview = await finishFiveMinutePreview(page);
  let held: import('@playwright/test').Route | undefined;
  await page.route(`**/api/books/${book.id}/progress`, route => {
    if (route.request().method() === 'GET') held = route;
    else void route.continue();
  });
  await preview.getByRole('button', { name: 'Continue listening', exact: true }).click();
  await expect.poll(() => !!held).toBe(true);
  await page.locator('.book-row').filter({ hasText: 'First Book' }).click();
  await held!.fulfill({ json: null });
  await expect(preview).toHaveCount(0);
  expect(await page.locator('audio').first().evaluate((a: HTMLAudioElement) => a.paused)).toBe(true);
  expect(await server.progress(book.id)).toBeNull();
});

test('turning audio previews off stops a sample and hides the bar until turned back on', async ({ page, server }) => {
  await setup(page, server);
  const preview = await openPreview(page);
  const start = page.getByRole('button', { name: 'Listen to a preview of Second Book', exact: true });
  const setting = page.getByRole('switch', { name: 'Audio previews', exact: true });
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByText('Behavior', { exact: true }).click();
  await expect(setting).toHaveAttribute('aria-checked', 'true');
  await setting.click();
  await expect(preview).toHaveCount(0);
  await expect(start).toHaveCount(0);
  await page.reload();
  await page.locator('.book-row').filter({ hasText: 'Second Book' }).click();
  await expect(page.getByRole('button', { name: 'Play Second Book', exact: true }).first()).toBeVisible();
  await expect(start).toHaveCount(0);
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByText('Behavior', { exact: true }).click();
  await expect(setting).toHaveAttribute('aria-checked', 'false');
  await setting.click();
  await expect(start).toBeVisible();
});
