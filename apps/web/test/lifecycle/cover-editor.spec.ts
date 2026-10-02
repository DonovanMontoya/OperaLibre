import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { library } from '../performance/fixtures';

let server: ViteDevServer;
let url: string;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAEElEQVR4nGPYYsMFRAwoFABBlwXdHiVjTAAAAABJRU5ErkJggg==', 'base64');
const file = { name: 'new-cover.png', mimeType: 'image/png', buffer: png };
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

async function setup(page: Page, options: { override?: boolean; failCover?: boolean; pauseMetadata?: Promise<void>; native?: boolean } = {}) {
  const books = library(2).map(book => ({ ...book, coverArtUrl: `/api/books/${book.id}/cover?v=original`, coverArtContentType: 'image/png', hasCoverOverride: !!options.override }));
  const writes: { method: string; path: string; body: string | null }[] = [];
  let failCover = !!options.failCover;
  await page.route('**/api/books/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const book = books.find(item => path.includes(item.id))!;
    if (method === 'GET') return route.fulfill({ contentType: 'image/png', body: png });
    writes.push({ method, path, body: request.postData() });
    if (path.endsWith('/metadata')) {
      if (options.pauseMetadata) await options.pauseMetadata;
      Object.assign(book, request.postDataJSON());
      return route.fulfill({ json: book });
    }
    if (failCover) return route.fulfill({ status: 400, json: { error: 'Invalid cover image.' } });
    book.hasCoverOverride = method === 'POST';
    book.coverArtUrl = `/api/books/${book.id}/cover?v=${method === 'POST' ? 'replacement' : 'restored'}`;
    return route.fulfill({ json: book });
  });
  await page.goto(`${url}test/cover-editor.html${options.native ? '?native' : ''}`);
  if (options.override) {
    // First exercise the actual upload flow to establish the override in client state.
    await page.getByRole('button', { name: 'Edit Info', exact: true }).click();
    await page.getByLabel('Choose cover', { exact: true }).setInputFiles(file);
    await page.getByRole('button', { name: 'Save Info', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    writes.length = 0;
  }
  await page.getByRole('button', { name: 'Edit Info', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  return { books, writes, succeed: () => { failCover = false; } };
}

for (const dismiss of ['Close metadata editor', 'Reset', 'Escape']) test(`${dismiss} discards unsaved info and the selected cover without an upload`, async ({ page }) => {
  const { writes } = await setup(page);
  await page.getByLabel('Title', { exact: true }).fill('Unsaved title');
  await page.getByLabel('Choose cover', { exact: true }).setInputFiles(file);
  await expect(page.getByAltText('Selected cover preview')).toBeVisible();
  if (dismiss === 'Escape') await page.keyboard.press('Escape');
  else await page.getByRole('button', { name: dismiss, exact: true }).click();
  if (dismiss !== 'Reset') await page.getByRole('button', { name: 'Edit Info', exact: true }).click();
  await expect(page.getByAltText('Selected cover preview')).toHaveCount(0);
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Fixture Book 0000');
  expect(writes).toHaveLength(0);
});

test('upload saves exactly one file and immediately refreshes the displayed cover', async ({ page }) => {
  const { writes } = await setup(page);
  await page.getByLabel('Title', { exact: true }).fill('Retitled book');
  await page.getByLabel('Choose cover', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: 'Save Info', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('current-cover').locator('img')).toHaveAttribute('src', /v=replacement/);
  expect(writes.map(write => write.method)).toEqual(['PUT', 'POST']);
  expect(writes[1].body?.match(/name="file"/g)).toHaveLength(1);
  expect(writes[1].body).toContain('filename="new-cover.png"');
  await expect(page.getByTestId('books')).toContainText('Retitled book');
});

test('restoring the original is pending until Save Info and refreshes its revision', async ({ page }) => {
  const { writes } = await setup(page, { override: true });
  await page.getByRole('button', { name: 'Restore original cover', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('status')).toHaveText('Original cover will be restored when you save.');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Save Info', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('current-cover').locator('img')).toHaveAttribute('src', /v=restored/);
  expect(writes.map(write => write.method)).toEqual(['PUT', 'DELETE']);
});

test('partial failure explains saved info, retains the chosen file, and permits retry', async ({ page }) => {
  const context = await setup(page, { failCover: true });
  await page.getByLabel('Title', { exact: true }).fill('Saved despite cover error');
  await page.getByLabel('Choose cover', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: 'Save Info', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Book info was saved, but the cover update could not be confirmed.');
  await expect(page.getByAltText('Selected cover preview')).toBeVisible();
  await expect(page.getByTestId('books')).toContainText('Saved despite cover error');
  context.succeed();
  await page.getByRole('button', { name: 'Save Info', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('busy saves reject repeat submission and preserve playback advanced during the request', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const { writes } = await setup(page, { pauseMetadata: pending });
  await page.getByLabel('Choose cover', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: 'Save Info', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Close metadata editor', exact: true })).toBeDisabled();
  await page.getByRole('dialog').evaluate(form => { (form as HTMLFormElement).requestSubmit(); });
  await page.locator('#progress').evaluate(button => (button as HTMLButtonElement).click());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  release();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(writes).toHaveLength(2);
  await expect(page.getByTestId('books')).toContainText('"bookPositionSeconds":180');
});

test('a stale save never closes or alters the next book editor', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await setup(page, { pauseMetadata: pending });
  await page.getByLabel('Title', { exact: true }).fill('First book saved');
  await page.getByLabel('Choose cover', { exact: true }).setInputFiles(file);
  await page.getByRole('button', { name: 'Save Info', exact: true }).click();
  await page.locator('#navigate').evaluate(button => (button as HTMLButtonElement).click());
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit Info', exact: true }).click();
  await page.getByLabel('Title', { exact: true }).fill('Second book unsaved');
  release();
  await expect(page.getByTestId('books')).toContainText('v=replacement');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Second book unsaved');
  await expect(page.getByAltText('Selected cover preview')).toHaveCount(0);
});

test('invalid or oversized input is rejected before upload and the mobile editor stays usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { writes } = await setup(page, { native: true });
  await page.getByLabel('Choose cover', { exact: true }).setInputFiles({ name: 'cover.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
  await expect(page.getByRole('alert')).toContainText('Choose a JPEG, PNG, or WebP image.');
  await page.getByLabel('Choose cover', { exact: true }).setInputFiles({ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(8 * 1024 * 1024 + 1) });
  await expect(page.getByRole('alert')).toContainText('8 MiB or smaller');
  await page.getByLabel('Choose cover', { exact: true }).setInputFiles(file);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('mobile-cover-editor.png') });
  await expect(page.getByRole('button', { name: 'Save Info', exact: true })).toBeInViewport();
  expect(writes).toHaveLength(0);
});

for (const native of [false, true]) for (const width of [390, 1440]) {
  test(`${native ? 'native' : 'web'} editor fields and actions stay separate and reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page, { native });
    const bounds = await page.evaluate(() => ({
      fieldsBottom: document.querySelector('.metadata-edit-form')!.getBoundingClientRect().bottom,
      actionsTop: document.querySelector('.metadata-edit-actions')!.getBoundingClientRect().top
    }));
    expect(bounds.fieldsBottom).toBeLessThanOrEqual(bounds.actionsTop);
    const description = page.getByRole('textbox', { name: /^Description/ });
    await description.fill('Every field remains editable after scrolling.');
    await expect(description).toBeInViewport();
    await page.getByRole('button', { name: 'Save Info', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: 'Save Info', exact: true })).toBeInViewport();
    const resetBounds = await page.getByRole('button', { name: 'Reset', exact: true }).boundingBox();
    const saveBounds = await page.getByRole('button', { name: 'Save Info', exact: true }).boundingBox();
    expect(resetBounds!.y).toBe(saveBounds!.y);
    expect(resetBounds!.x + resetBounds!.width).toBeLessThan(saveBounds!.x);
    await page.getByRole('button', { name: 'Close metadata editor', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });
}
