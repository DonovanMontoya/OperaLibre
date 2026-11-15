import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

declare global { interface Window { __operalibreReader: { rendition: {
  next(): Promise<unknown>;
  currentLocation(): { start: { cfi: string; href: string } };
  q: { enqueue(action: () => void): Promise<void> };
} }; pendingTurn: { release(): void; turns(): number }; } }

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

// Lifts the page partway with the finger still down, the way a sideways
// swipe begins a dragged turn.
async function liftPage(page: Page) {
  await page.setViewportSize({ width: 678, height: 466 });
  await page.goto(`${url}test/reader-catch-up.html?immersive&page-turn`);
  await expect(page.frameLocator('.epub-stage iframe').locator('p').first()).toBeVisible();
  const zone = (await page.locator('.epub-tapzones').boundingBox())!;
  const pointer = page.evaluate(() => new Promise<number>((resolve) => {
    document.addEventListener('pointerdown', (event) => resolve(event.pointerId), { once: true, capture: true });
  }));
  const x = zone.x + zone.width * 0.75;
  const y = zone.y + zone.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 40, y, { steps: 4 });
  await expect(page.locator('html[data-page-turn-drag]')).toHaveCount(1);
  return { pointerId: await pointer, x: x - 40, y };
}

// While a turn animates, WebKit can address the finger to the root element
// instead of the page it was captured by. The page must still be let go.
for (const type of ['pointerup', 'pointercancel'] as const) {
  test(`a dragged page is let go when its ${type} reaches the root instead of the page`, async ({ page }) => {
    const { pointerId, x, y } = await liftPage(page);
    await page.evaluate(({ type, pointerId, x, y }) => {
      document.documentElement.dispatchEvent(new PointerEvent(type, {
        pointerId, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true
      }));
    }, { type, pointerId, x, y });
    await expect(page.locator('html[data-page-turn]')).toHaveCount(0);
    await page.mouse.up();
    await page.getByRole('button', { name: 'Close the reader' }).click();
    await expect(page.locator('.epub-reader')).toHaveCount(0);
  });
}

test('a dragged page is let go when the app leaves the screen mid-drag', async ({ page }) => {
  await liftPage(page);
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('html[data-page-turn]')).toHaveCount(0);
});

test('a new first finger lets go of a page whose lift never arrived', async ({ page }) => {
  const { pointerId } = await liftPage(page);
  await page.evaluate((pointerId) => {
    const close = document.querySelector('[aria-label="Close the reader"]')!.getBoundingClientRect();
    document.documentElement.dispatchEvent(new PointerEvent('pointerdown', {
      pointerId: pointerId + 1, pointerType: 'touch', isPrimary: true,
      clientX: close.x + close.width / 2, clientY: close.y + close.height / 2, bubbles: true, cancelable: true
    }));
  }, pointerId);
  await expect(page.locator('html[data-page-turn]')).toHaveCount(0);
});

// A dragged turn holds its animations still for the finger. A turn begun
// while the page is still being laid down takes over the same pseudo-elements
// and must not inherit them paused, or it never finishes.
for (const gap of [60, 100]) {
  test(`a turn begun ${gap}ms after a dragged page is laid down finishes, on the right page`, async ({ page }) => {
    await page.setViewportSize({ width: 678, height: 466 });
    await page.goto(`${url}test/reader-catch-up.html?immersive&page-turn`);
    await expect(page.frameLocator('.epub-stage iframe').locator('p').first()).toBeVisible();
    const place = () => page.evaluate(() =>
      (window as any).__operalibreReader?.rendition?.currentLocation()?.start?.cfi as string | undefined);
    await expect.poll(place).toBeTruthy();
    const start = await place();
    const zone = (await page.locator('.epub-tapzones').boundingBox())!;
    const x = zone.x + zone.width * 0.75;
    const y = zone.y + zone.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 30, y, { steps: 3 });
    await expect(page.locator('html[data-page-turn-drag]')).toHaveCount(1);
    await page.mouse.up();
    await page.waitForTimeout(gap);
    // Back a page from the one the drag turned to: where the reader began.
    await page.mouse.click(zone.x + 8, y);
    await expect(page.locator('html[data-page-turn]')).toHaveCount(0);
    await expect.poll(place).toBe(start);
    await page.getByRole('button', { name: 'Close the reader' }).click();
    await expect(page.locator('.epub-reader')).toHaveCount(0);
  });
}

test('rapid forward swipes retain every page turn and release the transition animations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const reference = await page.context().newPage();
  await reference.setViewportSize({ width: 390, height: 844 });
  try {
    for (const target of [page, reference]) {
      await target.goto(`${url}test/reader-catch-up.html?immersive&long-chapters${target === page ? '&page-turn' : ''}`);
      await expect(target.frameLocator('.epub-stage iframe').locator('p').first()).toBeVisible();
    }
    const zone = (await page.locator('.epub-tapzones').boundingBox())!;
    const y = zone.y + zone.height / 2;
    for (let index = 0; index < 20; index++) {
      await page.mouse.move(zone.x + zone.width * .85, y);
      await page.mouse.down();
      await page.mouse.move(zone.x + zone.width * .15, y, { steps: 4 });
      await page.mouse.up();
    }
    const expected = await reference.evaluate(async () => {
      const { rendition } = window.__operalibreReader;
      for (let index = 0; index < 20; index++) await rendition.next();
      await rendition.q.enqueue(() => undefined);
      return rendition.currentLocation().start.cfi;
    });
    await expect(page.locator('html[data-page-turn]')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() =>
      window.__operalibreReader.rendition.currentLocation().start.cfi)).toBe(expected);
    expect(await page.evaluate(() => document.getAnimations().filter(animation =>
      (animation.effect as KeyframeEffect | null)?.pseudoElement?.includes('(reader-page')).length)).toBe(0);
  } finally { await reference.close(); }
});

test('closing the reader cancels a transition before its pending page turn runs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${url}test/reader-catch-up.html?immersive&page-turn`);
  await expect(page.frameLocator('.epub-stage iframe').locator('p').first()).toBeVisible();
  await page.evaluate(async () => {
    const modulePath = '/src/readerPageTurn.ts';
    const { runPageTurn }: typeof import('../../src/readerPageTurn') = await import(modulePath);
    const start = document.startViewTransition.bind(document);
    let release = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    document.startViewTransition = update => start(async () => {
      await gate;
      if (typeof update === 'function') await update();
    });
    let turns = 0;
    const target = document.querySelector<HTMLElement>('.epub-stage')!;
    runPageTurn(target, 'next', () => { turns++; return Promise.resolve(); });
    window.pendingTurn = { release, turns: () => turns };
    document.querySelector<HTMLButtonElement>('[aria-label="Close the reader"]')!.click();
  });
  await expect(page.locator('.epub-reader')).toHaveCount(0);
  await page.evaluate(() => window.pendingTurn.release());
  await expect(page.locator('html[data-page-turn]')).toHaveCount(0);
  expect(await page.evaluate(() => window.pendingTurn.turns())).toBe(0);
});
