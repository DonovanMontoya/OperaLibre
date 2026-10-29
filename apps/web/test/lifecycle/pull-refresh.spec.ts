import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

async function pull(page: Page, ending: 'touchend' | 'touchcancel') {
  const shelf = page.getByTestId('shelf');
  await shelf.evaluate(element => element.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, touches: [new Touch({ identifier: 1, target: element, clientY: 0 })] })));
  await shelf.evaluate(element => element.dispatchEvent(new TouchEvent('touchmove', { bubbles: true, touches: [new Touch({ identifier: 1, target: element, clientY: 200 })] })));
  await expect(page.getByTestId('pull')).toHaveText('90');
  await shelf.dispatchEvent(ending, { touches: [] });
}

for (const source of ['libro', 'all']) {
  test(`${source} refresh failure is visible, retains books, and allows retry`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let requests = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await page.route('**/api/me/libro/refresh', async route => {
      requests++;
      if (requests === 1) await pending;
      await route.fulfill({ status: requests === 1 ? 503 : 200, contentType: 'application/json',
        body: requests === 1 ? JSON.stringify({ message: 'Libro.fm refresh unavailable' }) : JSON.stringify({ id: 'refresh-job' }) });
    });
    await page.goto(`${url}test/pull-refresh.html`);
    await page.getByLabel('Source').selectOption(source);
    const before = await page.getByTestId('shelf').innerText();
    await pull(page, 'touchend');
    await expect(page.getByTestId('refreshing')).toHaveText('true');
    release();
    await expect(page.getByRole('alert')).toContainText('Libro.fm refresh unavailable');
    await expect(page.getByTestId('refreshing')).toHaveText('false');
    await expect(page.getByTestId('shelf')).toHaveText(before);
    if (source === 'all') await expect(page.getByTestId('audible')).toHaveText('1');
    await pull(page, 'touchend');
    await expect(page.getByTestId('libro')).toHaveText(source === 'all' ? '2' : '1');
    await expect(page.getByTestId('refreshing')).toHaveText('false');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(requests).toBe(2);
    expect(errors).toEqual([]);
  });
}

test('canceling a threshold-crossing pull clears it without refreshing', async ({ page }) => {
  let requests = 0;
  await page.route('**/api/me/libro/refresh', async route => {
    requests++;
    await route.fulfill({ json: { id: 'refresh-job' } });
  });
  await page.goto(`${url}test/pull-refresh.html`);
  await pull(page, 'touchcancel');
  await expect(page.getByTestId('pull')).toHaveText('0');
  await expect(page.getByTestId('refreshing')).toHaveText('false');
  // A subsequent release must not commit the canceled gesture either.
  await page.getByTestId('shelf').dispatchEvent('touchend', { touches: [] });
  await expect(page.getByTestId('libro')).toHaveText('0');
  expect(requests).toBe(0);
  await pull(page, 'touchend');
  await expect(page.getByTestId('libro')).toHaveText('1');
  expect(requests).toBe(1);
});
