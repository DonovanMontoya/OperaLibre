import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer, type ViteDevServer } from 'vite';
import type { DeviceFoldState } from '../../src/deviceFold';
import { library } from '../performance/fixtures';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

test('regular portrait iPhone gives the player transport stronger emphasis', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  const stylesheet = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
  await page.setContent(`<html class="native-app"><head><style>${stylesheet}</style></head><body>
    <main class="native-shell">
      <section class="player-pane has-native-player native-player-view-now fit-playback">
        <div class="native-now-playing">
          <div class="native-now-half native-now-lead"><div class="native-now-artwork"></div></div>
          <div class="native-now-half native-now-controls">
            <div class="native-now-timeline"></div>
            <div class="native-now-transport">
              <button class="native-now-chapter"><svg></svg><span>Restart</span></button>
              <button class="native-now-seek"><svg></svg><span>15s</span></button>
              <button class="native-now-play" aria-label="Play"><svg></svg></button>
              <button class="native-now-seek"><svg></svg><span>30s</span></button>
              <button class="native-now-chapter"><svg></svg><span>Next</span></button>
            </div>
            <div class="native-now-utility"><button><svg></svg><span>Details</span></button></div>
          </div>
        </div>
      </section>
    </main>
  </body></html>`);

  await expect(page.locator('.native-now-play')).toHaveCSS('width', '96px');
  await expect(page.locator('.native-now-play')).toHaveCSS('height', '96px');
  await expect(page.locator('.native-now-seek').first()).toHaveCSS('width', '56px');
  await expect(page.locator('.native-now-seek').first()).toHaveCSS('height', '64px');
  await expect(page.locator('.native-now-utility button')).toHaveCSS('min-height', '58px');

  // A folded Duo is still phone-sized, but uses its own tuned composition.
  await page.evaluate(() => { document.documentElement.dataset.foldPosture = 'closed'; });
  await expect(page.locator('.native-now-play')).toHaveCSS('width', '64px');
});

test('cover-screen transport stays inside its rail as Now Playing consumes space', async ({ page }) => {
  await page.setViewportSize({ width: 466, height: 678 });
  await page.setContent(`<html class="native-app side-rail"><head>
    <link rel="stylesheet" href="${url}src/styles.css?direct">
    </head><body><main class="native-shell tab-shelf has-mini-player">
    <aside class="mini-player" aria-label="Mini player">
      <button class="mini-cover-button" aria-label="Open current book">Book</button>
      <button class="mini-meta">Book title</button>
      <div class="mini-progress">Progress</div>
      <div class="mini-actions">
        <button class="mini-chapter">Chapter</button>
        <button class="mini-seek" aria-label="Rewind">15</button>
        <button class="mini-play" aria-label="Pause">Pause</button>
        <button class="mini-seek" aria-label="Forward">30</button>
      </div>
    </aside></main></body></html>`);
  for (const [height, controls] of [[216, 'full'], [180, 'transport'], [164, 'transport'], [100, 'play'], [60, 'play'], [216, 'full']] as const) {
    await page.evaluate(({ height, controls }) => {
      const root = document.documentElement;
      root.dataset.railControls = controls;
      root.style.setProperty('--rail-x', '382px');
      root.style.setProperty('--rail-width', '84px');
      root.style.setProperty('--rail-bottom', '390px');
      root.style.setProperty('--rail-top', `${390 - height}px`);
    }, { height, controls });
    const player = await page.getByRole('complementary', { name: 'Mini player' }).boundingBox();
    expect(player!.x).toBeGreaterThanOrEqual(382);
    expect(player!.y).toBeGreaterThanOrEqual(390 - height);
    expect(player!.y + player!.height).toBeLessThanOrEqual(390);
    for (const button of await page.locator('.mini-player button:visible').all()) {
      const box = (await button.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.y).toBeGreaterThanOrEqual(player!.y);
      expect(box.y + box.height).toBeLessThanOrEqual(player!.y + player!.height);
    }
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
    await expect(page.locator('.mini-cover-button')).toBeVisible({ visible: controls === 'full' });
    await expect(page.getByRole('button', { name: 'Rewind', exact: true })).toBeVisible({ visible: controls !== 'play' });
  }

  // Rotating the closed device the other way mirrors UIKit's tab column.
  // The same compact transport follows it instead of falling back to a
  // full-width ribbon across the shelf.
  await page.evaluate(() => {
    const root = document.documentElement;
    root.style.setProperty('--rail-x', '0px');
    root.style.setProperty('--rail-width', '84px');
    root.style.setProperty('--rail-top', '120px');
    root.style.setProperty('--rail-bottom', '336px');
    root.dataset.railControls = 'full';
  });
  const mirroredPlayer = (await page.getByRole('complementary', { name: 'Mini player' }).boundingBox())!;
  expect(mirroredPlayer.x).toBeGreaterThanOrEqual(0);
  expect(mirroredPlayer.x + mirroredPlayer.width).toBeLessThanOrEqual(84);
  expect(mirroredPlayer.y).toBeGreaterThanOrEqual(120);
  expect(mirroredPlayer.y + mirroredPlayer.height).toBeLessThanOrEqual(336);
});

