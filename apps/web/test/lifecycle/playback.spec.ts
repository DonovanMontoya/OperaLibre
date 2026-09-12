import type { Page } from '@playwright/test';
import { test, expect, type AppServer } from './server';

async function setup(page: Page, server: AppServer) {
  await page.goto(server.url);
  await page.getByRole('button', { name: 'Test & connect', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('owner');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password-123');
  await page.getByLabel('Confirm password', { exact: true }).fill('fixture-password-123');
  const response = page.waitForResponse(r => r.url().endsWith('/api/auth/setup') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create owner', exact: true }).click();
  server.token = (await (await response).json()).token;
  await expect(page.locator('.book-row')).toHaveCount(2);
  return (await server.books()).find(book => book.title === 'First Book')!;
}

const position = (page: Page) => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime);

async function play(page: Page) {
  await page.locator('.book-row').filter({ hasText: 'First Book' }).click();
  await page.getByRole('button', { name: 'Play First Book', exact: true }).first().click();
  await expect.poll(() => position(page)).toBeGreaterThan(2);
}

async function seekAndPause(page: Page) {
  await page.getByRole('button', { name: 'Forward 30 seconds', exact: true }).first().click();
  await expect.poll(() => position(page)).toBeGreaterThan(30);
  await page.getByRole('button', { name: 'Pause', exact: true }).first().click();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
  return position(page);
}

async function expectResume(page: Page, saved: number) {
  await expect.poll(async () => Math.abs(await position(page) - saved)).toBeLessThan(1);
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.paused)).toBe(true);
}

test('pause, reload and server crash preserve accounts, library identity and progress', async ({ page, server }) => {
  const book = await setup(page, server);
  const original = await server.books();
  await play(page);
  const saved = await seekAndPause(page);
  await expect.poll(async () => Math.abs((await server.progress(book.id))!.positionSeconds - saved)).toBeLessThan(1);
  await page.reload();
  await expectResume(page, saved);
  await server.restartAfterCrash();
  expect((await server.books()).map(b => [b.id, b.tracks.map(t => t.id)]))
    .toEqual(original.map(b => [b.id, b.tracks.map(t => t.id)]));
  expect(Math.abs((await server.progress(book.id))!.positionSeconds - saved)).toBeLessThan(1);
  await page.reload();
  await expectResume(page, saved);
  await expect(page.locator('.book-row')).toHaveCount(2);
});

for (const resumedBeforeResponse of [false, true]) {
  test(`a stale foreground response ${resumedBeforeResponse ? 'retries after another resume' : 'cannot seek while hidden'}`, async ({ page, server }) => {
    const book = await setup(page, server);
    await play(page);
    const saved = await seekAndPause(page);
    await expect.poll(async () => Math.abs((await server.progress(book.id))!.positionSeconds - saved)).toBeLessThan(1);
    await page.reload();
    await expectResume(page, saved);
    // This restored, untouched player must not write over another device.
    const remote = await server.json(`/api/books/${book.id}/progress`, 'PUT', {
      trackId: book.tracks[0].id,
      positionSeconds: 90,
      bookPositionSeconds: 90,
      durationSeconds: 180,
      intentionalSeek: true
    });
    let requests = 0;
    let release!: () => void;
    let requested!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { requested = resolve; });
    await page.route(`**/api/books/${book.id}/progress`, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      requests += 1;
      requested();
      await held;
      await route.fulfill({ json: remote });
    });
    const visibility = (value: 'visible' | 'hidden') => page.evaluate(state => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
      document.dispatchEvent(new Event('visibilitychange'));
    }, value);
    await visibility('hidden');
    await visibility('visible');
    await started;
    await visibility('hidden');
    if (resumedBeforeResponse) await visibility('visible');
    release();
    await page.waitForLoadState('networkidle');
    if (!resumedBeforeResponse) {
      await expectResume(page, saved);
      await visibility('visible');
    }
    await expectResume(page, 90);
    expect(requests).toBe(2);
  });
}

test('offline pause survives tab closure and synchronizes after reconnect', async ({ page, context, server }) => {
  const book = await setup(page, server);
  await play(page);
  // Wait for the tiny audio fixture to be buffered before disconnecting.
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) =>
    audio.buffered.length ? audio.buffered.end(audio.buffered.length - 1) : 0)).toBeGreaterThan(60);
  await context.setOffline(true);
  const saved = await seekAndPause(page);
  await page.close();
  await context.setOffline(false);
  const reopened = await context.newPage();
  await reopened.goto(server.url);
  await expectResume(reopened, saved);
  await reopened.getByRole('button', { name: 'Play', exact: true }).first().click();
  await expect.poll(() => position(reopened)).toBeGreaterThan(saved + 1);
  await reopened.getByRole('button', { name: 'Pause', exact: true }).first().click();
  await expect.poll(async () => (await server.progress(book.id))?.positionSeconds ?? 0).toBeGreaterThanOrEqual(saved);
});

test('signing out stops audio and keeps listening progress scoped to the account', async ({ page, server }) => {
  const book = await setup(page, server);
  await server.json('/api/users', 'POST', { username: 'reader', password: 'fixture-password-456', isAdmin: false });
  await play(page);
  const saved = await seekAndPause(page);
  await expect.poll(async () => (await server.progress(book.id))?.positionSeconds ?? 0).toBeGreaterThan(30);
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  await page.getByRole('button', { name: 'Account menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await expect(page.locator('audio')).toHaveCount(0);
  await page.getByLabel('Username', { exact: true }).fill('reader');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password-456');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.book-row')).toHaveCount(2);
  await play(page);
  expect(await position(page)).toBeLessThan(saved - 10);
});

test('six listeners can play and save independent positions', async ({ page, browser, server }) => {
  test.setTimeout(90_000);
  const book = await setup(page, server);
  await play(page);
  await seekAndPause(page);
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  const listeners = [{ page, token: server.token }];
  const contexts = [];
  try {
    for (let index = 1; index < 6; index++) {
      const username = `reader-${index}`;
      await server.json('/api/users', 'POST', { username, password: 'fixture-password-456', isAdmin: false });
      const context = await browser.newContext();
      contexts.push(context);
      const listener = await context.newPage();
      await listener.goto(server.url);
      await listener.getByRole('button', { name: 'Test & connect', exact: true }).click();
      await listener.getByLabel('Username', { exact: true }).fill(username);
      await listener.getByLabel('Password', { exact: true }).fill('fixture-password-456');
      const response = listener.waitForResponse(r => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST');
      await listener.getByRole('button', { name: 'Sign in', exact: true }).click();
      const token = (await (await response).json()).token as string;
      await play(listener);
      listeners.push({ page: listener, token });
    }
    const before = await Promise.all(listeners.map(listener => position(listener.page)));
    // All six real media elements must advance together; no throughput target.
    await expect.poll(async () => (await Promise.all(listeners.map(listener => position(listener.page))))
      .every((value, index) => value > before[index] + 1)).toBe(true);
    for (const listener of listeners) {
      await listener.page.getByRole('button', { name: 'Pause', exact: true }).first().click();
      const saved = await position(listener.page);
      await expect.poll(async () => {
        const progress = await server.json<{ positionSeconds: number }>(
          `/api/books/${book.id}/progress`, 'GET', undefined, listener.token);
        return Math.abs(progress.positionSeconds - saved);
      }).toBeLessThan(1);
    }
    // The owner's explicit seek must not become the new readers' starting point.
    expect(before[0]).toBeGreaterThan(before[1] + 20);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
