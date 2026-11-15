import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import type { Book } from 'epubjs';
import type Section from 'epubjs/types/section';
import type { Chapter, SyncMap } from '../../src/types';

type InspectionFixture = { createInspectionBook(): Promise<Book>; chapters: Chapter[]; map: SyncMap };

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

for (const inline of [false, true]) {
  test(`illustration inspection leaves the real EPUB cache untouched and preserves CFIs (inline: ${inline})`, async ({ page }) => {
    await page.goto(`${url}test/follow-along/reader.html${inline ? '?inline' : ''}`);
    await expect(page.locator('.epub-loading')).toHaveCount(0);
    const result = await page.evaluate(async () => {
      const fixturePath = '/test/follow-along/reader.tsx';
      const inspectionPath = '/src/readerIllustrationGaps.ts';
      const fixture: InspectionFixture = await import(fixturePath);
      const { findIllustrationGaps }: typeof import('../../src/readerIllustrationGaps') = await import(inspectionPath);
      const book = await fixture.createInspectionBook();
      try {
        const gaps = await findIllustrationGaps(book, fixture.map.fragments, fixture.chapters);
        let retained = 0;
        book.spine.each((section: Section) => { if (section.document) retained++; });
        const targets: string[] = [];
        for (const gap of gaps) {
          if (!gap.cfi) continue;
          const range = await book.getRange(gap.cfi);
          const node = range.startContainer;
          targets.push(node instanceof Element ? node.localName : '#text');
        }
        // Inspection must also leave documents already owned by the renderer alone.
        const section = book.spine.get('c1.xhtml');
        await section.load(book.load.bind(book));
        const held = section.document;
        const again = await findIllustrationGaps(book, fixture.map.fragments, fixture.chapters);
        return { retained, targets, gaps, again, preserved: held === section.document };
      } finally { book.destroy(); }
    });
    expect(result.retained).toBe(0);
    if (inline) expect(result.targets).toEqual(['svg', 'svg', 'svg']);
    expect(result.again).toEqual(result.gaps);
    expect(result.preserved).toBe(true);
    expect(result.gaps).toHaveLength(inline ? 3 : 2);
  });
}

test('an aborted illustration scan stops after its in-flight read without populating the EPUB cache', async ({ page }) => {
  await page.goto(`${url}test/follow-along/reader.html`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  const result = await page.evaluate(async () => {
    const fixturePath = '/test/follow-along/reader.tsx';
    const inspectionPath = '/src/readerIllustrationGaps.ts';
    const fixture: InspectionFixture = await import(fixturePath);
    const { findIllustrationGaps }: typeof import('../../src/readerIllustrationGaps') = await import(inspectionPath);
    const book = await fixture.createInspectionBook();
    const controller = new AbortController();
    const load = book.load.bind(book);
    let reads = 0;
    book.load = async (path) => {
      reads++;
      controller.abort();
      return load(path);
    };
    try {
      await findIllustrationGaps(book, fixture.map.fragments, fixture.chapters, controller.signal);
      return { reads, aborted: false, retained: -1 };
    } catch (error) {
      let retained = 0;
      book.spine.each((section: Section) => { if (section.document) retained++; });
      return { reads, aborted: error instanceof DOMException && error.name === 'AbortError', retained };
    } finally { book.destroy(); }
  });
  expect(result).toEqual({ reads: 1, aborted: true, retained: 0 });
});