test('unfolded spread keeps the mini player in the side rail, off the fold', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 669 });
  await page.setContent(`<html class="native-app side-rail" data-fold-posture="flat" data-fold-axis="vertical" data-fold-active><head>
    <link rel="stylesheet" href="${url}src/styles.css?direct">
    </head><body><main class="native-shell tab-shelf has-mini-player shelf-landscape">
    <section class="library-pane"></section><section class="player-pane"></section>
    <aside class="mini-player" aria-label="Mini player">
      <button class="mini-cover-button" aria-label="Open current book">Book</button>
      <div class="mini-actions"><button class="mini-play" aria-label="Pause">Pause</button></div>
    </aside></main></body></html>`);
  await page.evaluate(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries({ '--fold-x': '475px', '--fold-y': '0px', '--fold-width': '1px',
      '--fold-height': '669px', '--rail-x': '867px', '--rail-width': '84px', '--rail-top': '120px', '--rail-bottom': '380px' })) {
      root.style.setProperty(name, value);
    }
  });
  const player = (await page.getByRole('complementary', { name: 'Mini player' }).boundingBox())!;
  expect(player.x).toBeGreaterThanOrEqual(867);
  expect(player.x + player.width).toBeLessThanOrEqual(951);
  expect(player.y).toBeGreaterThanOrEqual(120);
  expect(player.y + player.height).toBeLessThanOrEqual(380);
});

test('wide Duo gives Shelf both leaves while Reading keeps the player spread', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 669 });
  const stylesheet = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
  await page.setContent(`<html class="native-app side-rail" data-fold-posture="half-open" data-fold-axis="vertical" data-fold-active><head>
    <style>${stylesheet}</style>
    </head><body><main class="native-shell tab-shelf has-mini-player shelf-landscape shelf-folded">
    <section class="library-pane"><div class="shelf-layout-controls">Layout</div><div class="book-list is-grid">
      ${Array.from({ length: 12 }, (_, index) => `<button class="book-row">Book ${index + 1}</button>`).join('')}
    </div></section><section class="player-pane">Player</section>
    </main></body></html>`);
  await page.evaluate(() => {
    const root = document.documentElement;
    root.className = 'native-app side-rail';
    root.dataset.foldPosture = 'half-open';
    root.dataset.foldAxis = 'vertical';
    root.setAttribute('data-fold-active', '');
    for (const [name, value] of Object.entries({ '--fold-x': '460px', '--fold-width': '31px',
      '--fold-height': '669px', '--status-h': '44px', '--tabs-h': '0px' })) {
      root.style.setProperty(name, value);
    }
  });

  await expect(page.locator('.player-pane')).toBeHidden();
  await expect(page.locator('.shelf-layout-controls')).toBeHidden();
  const libraryPane = (await page.locator('.library-pane').boundingBox())!;
  expect(libraryPane.x).toBeLessThanOrEqual(0.5);
  expect(libraryPane.x + libraryPane.width).toBeGreaterThanOrEqual(950.5);
  for (const book of await page.locator('.book-row').all()) {
    const box = (await book.boundingBox())!;
    expect(box.x + box.width <= 460 || box.x >= 491).toBe(true);
  }

  await page.locator('.book-list').evaluate(list => {
    list.setAttribute('class', 'book-list is-list');
    const run = (index: number) => `<div class="book-sort-run">
        <div class="book-sort-group"><span>Series</span><strong>Series ${index + 1}</strong></div>
        ${Array.from({ length: index === 0 ? 3 : 1 }, (_, bookIndex) =>
          `<button class="book-row">Book ${index + 1}.${bookIndex + 1}</button>`).join('')}
      </div>`;
    list.innerHTML = `<div class="book-leaf">${run(0)}${run(2)}</div><div class="book-leaf">${run(1)}${run(3)}</div>`;
  });
  const leaves = await page.locator('.book-leaf').all();
  const firstRun = (await leaves[0].locator('.book-sort-run').first().boundingBox())!;
  const secondRun = (await leaves[1].locator('.book-sort-run').first().boundingBox())!;
  expect(firstRun.x + firstRun.width).toBeLessThanOrEqual(460);
  expect(secondRun.x).toBeGreaterThanOrEqual(491);
  for (const book of await leaves[0].locator('.book-sort-run').first().locator('.book-row').all()) {
    const box = (await book.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(460);
  }

  await page.locator('.book-list').evaluate(list => list.classList.replace('is-list', 'is-grid'));
  for (const leaf of await page.locator('.book-leaf').all()) {
    const runs = await leaf.locator('.book-sort-run').all();
    for (const run of runs) {
      const runBox = (await run.boundingBox())!;
      const leafBox = (await leaf.boundingBox())!;
      expect(runBox.width).toBeGreaterThan(leafBox.width * 0.9);
      for (const book of await run.locator('.book-row').all()) {
        const box = (await book.boundingBox())!;
        expect(box.x + box.width <= 460 || box.x >= 491).toBe(true);
      }
    }
  }

  await page.locator('main').evaluate(main => {
    main.classList.remove('tab-shelf');
    main.classList.add('tab-reading');
  });
  await expect(page.locator('.player-pane')).toBeVisible();
  const playerPane = (await page.locator('.player-pane').boundingBox())!;
  expect(playerPane.x).toBeGreaterThanOrEqual(475);
  expect(await page.locator('main').evaluate(main => getComputedStyle(main, '::after').display)).toBe('none');
});

