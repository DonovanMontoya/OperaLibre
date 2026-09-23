import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

type ReaderWindow = Window & {
  __operalibreReader: {
    rendition: {
      annotations: { _annotations: Record<string, { cfiRange: string }> };
      getContents(): Array<{ cfiFromRange(range: Range): string }>;
      currentLocation(): { start: { cfi: string; href: string } };
      manager: { container: HTMLElement };
    };
  };
};

let server: ViteDevServer;
let url: string;

test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});

test.afterAll(async () => {
  await server?.close();
});

async function openReader(page: Page, narration = false) {
  await page.goto(`${url}test/reader-catch-up.html${narration ? '?narration' : ''}`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  await expect(page.locator('.epub-stage iframe')).toHaveCount(1);
  await expect(page.locator('.epub-error')).toHaveCount(0);
}

const annotations = (page: Page) => page.evaluate(() =>
  Object.values((window as unknown as ReaderWindow).__operalibreReader.rendition.annotations._annotations).map(value => value.cfiRange));

const place = (page: Page) => page.evaluate(() =>
  (window as unknown as ReaderWindow).__operalibreReader.rendition.currentLocation().start?.cfi);

test('a resize before the first page reports its location lays the page out again', async ({ page }) => {
  // epub.js reports the first location a frame after the page is shown. Hold
  // that report back and narrow the reader in the gap, as a fold, rotation
  // or late toolbar row can.
  await page.addInitScript(() => {
    let reader: unknown;
    Object.defineProperty(window, '__operalibreReader', {
      configurable: true,
      get: () => reader,
      set(value: { rendition: { reportLocation(): unknown } }) {
        reader = value;
        const report = value.rendition.reportLocation.bind(value.rendition);
        let first = true;
        value.rendition.reportLocation = () => {
          if (!first) return report();
          first = false;
          document.getElementById('root')!.style.width = '900px';
          return new Promise(resolve => setTimeout(resolve, 500)).then(report);
        };
      }
    });
  });
  await page.goto(`${url}test/reader-catch-up.html`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as ReaderWindow).__operalibreReader.rendition.currentLocation()?.start?.href)).toContain('c1.xhtml');
  await expect(page.frameLocator('.epub-stage iframe').locator('p').first()).toBeVisible();
});

test('Focus preserves the EPUB host and rendition through resizing and returning inline', async ({ page }) => {
  await openReader(page);
  const stage = await page.locator('.epub-stage').elementHandle();
  const rendition = await page.evaluateHandle(() => (window as unknown as ReaderWindow).__operalibreReader.rendition);
  for (const focus of [true, false, true, false]) {
    await page.getByRole('button', { name: focus ? 'Open reader focus mode' : 'Close the reader', exact: true }).click();
    expect(await stage!.evaluate(element => element === document.querySelector('.epub-stage'))).toBe(true);
    expect(await rendition.evaluate(value => value === (window as unknown as ReaderWindow).__operalibreReader.rendition)).toBe(true);
    await expect(page.locator('.epub-stage iframe')).toHaveCount(1);
    await page.setViewportSize(focus ? { width: 1000, height: 700 } : { width: 1440, height: 900 });
    await expect.poll(() => page.evaluate(() => {
      const stage = document.querySelector('.epub-stage')!.getBoundingClientRect();
      const container = (window as unknown as ReaderWindow).__operalibreReader.rendition.manager.container.getBoundingClientRect();
      return Math.abs(stage.width - container.width) + Math.abs(stage.height - container.height);
    })).toBeLessThan(3);
  }
  // The viewport has resized, but epub.js may still be calculating its new
  // location. Wait for that location before comparing the next page turn.
  await expect.poll(() => place(page)).toBeTruthy();
  const before = await place(page);
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect.poll(async () => (await place(page)) ?? before).not.toBe(before);
});

test('chapter following opens at the current audiobook chapter before sentence sync is available', async ({ page }) => {
  await page.goto(`${url}test/reader-catch-up.html?chapter-sync`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as ReaderWindow).__operalibreReader.rendition.currentLocation()?.start?.href
  )).toContain('c2.xhtml');
  // The remembered-page settling checks run at 300 ms and 1 s. The narrated
  // chapter must remain in control after both have had a chance to run.
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() =>
    (window as unknown as ReaderWindow).__operalibreReader.rendition.currentLocation().start.href
  )).toContain('c2.xhtml');
});

for (const failure of ['missing sentence', 'CFI conversion'] as const) {
  test(`${failure} clears the previous narration mark and cannot revive it on updates or relayout`, async ({ page }) => {
    await openReader(page, true);
    await expect.poll(() => annotations(page)).toHaveLength(1);
    const original = await annotations(page);
    if (failure === 'CFI conversion') {
      await page.evaluate(() => {
        const contents = (window as unknown as ReaderWindow).__operalibreReader.rendition.getContents()[0];
        const original = contents.cfiFromRange;
        contents.cfiFromRange = function(range) {
          contents.cfiFromRange = original;
          throw new Error(`Fixture CFI failure: ${range.toString()}`);
        };
      });
    }
    const failedPosition = failure === 'missing sentence' ? 11 : 21;
    await page.getByLabel('Narration position').fill(String(failedPosition));
    await expect.poll(() => annotations(page)).toHaveLength(0);
    await expect(page.locator('.readalong-highlight')).toHaveCount(0);
    const failedPlace = await place(page);
    await page.getByLabel('Narration position').fill(String(failedPosition + 1));
    expect(await place(page)).toBe(failedPlace);
    await page.getByRole('button', { name: 'sepia', exact: true }).click();
    await page.setViewportSize({ width: 1100, height: 750 });
    await expect.poll(() => annotations(page)).toHaveLength(0);
    await page.getByLabel('Narration position').fill(String(failedPosition + 2));
    expect(await annotations(page)).toEqual([]);
    if (failure === 'missing sentence') {
      await page.getByLabel('Narration position').fill('21');
      await expect.poll(() => annotations(page)).toHaveLength(1);
      expect(await annotations(page)).not.toEqual(original);
    }
    expect(failedPlace).toBeTruthy();
    await page.getByLabel('Narration position').fill('31');
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as ReaderWindow).__operalibreReader.rendition.currentLocation()?.start?.href)).toContain('c2.xhtml');
    await expect.poll(() => annotations(page)).toHaveLength(0);
    await page.getByLabel('Narration position').fill('41');
    await expect.poll(() => annotations(page)).toHaveLength(1);
    await page.getByRole('button', { name: 'Stop following narration', exact: true }).click();
    await expect.poll(() => annotations(page)).toHaveLength(0);
  });
}
