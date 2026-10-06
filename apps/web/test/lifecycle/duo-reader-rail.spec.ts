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

test('the Duo Book reader title clears the close target and stays before the crease', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 951, height: 669 });
  await page.goto(`${url}test/reader-catch-up.html?immersive&narration&listening=1`);
  await page.evaluate(async () => {
    const path = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(path);
    applyDeviceFold(document.documentElement, {
      posture: 'half-open', angle: 110,
      fold: { x: 470, y: 0, width: 12, height: 669, axis: 'vertical', active: true }
    });
  });
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  const close = page.getByRole('button', { name: 'Close the reader' });
  const closeBounds = (await close.boundingBox())!;
  const titleBounds = (await page.locator('.epub-topbar-title').boundingBox())!;
  expect(titleBounds.x).toBeGreaterThanOrEqual(closeBounds.x + closeBounds.width + 6);
  expect(titleBounds.x + titleBounds.width).toBeLessThan(470);
  await close.click({ position: { x: closeBounds.width - 2, y: closeBounds.height / 2 } });
  await expect(page.locator('.epub-reader')).toHaveCount(0);
});

for (const edge of ['left', 'right'] as const) {
  for (const posture of ['flat', 'closed'] as const) {
    for (const height of [264, 300]) {
      test(`Duo ${posture} reader ${edge} ${height}px rail clears text and page taps while playback controls remain reachable`, async ({ page }, testInfo) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const width = posture === 'closed' ? 678 : 951;
        await page.setViewportSize({ width, height: posture === 'closed' ? 466 : 669 });
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { [edge]: 84 } });
        await page.goto(`${url}test/reader-catch-up.html?immersive&narration&listening=1`);
        await page.evaluate(({ edge, height, width, posture }) => {
          const root = document.documentElement;
          root.classList.add('side-rail');
          root.dataset.railControls = 'full';
          root.dataset.foldPosture = posture;
          for (const [key, value] of Object.entries({ '--rail-x': edge === 'left' ? '0px' : `${width - 84}px`,
            '--rail-width': '84px', '--rail-top': '120px', '--rail-bottom': `${120 + height}px` })) root.style.setProperty(key, value);
        }, { edge, height, width, posture });
        await expect(page.locator('.epub-loading')).toHaveCount(0);
        await expect.poll(() => page.evaluate(() => {
          const stage = document.querySelector<HTMLElement>('.epub-stage')!;
          const iframe = stage.querySelector('iframe');
          return iframe ? iframe.offsetHeight - stage.clientHeight : null;
        }), { message: 'The EPUB iframe must fill the reader stage' }).toBe(0);
        const rail = (await page.locator('.epub-audiobar').boundingBox())!;
        expect(rail).toEqual({ x: edge === 'left' ? 0 : width - 84, y: 120, width: 84, height });
        const stage = (await page.locator('.epub-stage').boundingBox())!;
        if (edge === 'left') expect(stage.x).toBeGreaterThanOrEqual(rail.x + rail.width);
        else expect(stage.x + stage.width).toBeLessThanOrEqual(rail.x);
        for (const button of await page.locator('.epub-audiobar button:visible').all()) {
          const bounds = (await button.boundingBox())!;
          expect(bounds.y).toBeGreaterThanOrEqual(rail.y);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(rail.y + rail.height);
          expect(await button.evaluate(element => {
            const rect = element.getBoundingClientRect();
            return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
          })).toBe(true);
        }
        const play = page.locator('.epub-audiobar-play');
        await play.click();
        await expect(play).toHaveAccessibleName('Pause');
        await play.click();
        await expect(play).toHaveAccessibleName('Play');
        await expect(page.getByLabel('Narration position')).toHaveValue('0');
        await page.screenshot({ path: testInfo.outputPath(`${edge}-rail.png`) });
        const catcher = (await page.locator('.epub-tapzones').boundingBox())!;
        if (edge === 'left') expect(catcher.x).toBeGreaterThanOrEqual(rail.x + rail.width);
        else expect(catcher.x + catcher.width).toBeLessThanOrEqual(rail.x);
        await cdp.detach();
      });
    }
  }
}

test('a short Duo reader keeps all listening controls reachable when the native rail is unavailable', async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 360 });
  await page.goto(`${url}test/reader-catch-up.html?immersive&narration&listening=1`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  for (const button of await page.locator('.epub-audiobar button:visible').all()) {
    const bounds = (await button.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(720);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(360);
    expect(await button.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
  }
  const play = page.locator('.epub-audiobar-play');
  await play.click();
  await expect(play).toHaveAccessibleName('Pause');
  await play.click();
  await expect(play).toHaveAccessibleName('Play');
});

test('the reader resizes its page when epub.js measures the new stage before the observer', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 669 });
  await page.goto(`${url}test/reader-catch-up.html?immersive&narration&listening=1`);
  await expect(page.frameLocator('.epub-stage iframe').locator('p').first()).toBeVisible();
  const layout = () => page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.epub-stage')!;
    const iframe = stage.querySelector('iframe');
    const rendition = (window as any).__operalibreReader?.rendition;
    return { heightDifference: iframe ? iframe.offsetHeight - stage.clientHeight : null,
      cfi: rendition?.currentLocation()?.start?.cfi as string | undefined };
  });
  await expect.poll(async () => (await layout()).heightDifference).toBe(0);
  await expect.poll(async () => (await layout()).cfi).toBeTruthy();
  const before = (await layout()).cfi;
  await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>('.epub-stage')!;
    const rendition = (window as any).__operalibreReader.rendition;
    // A toolbar disappearing grows the stage. epub.js can measure that new
    // percentage height while the iframe still has its previous fixed height.
    stage.style.height = `${stage.clientHeight + 56}px`;
    rendition.manager.container.style.height = '100%';
    rendition.manager.updateLayout();
  });
  await expect.poll(async () => (await layout()).heightDifference).toBe(0);
  await expect.poll(async () => (await layout()).cfi).toBe(before);
  await expect(page.frameLocator('.epub-stage iframe').locator('p').first()).toBeVisible();
});