test('Duo page headers keep useful controls and drop decorative subtitles', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 669 });
  const stylesheet = readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');
  await page.setContent(`<html class="native-app" data-fold-posture="half-open" data-fold-axis="vertical" data-fold-active><head>
    <style>${stylesheet}</style>
    </head><body><main class="native-shell tab-shelf">
      <section class="library-pane" style="width:460px">
        <div class="pane-title">
          <div><span class="eyebrow">The Collection</span><h1>OperaLibre</h1></div>
          <div class="pane-actions">
            ${Array.from({ length: 5 }, (_, index) => `<button class="icon-button" aria-label="Action ${index + 1}">${index + 1}</button>`).join('')}
          </div>
        </div>
      </section>
      <section class="games-shell"><header class="games-head"><span class="eyebrow">The Parlour</span><h1>Games</h1><p>Small diversions for long listens.</p></header></section>
      <section class="settings-shell"><header class="settings-head"><div class="settings-heading"><span class="eyebrow">The Study</span><h1>Settings</h1></div></header></section>
    </main></body></html>`);

  await expect(page.getByText('The Collection')).toBeHidden();
  await expect(page.getByText('The Parlour')).toBeHidden();
  await expect(page.getByText('Small diversions for long listens.')).toBeHidden();
  await expect(page.getByText('The Study')).toBeHidden();
  expect(await page.getByText('The Collection').evaluate(element => getComputedStyle(element).display)).toBe('none');
  expect(await page.getByText('The Parlour').evaluate(element => getComputedStyle(element).display)).toBe('none');
  expect(await page.getByText('Small diversions for long listens.').evaluate(element => getComputedStyle(element).display)).toBe('none');
  expect(await page.getByText('The Study').evaluate(element => getComputedStyle(element).display)).toBe('none');

  const wordmark = (await page.getByRole('heading', { name: 'OperaLibre' }).boundingBox())!;
  const actions = (await page.locator('.pane-actions').boundingBox())!;
  expect(Math.abs(wordmark.y + wordmark.height / 2 - (actions.y + actions.height / 2))).toBeLessThanOrEqual(2);
  expect(actions.x + actions.width).toBeLessThanOrEqual(460);
});

test('Get Books keeps controls on the left leaf and books on the right leaf', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 669 });
  await page.setContent(`<html class="native-app side-rail" data-fold-posture="flat" data-fold-axis="vertical"><head>
    <link rel="stylesheet" href="${url}src/styles.css?direct">
    </head><body><main class="native-shell tab-shelf shelf-landscape device-ipad">
      <aside class="library-pane purchase-browsing">
        <header class="pane-title"><h1>OperaLibre</h1></header>
        <div class="library-toolbar">
          <div class="shelf-navigation"><button>Library</button><button>Get books</button></div>
          <div class="purchase-source"><div class="purchase-tabs"><button>All accounts</button><button>Libro.fm</button><button>Audible</button></div></div>
          <div class="library-search-row">Search</div><div class="library-controls"><label class="library-sort">Sort</label><button class="library-sort-direction">Down</button><div class="view-toggle"><button>List</button><button>Compact</button><button>Grid</button></div></div>
        </div>
        <div class="purchase-results">
          <div class="purchase-settings-pane"><details class="purchase-console"><summary>Activity</summary><section style="height:900px">Download activity</section></details></div>
          <div class="purchase-books-pane">
            <ol class="libro-purchases purchase-book-list purchase-book-list--list"><li class="purchase-book-row"><span class="libro-purchase-cover"></span><span class="libro-purchase-copy"><h3>Taipei Story</h3><p>Author</p></span><button>Import</button></li></ol>
            <div class="audible-list purchase-book-list purchase-book-list--list"><div class="audible-row purchase-book-row"><span class="audible-cover"></span><span class="audible-copy"><strong>12 Rules for Life</strong><span>Author</span></span><button>Download</button></div></div>
          </div>
        </div>
      </aside>
    </main></body></html>`);
  await page.evaluate(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries({ '--fold-x': '460px', '--fold-width': '31px',
      '--status-h': '44px', '--tabs-h': '0px', '--native-viewport-height': '669px' })) {
      root.style.setProperty(name, value);
    }
  });

  for (const selector of ['.pane-title', '.library-toolbar', '.purchase-settings-pane']) {
    const box = (await page.locator(selector).boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(460);
  }
  for (const selector of ['.library-search-row', '.library-controls']) {
    const box = (await page.locator(selector).boundingBox())!;
    expect(box.width).toBeGreaterThan(350);
  }
  const storeTabs = (await page.locator('.purchase-tabs').boundingBox())!;
  expect(storeTabs.width).toBeGreaterThan(350);
  const books = (await page.locator('.purchase-books-pane').boundingBox())!;
  expect(books.x).toBeGreaterThanOrEqual(491);
  await expect(page.locator('.purchase-settings-pane')).toHaveCSS('overflow-y', 'auto');
  await expect(page.locator('.purchase-books-pane')).toHaveCSS('overflow-y', 'auto');
  const libroRow = (await page.locator('.libro-purchases .purchase-book-row').boundingBox())!;
  const audibleRow = (await page.locator('.audible-list .purchase-book-row').boundingBox())!;
  expect(libroRow.width).toBe(audibleRow.width);
  expect((await page.locator('.libro-purchase-cover').boundingBox())!.width)
    .toBe((await page.locator('.audible-cover').boundingBox())!.width);
  expect((await page.locator('.libro-purchases button').boundingBox())!.width)
    .toBe((await page.locator('.audible-list button').boundingBox())!.width);
});

