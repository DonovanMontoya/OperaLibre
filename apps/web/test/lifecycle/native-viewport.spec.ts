import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 669, height: 951 });
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.goto(`${url}test/duo-shell.html`);
  await expect(page.locator('html')).toHaveCSS('--native-layout-height', '951px');
  await page.clock.install();
});

test('Duo resize recovers when WebKit updates its viewport after the only resize event', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 678 });
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 678 });
    window.dispatchEvent(new Event('resize'));
  });
  await page.clock.runFor(32);
  // The document already has its new layout size even while WebKit reports
  // the previous visual viewport. This must not shrink full-height sheets.
  await expect(page.locator('html')).toHaveCSS('--native-layout-height', '951px');
  await page.evaluate(() => {
    // Observed on the simulator: these change without a second resize event.
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 951 });
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 951 });
  });
  await page.clock.runFor(350);
  await expect(page.locator('html')).toHaveCSS('--native-viewport-height', '951px');
  await expect(page.locator('html')).not.toHaveClass(/native-keyboard-open/);
});

test('settling preserves the keyboard viewport and restores it when the keyboard closes', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 580 });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 24 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await page.clock.runFor(350);
  await expect(page.locator('html')).toHaveCSS('--native-layout-height', '951px');
  await expect(page.locator('html')).toHaveCSS('--native-viewport-height', '580px');
  await expect(page.locator('html')).toHaveCSS('--native-viewport-top', '24px');
  await expect(page.locator('html')).toHaveClass(/native-keyboard-open/);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 951 });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 0 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await page.clock.runFor(350);
  await expect(page.locator('html')).toHaveCSS('--native-viewport-height', '951px');
  await expect(page.locator('html')).toHaveCSS('--native-viewport-top', '0px');
  await expect(page.locator('html')).not.toHaveClass(/native-keyboard-open/);
});

test('native layout notification refreshes sizing even before animation frames resume', async ({ page }) => {
  const dimensions = await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 678 });
    window.dispatchEvent(new Event('operalibre:viewportchange'));
    const root = document.documentElement;
    return [root.style.getPropertyValue('--native-viewport-height'), root.style.getPropertyValue('--native-layout-height')];
  });
  expect(dimensions).toEqual(['678px', '951px']);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 951 });
  });
  await page.clock.runFor(350);
  await expect(page.locator('html')).toHaveCSS('--native-viewport-height', '951px');
  await expect(page.locator('html')).not.toHaveClass(/native-keyboard-open/);
});

test('returning to the foreground refreshes a viewport resized while hidden', async ({ page }) => {
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 678 });
    window.dispatchEvent(new Event('operalibre:viewportchange'));
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 951 });
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('html')).toHaveCSS('--native-viewport-height', '951px');
  await expect(page.locator('html')).not.toHaveClass(/native-keyboard-open/);
});
