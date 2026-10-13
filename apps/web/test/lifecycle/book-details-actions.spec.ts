import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { library, wav } from '../performance/fixtures';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

async function setup(page: Page, platform: 'ios' | 'android' | 'web', admin = true) {
  await page.addInitScript(() => {
    localStorage.setItem('operalibre.serverUrl', location.origin);
    localStorage.setItem('operalibre.serverType', 'operalibre');
  });
  const books = library(5);
  books[1].readingFile = { id: 'ebook', fileName: 'book.epub', extension: 'epub', contentType: 'application/epub+zip', url: '/book.epub' };
  books[1].progress = { status: 'inProgress', bookPositionSeconds: 60, durationSeconds: 240, remainingSeconds: 180, percentComplete: 25, updatedAt: '1700000001' };
  books[2].companions = [{ id: 'extra', fileName: 'map.png', extension: 'png', contentType: 'image/png', url: '/map.png', kind: 'image', sizeBytes: 100 }];
  books[2].progress = { ...books[1].progress, status: 'finished', percentComplete: 100 };
  books[3].deviceBookId = 'imported-book';
  books[4].deviceBookId = 'matched-device-book';
  books[4].readingFile = books[1].readingFile;
  const user = { id: 'details-reader', username: 'Reader', isAdmin: admin, isOwner: admin,
    allowedBookIds: null, libationAccess: 'none', createdAt: '1700000000' };
  const writes: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') writes.push(`${request.method()} ${path}`);
    let body: unknown = [];
    if (path === '/api/auth/status') body = { setupRequired: false, user, mediaToken: 'fixture' };
    else if (path === '/api/auth/me') body = user;
    else if (path === '/api/books') body = books;
    else if (path === '/api/libation/status') body = { accounts: [], configured: false, available: false };
    else if (path === '/api/me/libro') body = { connected: false, accounts: [], books: [], jobs: [] };
    else if (path.endsWith('/clips')) body = { clips: [], canExportAudio: false };
    else if (path.endsWith('/completion')) {
      const book = books.find(book => path === `/api/books/${book.id}/completion`)!;
      const { finished } = request.postDataJSON();
      body = { ...book.progress, status: finished ? 'finished' : 'inProgress', finishedOverride: finished,
        updatedAt: '1700000002' };
    }
    else if (path.endsWith('/progress')) body = null;
    await route.fulfill({ json: body });
  });
  if (platform !== 'web') {
    // Model native file availability, download jobs, and an idle CarPlay player.
    await page.addInitScript(() => {
      const state = window as typeof window & {
        detailsAudioSaved: boolean;
        detailsJobs: Record<string, { state: string; fraction: number; error?: string }>;
        Capacitor: unknown;
      };
      state.detailsAudioSaved = localStorage.getItem('detailsAudioSaved') === 'true';
      state.detailsJobs = {};
      state.Capacitor = {
        PluginHeaders: [
          { name: 'CarPlayBridge', methods: ['getState', 'stopPlayback', 'setLibrary', 'acknowledgeSessions'].map(name => ({ name, rtype: 'promise' })) },
          { name: 'Filesystem', methods: ['stat', 'getUri', 'readFile', 'mkdir', 'readdir', 'rmdir', 'deleteFile'].map(name => ({ name, rtype: 'promise' })) },
          { name: 'BackgroundDownloads', methods: ['enqueueBook', 'getStatus', 'cancelBook'].map(name => ({ name, rtype: 'promise' })) }
        ],
        nativePromise: async (plugin: string, method: string, options: { path: string; jobId: string }) => {
          if (plugin === 'CarPlayBridge') {
            if (method === 'getState' || method === 'stopPlayback') return { connected: false, sessions: '[]' };
            return;
          }
          if (plugin === 'BackgroundDownloads') {
            if (method === 'enqueueBook') state.detailsJobs[options.jobId] = { state: 'running', fraction: 0.25 };
            else if (method === 'cancelBook') state.detailsJobs[options.jobId] = { state: 'failed', fraction: 0, error: 'Cancelled' };
            else return state.detailsJobs[options.jobId] ?? { state: 'failed', fraction: 0 };
            return;
          }
          if (method === 'getUri') return { uri: `file:///${options.path}` };
          if (method === 'mkdir') return;
          if (method === 'readdir') return { files: [] };
          if (method === 'rmdir' || method === 'deleteFile') {
            state.detailsAudioSaved = false;
            localStorage.removeItem('detailsAudioSaved');
            return;
          }
          if (method === 'stat' && state.detailsAudioSaved && options.path.includes('track-')) return { size: 100, type: 'file' };
          throw new Error('File not found');
        }
      };
    });
  }
  await page.goto(platform === 'web' ? url : `${url}test/duo-shell.html?platform=${platform}`);
  if (platform === 'web') await page.getByRole('button', { name: 'Open library', exact: true }).click();
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.locator('.book-row')).toHaveCount(books.length);
  return { books, writes };
}