test('Ledger keeps its two leaves when flat; half-open Settings splits into two scrollers', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 669 });
  await page.setContent(`<html class="native-app" data-fold-axis="vertical" data-fold-active><head>
    <link rel="stylesheet" href="${url}src/styles.css?direct">
    </head><body>
    <article class="profile-page ledger-dashboard">
      <div class="ledger-upper"><p style="height:1200px">Upper</p></div>
      <div class="ledger-lower"><p style="height:1200px">Lower</p></div>
    </article>
    <section class="settings-shell">
      <header class="settings-head"><h1>Settings</h1></header>
      <div class="settings-cards">
        <div class="settings-upper"><p style="height:1200px">Upper</p></div>
        <div class="settings-lower"><p style="height:1200px">Lower</p></div>
      </div>
    </section>
    </body></html>`);
  await page.evaluate(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries({ '--fold-x': '460px', '--fold-width': '31px',
      '--status-h': '44px', '--tabs-h': '80px' })) {
      root.style.setProperty(name, value);
    }
  });
  const columnCount = () => page.locator('.ledger-dashboard').evaluate(el => getComputedStyle(el).columnCount);
  const overflowY = (selector: string) => page.locator(selector).evaluate(el => getComputedStyle(el).overflowY);

  await page.evaluate(() => {
    document.documentElement.dataset.foldPosture = 'flat';
    document.documentElement.removeAttribute('data-fold-active');
  });
  expect(await columnCount()).toBe('auto');
  expect(await overflowY('.ledger-upper')).toBe('auto');
  expect(await overflowY('.settings-upper')).not.toBe('auto');
  await expect(page.locator('.ledger-dashboard')).toHaveCSS('padding-bottom', '0px');
  await expect(page.locator('.ledger-upper')).toHaveCSS('padding-bottom', '0px');
  await expect(page.locator('.ledger-lower')).toHaveCSS('padding-bottom', '0px');
  const flatLedgerUpper = (await page.locator('.ledger-upper').boundingBox())!;
  const flatLedgerLower = (await page.locator('.ledger-lower').boundingBox())!;
  expect(flatLedgerUpper.x + flatLedgerUpper.width).toBeLessThanOrEqual(460);
  expect(flatLedgerLower.x).toBeGreaterThanOrEqual(491);
  const flatTop = flatLedgerUpper.y;

  await page.evaluate(() => {
    document.documentElement.dataset.foldPosture = 'half-open';
    document.documentElement.setAttribute('data-fold-active', '');
  });
  expect(await columnCount()).toBe('auto');
  for (const selector of ['.ledger-upper', '.ledger-lower', '.settings-upper', '.settings-lower']) {
    expect(await overflowY(selector)).toBe('auto');
  }
  const ledgerUpper = (await page.locator('.ledger-upper').boundingBox())!;
  const ledgerLower = (await page.locator('.ledger-lower').boundingBox())!;
  expect(ledgerUpper.x + ledgerUpper.width).toBeLessThanOrEqual(460);
  expect(ledgerLower.x).toBeGreaterThanOrEqual(491);
  expect(ledgerUpper.y).toBe(flatTop);
  await page.evaluate(() => { document.documentElement.style.setProperty('--status-h', '82px'); });
  expect((await page.locator('.ledger-upper').boundingBox())!.y).toBe(flatTop);
  const settingsUpper = (await page.locator('.settings-upper').boundingBox())!;
  const settingsLower = (await page.locator('.settings-lower').boundingBox())!;
  expect(settingsUpper.x + settingsUpper.width).toBeLessThanOrEqual(460);
  expect(settingsLower.x).toBeGreaterThanOrEqual(491);

  await page.locator('.ledger-upper').evaluate(el => { el.scrollTop = 500; });
  expect(await page.locator('.ledger-lower').evaluate(el => el.scrollTop)).toBe(0);
});

test('Ledger totals keep every value on one baseline when labels wrap', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 500 });
  await page.setContent(`<html class="native-app"><head>
    <link rel="stylesheet" href="${url}src/styles.css?direct">
    </head><body>
    <article class="profile-page ledger-dashboard">
      <section class="profile-headline">
        <div class="headline-primary"><span class="headline-value">97<span class="headline-unit">h 22m</span></span><span class="headline-label">Listened since May 2026</span></div>
        <dl class="headline-secondary">
          <div><dt>Books finished</dt><dd>17</dd></div>
          <div><dt>Current streak</dt><dd>14<span class="dd-unit">d</span></dd></div>
          <div><dt>Longest streak</dt><dd>14<span class="dd-unit">d</span></dd></div>
          <div><dt>Per active day</dt><dd>115<span class="dd-unit">m</span></dd></div>
        </dl>
      </section>
    </article>
    </body></html>`);

  const tops = await page.locator('.headline-secondary dd').evaluateAll(values => values.map(value => value.getBoundingClientRect().top));
  expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(1);
});

