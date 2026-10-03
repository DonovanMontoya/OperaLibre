import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const stylesheet = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

for (const view of ['details', 'now']) {
  test(`the ${view} reader docks on desktop and releases the whole viewport on phones`, async ({ page }) => {
    await page.setContent(`<html><head><style>${stylesheet}</style></head><body>
      <main class="web-shell player-view-${view} reader-open">
        <section class="player-pane"></section>
        <section class="readalong-panel reading-room">
          <div class="epub-reader room theme-paper">
            <header class="epub-roombar"><span>Extras</span><button>Close the reader</button></header>
            <div class="reading-room-content"><iframe class="readalong-frame" title="Extras" srcdoc="<p>Companion text</p>"></iframe></div>
            <nav class="epub-rail">This file</nav>
          </div>
        </section>
        <aside class="mini-player"><div class="mini-meta">Book title</div><div class="mini-actions"><button>Pause</button></div></aside>
      </main>
    </body></html>`);
    for (const width of [1440, 900, 899, 390, 700, 1100]) {
      await page.setViewportSize({ width, height: 900 });
      const dock = page.locator('.mini-player');
      const room = page.locator('.reading-room');
      await expect(dock).toBeVisible({ visible: width >= 900 });
      if (width >= 900) {
        await expect(dock).toHaveCSS('position', 'fixed');
        await expect(dock).toHaveCSS('margin', '0px');
        const box = (await dock.boundingBox())!;
        expect(box.x).toBe(0);
        expect(box.width).toBe(width);
        expect(box.y + box.height).toBe(900);
        const reader = (await room.boundingBox())!;
        expect(reader.y + reader.height).toBe(box.y);
        await expect(page.locator('.epub-rail')).toBeVisible();
      } else {
        await expect(page.locator('.epub-rail')).toBeHidden();
        const content = (await page.locator('.reading-room-content').boundingBox())!;
        expect(content.width).toBeGreaterThanOrEqual(width - 24);
        expect(content.x).toBeGreaterThanOrEqual(0);
        expect(content.x + content.width).toBeLessThanOrEqual(width);
        const reader = (await room.boundingBox())!;
        expect(reader.height).toBe(900);
        await expect(page.getByRole('button', { name: 'Close the reader' })).toBeVisible();
      }
    }
    await page.evaluate(() => document.querySelector('.web-shell')!.classList.remove('reader-open'));
    if (view === 'details') {
      await expect(page.locator('.mini-player')).toHaveCSS('position', 'relative');
    } else {
      await expect(page.locator('.mini-player')).toBeHidden();
    }
  });
}