async function openBook(page: Page, index: number) {
  await page.locator('.book-row').nth(index).click();
  await expect(page.locator('.book-detail-actions')).toBeVisible();
}

async function slots(page: Page) {
  return page.locator('.book-detail-actions').evaluate(grid => {
    const origin = grid.getBoundingClientRect();
    return Object.fromEntries(['read', 'storage', 'edit', 'more'].map(slot => {
      const element = grid.querySelector(`.book-action-${slot}`);
      if (!element) return [slot, null];
      const box = element.getBoundingClientRect();
      return [slot, { x: box.x - origin.x, y: box.y - origin.y, width: box.width, height: box.height }];
    }));
  });
}

for (const platform of ['ios', 'android', 'web'] as const) {
  for (const width of [320, 390, 430]) {
    for (const admin of [false, true]) {
      test(`${platform} ${width}px ${admin ? 'owner' : 'reader'} keeps actions in place across book variants`, async ({ page }) => {
        await page.setViewportSize({ width, height: width === 320 ? 667 : 844 });
        const { writes } = await setup(page, platform, admin);
        let baseline: Awaited<ReturnType<typeof slots>> | undefined;
        for (const index of [0, 1, 2, 3, 4]) {
          await openBook(page, index);
          const positions = await slots(page);
          baseline ??= positions;
          for (const slot of ['read', 'storage', 'edit', 'more']) expect(positions[slot]).toEqual(baseline[slot]);
          const { read, storage, edit, more } = positions;
          expect(storage!.x).toBeGreaterThan(read!.x);
          expect(edit!.x).toBeGreaterThan(storage!.x);
          expect(more!.x).toBeGreaterThan(edit!.x);
          for (const slot of [storage, edit, more]) expect(slot!.y).toEqual(read!.y);
          const actions = page.locator('.book-detail-actions');
          if (index === 0) await expect(actions.locator('.book-action-read')).toHaveText('No ebook');
          if (index === 1) await expect(actions.getByRole('button', { name: /Open read along/ })).toBeVisible();
          if (index === 2) await expect(actions.getByRole('button', { name: /Open extras/ })).toBeVisible();
          await expect(actions.locator('.book-action-storage')).toHaveText(index >= 3 ? 'On device' : 'Download');
          await expect(actions.locator('.book-action-completion')).toHaveAttribute('aria-pressed', index === 2 ? 'true' : 'false');
          await expect(actions.locator('.book-action-edit')).toBeVisible();
          await expect(actions.locator('.book-action-edit')).toHaveText('Edit');
          expect(await actions.locator('button.book-action-edit').count()).toBe(admin ? 1 : 0);
          for (const control of await actions.locator('button:visible, a:visible').all()) {
            const box = (await control.boundingBox())!;
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
            expect(await control.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          const moreButton = actions.getByRole('button', { name: 'More book actions' });
          const menu = actions.getByRole('group', { name: 'Book actions' });
          await expect(menu).toBeHidden();
          await moreButton.click();
          await expect(menu).toBeVisible();
          await expect(menu.locator('.book-action-completion')).toBeVisible();
          await expect(menu.locator('.book-action-edit')).toHaveCount(0);
          await expect(menu.locator('.book-action-reset')).toHaveCount(index === 1 || index === 2 ? 1 : 0);
          await expect(menu.locator('.book-action-epub')).toHaveCount(admin && index !== 1 && index !== 4 ? 1 : 0);
          for (const control of await menu.locator('button').all()) {
            const box = (await control.boundingBox())!;
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
            expect(box.y).toBeGreaterThanOrEqual(0);
            expect(box.y + box.height).toBeLessThanOrEqual(width === 320 ? 667 : 844);
          }
          await page.keyboard.press('Escape');
          await expect(menu).toBeHidden();
          await expect(moreButton).toBeFocused();
          await moreButton.click();
          await page.getByRole('button', { name: platform === 'web' ? 'Open library' : 'Back to Library', exact: true }).click();
          await expect(page.locator('.book-row').first()).toBeVisible();
        }
        expect(writes).toEqual([]);
      });
    }
  }
}

for (const platform of ['ios', 'android', 'web'] as const) {
  for (const finished of [false, true]) {
    test(`${platform} confirms marking a book ${finished ? 'unfinished' : 'finished'} before writing`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const { books, writes } = await setup(page, platform);
      const index = finished ? 2 : 1;
      await openBook(page, index);
      const actions = page.locator('.book-detail-actions');
      const label = finished ? 'Mark unfinished' : 'Mark finished';
      const trigger = actions.getByRole('button', { name: `Mark ${books[index].title} ${finished ? 'unfinished' : 'finished'}`, exact: true });
      const dialog = page.getByRole('dialog', { name: `${label}?`, exact: true });
      async function requestChange() {
        await actions.getByRole('button', { name: 'More book actions' }).click();
        await trigger.click();
        await expect(dialog).toBeVisible();
        await expect(actions.getByRole('group', { name: 'Book actions' })).toBeHidden();
        expect(writes).toEqual([]);
      }
      await requestChange();
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(actions.locator('.book-action-completion')).toHaveAttribute('aria-pressed', String(finished));
      await requestChange();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(actions.locator('.book-action-completion')).toHaveAttribute('aria-pressed', String(finished));
      await requestChange();
      await dialog.getByRole('button', { name: label, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(actions.locator('.book-action-completion')).toHaveAttribute('aria-pressed', String(!finished));
      expect(writes).toEqual([`PUT /api/books/${books[index].id}/completion`]);
      if (platform === 'web' && !finished) {
        await actions.locator('button.book-action-edit').click();
        const editor = page.getByRole('dialog', { name: 'Edit Book Info', exact: true });
        await expect(editor).toBeVisible();
        await editor.getByRole('button', { name: 'Close metadata editor' }).click();
        await expect(editor).toBeHidden();
      }
    });
  }
}

for (const platform of ['ios', 'android'] as const) {
  test(`${platform} preserves player details after cancelling or marking unfinished`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { books, writes } = await setup(page, platform);
    await page.route('**/fixture.wav*', route => route.fulfill({ contentType: 'audio/wav', body: wav() }));
    await page.route(`**/api/books/${books[2].id}/progress`, route => route.fulfill({ json: {
      bookId: books[2].id, trackId: books[2].tracks[0].id, positionSeconds: 60,
      bookPositionSeconds: 60, durationSeconds: 120, finishedOverride: true, updatedAt: new Date().toISOString()
    } }));
    await openBook(page, 2);
    await page.getByRole('button', { name: `Play ${books[2].title}`, exact: true }).click();
    await page.locator('.native-now-utility').getByRole('button', { name: 'Details', exact: true }).click();
    const sheet = page.locator('.details-sheet');
    const trigger = sheet.getByRole('button', { name: 'Mark unfinished', exact: true });
    const confirmation = page.getByRole('dialog', { name: 'Mark unfinished?', exact: true });
    const completionWrites = () => writes.filter(write => write.endsWith('/completion'));
    await trigger.click();
    await expect(confirmation).toBeVisible();
    await expect(sheet).toBeVisible();
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-pressed', 'true');
    expect(completionWrites()).toEqual([]);
    await trigger.click();
    await expect(confirmation).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirmation).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(completionWrites()).toEqual([]);
    await trigger.click();
    await confirmation.getByRole('button', { name: 'Mark unfinished', exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Mark finished', exact: true })).toHaveAttribute('aria-pressed', 'false');
    expect(completionWrites()).toEqual([`PUT /api/books/${books[2].id}/completion`]);
  });
}

test('completion confirmation retains errors and retries without dismissing early', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { books } = await setup(page, 'web');
  let attempts = 0;
  let finishSave: (() => void) | undefined;
  await page.route('**/api/books/*/completion', async route => {
    attempts++;
    if (attempts === 1) await route.fulfill({ status: 500, json: { message: 'Could not save reading status' } });
    else {
      await new Promise<void>(resolve => { finishSave = resolve; });
      await route.fulfill({ json: { ...books[1].progress, status: 'finished', finishedOverride: true, updatedAt: '1700000002' } });
    }
  });
  await openBook(page, 1);
  await page.getByRole('button', { name: 'More book actions' }).click();
  await page.getByRole('button', { name: `Mark ${books[1].title} finished`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Mark finished?', exact: true });
  await dialog.getByRole('button', { name: 'Mark finished', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Could not save reading status');
  await expect(page.locator('.book-action-completion')).toHaveAttribute('aria-pressed', 'false');
  await dialog.getByRole('button', { name: 'Mark finished', exact: true }).click();
  await expect(dialog).toHaveAttribute('aria-busy', 'true');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Saving…' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect.poll(() => finishSave !== undefined).toBe(true);
  finishSave!();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.book-action-completion')).toHaveAttribute('aria-pressed', 'true');
  expect(attempts).toBe(2);
});

test('desktop keeps secondary book actions visible when resizing from a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page, 'web');
  await openBook(page, 1);
  const actions = page.locator('.book-detail-actions');
  await expect(actions.getByRole('button', { name: 'More book actions' })).toBeVisible();
  await expect(actions.locator('.book-action-reset')).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(actions.getByRole('button', { name: 'More book actions' })).toBeHidden();
  for (const slot of ['completion', 'reset', 'edit']) await expect(actions.locator(`.book-action-${slot}`)).toBeVisible();
});

test('phone More menu keeps progress reset behind its confirmation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { writes } = await setup(page, 'ios');
  await openBook(page, 1);
  const actions = page.locator('.book-detail-actions');
  await actions.getByRole('button', { name: 'More book actions' }).click();
  await actions.getByRole('button', { name: /Mark .* as unplayed/ }).click();
  await expect(actions.getByRole('group', { name: 'Book actions' })).toBeHidden();
  const confirmation = page.getByRole('dialog', { name: 'Mark as unplayed?' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Keep listening' }).click();
  await expect(confirmation).toBeHidden();
  await expect(page.locator('.book-quick-play')).toContainText('Resume this book');
  await expect(page.locator('.book-quick-play')).toBeVisible();
  expect(writes).toEqual([]);
});

for (const platform of ['ios', 'android'] as const) {
  test(`${platform} device download, cancel, and remove keep the storage slot and server copy`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { books, writes } = await setup(page, platform);
    await openBook(page, 1);
    const baseline = await slots(page);
    const storage = page.locator('.book-action-storage');
    await storage.click();
    await expect(storage).toHaveText('25%');
    expect((await slots(page)).storage).toEqual(baseline.storage);
    await storage.click();
    await expect(storage).toHaveText('Download');

    await page.evaluate(() => { localStorage.setItem('detailsAudioSaved', 'true'); });
    await page.reload();
    await expect(page.locator('.book-row')).toHaveCount(books.length);
    await openBook(page, 1);
    await expect(storage).toHaveText('On device');
    await expect(storage).toHaveAccessibleName(`Remove ${books[1].title} from this device`);
    await expect(page.getByRole('region', { name: 'Offline files', exact: true })).toContainText('Ebook: missing');
    expect((await slots(page)).storage).toEqual(baseline.storage);
    page.once('dialog', dialog => dialog.dismiss());
    await storage.click();
    await expect(storage).toHaveText('On device');
    page.once('dialog', dialog => dialog.accept());
    await storage.click();
    await expect(storage).toHaveText('Download');
    expect(writes).toEqual([]);
    expect((await slots(page)).storage).toEqual(baseline.storage);
  });
}