test('Software versions collapses to the phone layout inside a narrow Duo leaf', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 669 });
  await page.setContent(`<html class="native-app"><head>
    <link rel="stylesheet" href="${url}src/styles.css?direct">
    </head><body>
    <section class="admin-card admin-software-card" style="width:520px">
      <div class="admin-software-head">
        <div class="admin-software-copy"><h2>OperaLibre software</h2><p>Review installed versions and manage available updates in one place.</p></div>
        <div class="admin-software-actions"><button>Check for updates</button></div>
      </div>
      <div class="admin-software-versions">
        <article class="update-available"><div class="admin-software-version-head"><div><span>Server</span><strong>Current</strong></div><span class="admin-update-badge">0.4.3 available</span></div></article>
        <article><div class="admin-software-version-head"><div><span>Web frontend</span><strong>Development</strong></div></div></article>
      </div>
    </section>
    </body></html>`);

  const cards = await page.locator('.admin-software-versions > article').evaluateAll(items => items.map(item => {
    const rect = item.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width };
  }));
  expect(cards[1].y).toBeGreaterThan(cards[0].y);
  expect(cards[0].width).toBeGreaterThan(470);
  expect((await page.getByText('Server', { exact: true }).boundingBox())!.width).toBeGreaterThan(35);
});

test('half-open reader clears the horizontal hinge and keeps its transport on the lower half', async ({ page }) => {
  await page.setViewportSize({ width: 669, height: 951 });
  await page.goto(`${url}test/reader-catch-up.html?immersive`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  await expect(page.locator('.epub-stage iframe')).toHaveCount(1);
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, {
      posture: 'half-open', angle: 90,
      fold: { x: 0, y: 460, width: 669, height: 30, axis: 'horizontal', active: true }
    });
  });
  const stage = (await page.locator('.epub-stage').boundingBox())!;
  const transport = (await page.locator('.epub-audiobar').boundingBox())!;
  expect(stage.y + stage.height).toBeLessThanOrEqual(460);
  expect(transport.y).toBeGreaterThanOrEqual(490);
  expect(transport.y + transport.height).toBeLessThanOrEqual(951);
});

test('closed landscape reader docks listening controls beside the page', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 669 });
  await page.goto(`${url}test/reader-catch-up.html?immersive&narration`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, { posture: 'closed', angle: 0 });
  });

  const stage = (await page.locator('.epub-stage').boundingBox())!;
  const transport = (await page.locator('.epub-audiobar').boundingBox())!;
  const footer = (await page.locator('.epub-bottombar').boundingBox())!;
  expect(transport.x).toBeGreaterThanOrEqual(stage.x + stage.width);
  expect(transport.width).toBeLessThanOrEqual(64);
  expect(transport.height).toBeGreaterThan(300);
  const reclaimedCornerInset = 951 - (transport.x + transport.width);
  expect(reclaimedCornerInset).toBeGreaterThanOrEqual(8);
  expect(reclaimedCornerInset).toBeLessThanOrEqual(12);
  expect(footer.height).toBeLessThan(48);
});

test('the reader remembers a different text size for the closed screen than the open one', async ({ page }) => {
  await page.goto(`${url}test/reader-catch-up.html`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  const size = page.locator('.epub-font-controls span');
  const grow = page.getByRole('button', { name: 'Increase reader text size' });
  const setPosture = (state: DeviceFoldState) => page.evaluate(async state => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, state);
  }, state);

  await expect(size).toHaveText(/100%/);
  await grow.click();
  await expect(size).toHaveText(/110%/);

  await setPosture({ posture: 'closed', angle: 0 });
  await expect(size).toHaveText(/100%/);
  await grow.click();
  await grow.click();
  await expect(size).toHaveText(/120%/);

  await setPosture({ posture: 'flat', angle: 180,
    fold: { x: 475, y: 0, width: 1, height: 669, axis: 'vertical', active: false } });
  await expect(size).toHaveText(/110%/);

  await setPosture({ posture: 'closed', angle: 0 });
  await expect(size).toHaveText(/120%/);
});

test('a sentence near the left of the reader seeks narration instead of turning back', async ({ page }) => {
  await page.setViewportSize({ width: 669, height: 951 });
  await page.goto(`${url}test/reader-catch-up.html?immersive&narration`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  const paragraph = page.frameLocator('.epub-stage iframe').locator('p').nth(1);
  await expect(paragraph).toBeVisible();
  const box = (await paragraph.boundingBox())!;
  const stage = (await page.locator('.epub-stage').boundingBox())!;
  const edge = Math.min(80, stage.width * 0.15);
  const x = box.x + edge + 10;
  expect(x - stage.x).toBeGreaterThan(edge);
  expect(x - stage.x).toBeLessThan(stage.width / 4);
  await page.mouse.click(x, box.y + 10);
  await expect(page.getByLabel('Narration position')).toHaveValue('20');
});

test('a tap in the wrapper padding at the right of the page turns forward instead of seeking hidden text', async ({ page }) => {
  await page.setViewportSize({ width: 951, height: 669 });
  await page.goto(`${url}test/reader-catch-up.html?immersive&narration`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  await expect(page.locator('.epub-stage iframe')).toHaveCount(1);
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 110,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } });
    // Browser fixtures have no iOS safe-area inset. Reproduce the open
    // device's stage-wrapper padding so the catcher is wider than the EPUB.
    const wrap = document.querySelector<HTMLElement>('.epub-stage-wrap')!;
    wrap.style.paddingInline = '84px';
  });
  const stage = (await page.locator('.epub-stage').boundingBox())!;
  const catcher = (await page.locator('.epub-tapzones').boundingBox())!;
  expect(catcher.x + catcher.width).toBeGreaterThan(stage.x + stage.width);
  const currentCfi = () => page.evaluate(() =>
    (window as any).__operalibreReader.rendition.currentLocation()?.start?.cfi as string | undefined);
  await expect.poll(currentCfi).toBeTruthy();
  const before = await currentCfi();
  await page.mouse.click(catcher.x + catcher.width - 4, catcher.y + catcher.height / 2);
  await expect.poll(currentCfi).not.toBe(before);
  await expect(page.getByLabel('Narration position')).toHaveValue('0');
  await expect(page.getByText(/Reading freely/)).toBeVisible();
});

test('reader survives folding, rotating, flattening and closing without replacing its book', async ({ page }) => {
  await page.goto(`${url}test/reader-catch-up.html?immersive`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  await expect(page.locator('.epub-stage iframe')).toHaveCount(1);
  const rendition = await page.evaluateHandle(() => (window as any).__operalibreReader.rendition);
  await expect.poll(() => rendition.evaluate(value => value.currentLocation()?.start?.href)).toContain('c1.xhtml');
  const states: Array<{ width: number; height: number; state: DeviceFoldState; spread: string }> = [
    { width: 951, height: 669, spread: 'always', state: { posture: 'half-open', angle: 90,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } } },
    { width: 669, height: 951, spread: 'none', state: { posture: 'half-open', angle: 90,
      fold: { x: 0, y: 460, width: 669, height: 31, axis: 'horizontal', active: true } } },
    { width: 951, height: 669, spread: 'always', state: { posture: 'half-open', angle: 110,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } } },
    { width: 951, height: 669, spread: 'none', state: { posture: 'flat', angle: 180,
      fold: { x: 475, y: 0, width: 1, height: 669, axis: 'vertical', active: false } } },
    { width: 466, height: 678, spread: 'none', state: { posture: 'closed', angle: 0 } }
  ];
  for (const { width, height, state, spread } of states) {
    await page.setViewportSize({ width, height });
    await page.evaluate(async state => {
      const modulePath = '/src/deviceFold.ts';
      const { applyDeviceFold } = await import(modulePath);
      applyDeviceFold(document.documentElement, state);
    }, state);
    await expect.poll(() => rendition.evaluate(value => value.settings.spread)).toBe(spread);
    expect(await rendition.evaluate(value => value === (window as any).__operalibreReader.rendition)).toBe(true);
    await expect.poll(() => rendition.evaluate(value => value.currentLocation()?.start?.href), { message: `${state.posture} ${state.fold?.axis}` }).toContain('c1.xhtml');
    await expect(page.locator('.epub-error')).toHaveCount(0);
  }
  await expect(page.locator('html')).not.toHaveAttribute('data-fold-axis');
  await expect(page.locator('html')).not.toHaveAttribute('data-fold-active');
});

test('fully opening the reader redraws the active follow-along highlight', async ({ page }) => {
  await page.setViewportSize({ width: 669, height: 951 });
  await page.goto(`${url}test/reader-catch-up.html?immersive&narration`);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 90,
      fold: { x: 0, y: 460, width: 669, height: 31, axis: 'horizontal', active: true } });
  });
  const drawnHighlights = () => page.evaluate(() =>
    document.querySelectorAll('.readalong-highlight').length
  );
  await expect.poll(drawnHighlights).toBeGreaterThan(0);

  await page.setViewportSize({ width: 951, height: 669 });
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, { posture: 'flat', angle: 180,
      fold: { x: 475, y: 0, width: 1, height: 669, axis: 'vertical', active: false } });
  });

  await expect.poll(drawnHighlights).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Stop following narration', exact: true })).toBeVisible();
});

test('portrait fold bounds the shelf, settings and administration to independent surfaces', async ({ page }) => {
  await page.setViewportSize({ width: 669, height: 951 });
  const books = library(30);
  books[0].tracks[0].title = 'Part Two: Our Calling: 30. The Betrayal';
  books[0].chapters = [{ id: 'chapter-1', title: books[0].tracks[0].title,
    trackId: books[0].tracks[0].id, trackIndex: 0, startSeconds: 0, endSeconds: 120, source: 'embedded' }];
  books[0].readingFile = { id: 'ebook', fileName: 'fixture.epub', extension: 'epub', contentType: 'application/epub+zip', url: '/fixture.epub' };
  await page.addInitScript(() => {
    localStorage.setItem('operalibre.readalong.enabled', 'true');
    localStorage.setItem('operalibre.games.enabled', 'true');
  });
  const user = { id: 'layout-owner', username: 'Layout owner', isAdmin: true, isOwner: true,
    canApproveLibationRequests: true, allowedBookIds: null, libationAccess: 'none',
    shareProgress: false, announceFinishes: false, notifyFinishes: false, createdAt: '1700000000' };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let body: unknown = [];
    if (path === '/api/auth/status') body = { setupRequired: false, user, mediaToken: 'fixture' };
    else if (path === '/api/auth/me') body = user;
    else if (path === '/api/books') body = books;
    else if (path === '/api/users') body = [user];
    else if (path === '/api/libation/status') body = { accounts: [], configured: false, available: false };
    else if (path === '/api/update') body = { currentVersion: '0.4.2', updateAvailable: false };
    else if (path === '/api/profile/stats') body = { totalHoursRead: 12, booksFinished: 2, totalTracksCompleted: 4,
      currentStreakDays: 1, longestStreakDays: 2, avgDailyMinutes: 20, lastListenedAt: null,
      favoriteNarrator: null, favoriteGenre: null, daysActive: 2, memberSince: '1700000000',
      streakCalendar: [], recentBooks: [], measuringSince: null };
    await route.fulfill({ json: body });
  });
  await page.goto(`${url}test/duo-shell.html`);
  await expect(page.locator('.book-row')).toHaveCount(30);
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 110,
      fold: { x: 0, y: 460, width: 669, height: 31, axis: 'horizontal', active: false } });
  });
  const checkPanes = async (upper: string, lower: string) => {
    const top = (await page.locator(upper).boundingBox())!;
    const bottom = (await page.locator(lower).boundingBox())!;
    expect(top.y).toBeGreaterThanOrEqual(0);
    expect(top.y + top.height).toBeLessThanOrEqual(460.5);
    expect(bottom.y).toBeGreaterThanOrEqual(490.5);
    expect(bottom.y + bottom.height).toBeLessThanOrEqual(951.5);
    for (const selector of [upper, lower]) {
      expect(await page.locator(selector).evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    }
  };
  // Just browsing, the library keeps the whole screen and the transport is
  // the floating mini-player — no player page forced onto the lower screen.
  const browsingLibrary = (await page.locator('.library-pane').boundingBox())!;
  expect(browsingLibrary.y).toBeLessThanOrEqual(0.5);
  expect(browsingLibrary.y + browsingLibrary.height).toBeGreaterThan(460.5);
  await expect(page.locator('.player-pane')).toBeHidden();

  await page.locator('.book-row').first().click();
  await checkPanes('.library-pane', '.player-pane');
  await expect(page.locator('.book-quick-play')).toBeVisible();
  const quickPlay = (await page.locator('.book-quick-play').boundingBox())!;
  const detailPane = (await page.locator('.player-pane').boundingBox())!;
  expect(quickPlay.y + quickPlay.height).toBeLessThanOrEqual(detailPane.y + detailPane.height);
  await expect(page.locator('.readalong-invite')).toBeVisible();
  expect(await page.locator('.readalong-invite').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '../../output/duo-shelf-portrait.png' });
  await page.getByRole('button', { name: `Play ${books[0].title}`, exact: true }).click();
  await expect(page.locator('.native-now-playing')).toBeVisible();
  for (const [width, height, axis] of [[951, 669, 'vertical'], [850, 600, 'vertical'], [669, 951, 'horizontal'], [466, 678, 'closed'], [844, 390, 'closed']] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(async ({ width, height, axis }) => {
      const modulePath = '/src/deviceFold.ts';
      const { applyDeviceFold } = await import(modulePath);
      applyDeviceFold(document.documentElement, axis === 'closed' ? { posture: 'closed', angle: 0 } : {
        posture: 'half-open', angle: 110,
        fold: axis === 'vertical'
          ? { x: (width - 31) / 2, y: 0, width: 31, height, axis, active: true }
          : { x: 0, y: 460, width, height: 31, axis, active: true }
      });
      document.documentElement.style.setProperty('--tabs-h', axis === 'vertical' ? '0px' : '80px');
    }, { width, height, axis });
    for (const tab of axis === 'closed' ? ['Reading'] : ['Reading', 'Shelf']) {
      // The fixture has HTML tabs instead of UIKit's side rail; zero bottom
      // inset intentionally hides them in landscape. Exercise their handlers.
      await page.locator('.spine-tab').filter({ hasText: tab }).dispatchEvent('click');
      // Shelf is a collection destination in either fold direction. Browsing
      // keeps the library full screen and the transport in the mini player;
      // Reading is the tab that owns the persistent player page.
      if (tab === 'Shelf' && axis !== 'closed') {
        await expect(page.locator('.player-pane')).toBeHidden();
        const library = (await page.locator('.library-pane').boundingBox())!;
        if (axis === 'horizontal') {
          await expect(page.locator('.mini-player')).toBeVisible();
          expect(library.height).toBeGreaterThan(height / 2);
        } else {
          expect(library.width).toBeGreaterThan(width - 2);
          for (const book of await page.locator('.book-row:visible').all()) {
            const box = (await book.boundingBox())!;
            const foldStart = (width - 31) / 2;
            expect(box.x + box.width <= foldStart || box.x >= foldStart + 31).toBe(true);
          }
        }
        await page.screenshot({ path: `../../output/playwright/duo-static-${width}-${tab}.png` });
        continue;
      }
      const pane = page.locator('.player-pane');
      await expect.poll(() => pane.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
      expect(await pane.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      const bounds = (await pane.boundingBox())!;
      for (const element of await page.locator('.native-now-playing button, .native-now-artwork, .native-now-copy, .native-now-timeline').all()) {
        const box = (await element.boundingBox())!;
        expect(box.y, `${axis} ${width} top`).toBeGreaterThanOrEqual(bounds.y);
        expect(box.y + box.height, `${axis} ${width} bottom`).toBeLessThanOrEqual(bounds.y + bounds.height - (axis === 'vertical' ? 0 : 80) + 1);
      }
      await expect(page.locator('.player-pane > .folio')).toBeHidden();
      await page.screenshot({ path: `../../output/playwright/duo-static-${width}-${tab}.png` });
    }
  }
  await page.setViewportSize({ width: 669, height: 951 });
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 110,
      fold: { x: 0, y: 460, width: 669, height: 31, axis: 'horizontal', active: false } });
  });
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  await checkPanes('.games-shell', '.match-board-frame');
  const gameSummary = (await page.locator('.games-switcher').boundingBox())!;
  const gamePlayer = (await page.locator('.mini-player').boundingBox())!;
  const gameBoard = (await page.locator('.match-board').boundingBox())!;
  expect(gameSummary.x + gameSummary.width).toBeLessThanOrEqual(334.5);
  expect(parseFloat(await page.locator('.games-shell').evaluate(el => getComputedStyle(el).borderRadius))).toBeGreaterThanOrEqual(20);
  await expect(page.locator('.ios-status-veil')).toBeHidden();
  expect(gamePlayer.x).toBeGreaterThanOrEqual(334.5);
  expect(gamePlayer.y + gamePlayer.height).toBeLessThanOrEqual(460.5);
  expect(gameBoard.y).toBeGreaterThanOrEqual(490.5);
  expect(gameBoard.width).toBeGreaterThan(320);
  expect(await page.locator('.match-piece').first().evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
  await page.screenshot({ path: '../../output/duo-games-portrait.png' });
  await page.getByRole('tab', { name: 'Word Grid', exact: true }).click();
  await checkPanes('.games-shell', '.word-keys');
  const wordBoard = (await page.locator('.word-board').boundingBox())!;
  const wordShell = (await page.locator('.games-shell').boundingBox())!;
  expect(wordBoard.y).toBeGreaterThanOrEqual(wordShell.y);
  expect(wordBoard.y + wordBoard.height).toBeLessThanOrEqual(wordShell.y + wordShell.height + 1);
  expect((await page.locator('.word-key').first().boundingBox())!.height).toBeGreaterThanOrEqual(50);
  expect(parseFloat(await page.locator('.word-tile').first().evaluate(el => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(15);
  await page.screenshot({ path: '../../output/duo-word-grid-portrait.png' });
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();
  await expect(page.locator('.ledger-upper')).toBeVisible();
  await checkPanes('.ledger-upper', '.ledger-lower');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await checkPanes('.settings-upper', '.settings-lower');
  await page.screenshot({ path: '../../output/duo-settings-portrait.png' });
  await page.getByRole('button', { name: 'Administration', exact: true }).click();
  await checkPanes('.admin-navigation', '.admin-content');
  await page.getByRole('button', { name: 'Users & access', exact: true }).click();
  await checkPanes('.admin-navigation', '.admin-content');
  await page.screenshot({ path: '../../output/duo-admin-portrait.png' });
  await page.setViewportSize({ width: 951, height: 669 });
  await page.evaluate(async () => {
    const modulePath = '/src/deviceFold.ts';
    const { applyDeviceFold } = await import(modulePath);
    applyDeviceFold(document.documentElement, { posture: 'half-open', angle: 90,
      fold: { x: 460, y: 0, width: 31, height: 669, axis: 'vertical', active: true } });
  });
  await page.waitForFunction(() => !document.documentElement.dataset.foldTransition);
  const left = (await page.locator('.admin-navigation').boundingBox())!;
  const right = (await page.locator('.admin-content').boundingBox())!;
  expect(left.x + left.width).toBeLessThanOrEqual(460);
  expect(right.x).toBeGreaterThanOrEqual(491);
  expect(right.x).toBeLessThanOrEqual(492);
  expect(right.width).toBeGreaterThan(450);
  expect(await page.locator('.admin-content').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '../../output/duo-admin-landscape.png' });
  await page.getByRole('button', { name: 'Shelf', exact: true }).click();
  await page.locator('.book-row').first().click();
  await expect(page.locator('.readalong-invite')).toBeVisible();
  expect(await page.locator('.readalong-invite').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect(page.getByRole('button', { name: 'Back to Library', exact: true })).toBeVisible();
  await page.screenshot({ path: '../../output/duo-shelf-landscape.png' });
  await page.getByRole('button', { name: 'Back to Library', exact: true }).click();
  await expect(page.locator('.player-pane')).toBeHidden();
  expect((await page.locator('.library-pane').boundingBox())!.width).toBeGreaterThan(900);
  await page.getByRole('button', { name: 'Games', exact: true }).click();
  expect(await page.locator('.match-piece').first().evaluate(el => getComputedStyle(el).fontSize)).toBe('16px');
});
