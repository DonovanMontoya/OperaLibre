import type { Page } from '@playwright/test';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect, type AppServer } from './server';
import { auditLayout, type LayoutIssue } from './layoutAudit';

// Every web screen at phone, tablet, laptop, and desktop sizes in both
// orientations. A layout that works at the size it was tuned for can still
// collide where a pane is narrower than the window suggests (the library
// column beside the player, a drawer, a dialog), so each screen is audited at
// all of them. Screens that do not exist at a size (the expanded shelf on a
// phone) are skipped by `when`.
const viewports = [
  { name: 'phone portrait', width: 390, height: 844 },
  { name: 'phone landscape', width: 844, height: 390 },
  { name: 'tablet portrait', width: 768, height: 1024 },
  { name: 'tablet landscape', width: 1024, height: 768 },
  { name: 'narrow desktop', width: 980, height: 1000 },
  { name: 'laptop', width: 1280, height: 800 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'wide desktop', width: 1920, height: 1080 },
  { name: 'ultrawide', width: 2560, height: 1080 }
];

const longTitle = 'The Remarkably Long Title of a Book That Keeps Going Well Past Any Sensible Length';

async function visible(page: Page, name: string | RegExp) {
  return page.getByRole('button', { name, exact: typeof name === 'string' }).first().isVisible();
}

async function press(page: Page, name: string | RegExp) {
  await page.getByRole('button', { name, exact: typeof name === 'string' }).first().click();
}

async function openLibrary(page: Page) {
  if (await visible(page, 'Open library')) {
    await press(page, 'Open library');
    await expect(page.locator('.library-pane')).toHaveClass(/\bopen\b/);
  }
}

// Opening a book closes the drawer by itself; only close one still open.
async function closeLibrary(page: Page) {
  const open = page.locator('.library-pane.open');
  if (!(await expect(open).toHaveCount(0, { timeout: 1000 }).then(() => true, () => false))) {
    await page.locator('.library-scrim').click({ position: { x: 5, y: 5 } });
    await expect(open).toHaveCount(0);
  }
}

async function openBook(page: Page, title: string) {
  await openLibrary(page);
  await page.locator('.book-row').filter({ hasText: title }).first().click();
  // The playing book opens on Now Playing rather than its title page.
  const titlePage = page.locator('.book-page-title, .player-pane h2').filter({ hasText: title }).first();
  await expect(titlePage.or(page.locator('.native-now-playing')).first()).toBeVisible();
  await closeLibrary(page);
}

async function nowPlaying(page: Page) {
  await openBook(page, 'First Book');
  // A book already loaded opens on Now Playing; otherwise its title page.
  const player = page.locator('.native-now-playing');
  await (await player.isVisible() ? player.locator('.native-now-play') : page.locator('.book-quick-play')).click();
  await expect.poll(() => page.locator('audio').evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBeGreaterThan(0);
  if (await visible(page, 'Player')) await press(page, 'Player');
  if (await visible(page, /Back to Now Playing/)) await press(page, /Back to Now Playing/);
  await expect(page.locator('.native-now-playing')).toBeVisible();
}

async function sheet(page: Page, label: RegExp) {
  await nowPlaying(page);
  await page.locator('.native-now-utility button').filter({ hasText: label }).first().click();
  await expect(page.locator('.sleep-sheet, .details-sheet, [role="dialog"]').first()).toBeVisible();
}

async function accountMenu(page: Page, item?: RegExp) {
  await openLibrary(page);
  await press(page, 'Account menu');
  if (item) await page.getByRole('menuitem', { name: item }).click();
}

async function admin(page: Page, section?: RegExp) {
  await accountMenu(page, /^Administration/);
  if (section) await page.getByRole('navigation', { name: 'Admin sections' }).getByRole('button', { name: section }).click();
  await expect(page.locator('.admin-shell, [class*="admin"]').first()).toBeVisible();
}

// A book action, from the labelled row or the compact More menu.
async function bookAction(page: Page, title: string, label: RegExp) {
  await openBook(page, title);
  if (await visible(page, 'More book actions')) await press(page, 'More book actions');
  await page.getByRole('button', { name: label }).or(page.getByRole('menuitem', { name: label })).first().click();
  await expect(page.locator('[role="dialog"], .modal-card').first()).toBeVisible();
}

type Screen = { name: string; when?: (page: Page) => Promise<boolean>; open: (page: Page) => Promise<void> };

const screens: Screen[] = [
  { name: 'home', open: async () => {} },
  { name: 'library list', open: openLibrary },
  { name: 'library compact', open: async page => { await openLibrary(page); await press(page, 'Compact view'); } },
  { name: 'library grid', open: async page => { await openLibrary(page); await press(page, 'Grid view'); } },
  { name: 'library filters', open: async page => { await openLibrary(page); await press(page, 'Filters'); } },
  {
    name: 'search with no results',
    open: async page => {
      await openLibrary(page);
      await page.getByRole('searchbox', { name: 'Search library' }).fill('no book has this title');
      await expect(page.getByText(/Nothing matches/)).toBeVisible();
    }
  },
  { name: 'shared reading', open: async page => { await openLibrary(page); await press(page, 'Shared reading'); } },
  { name: 'upload dialog', open: async page => { await openLibrary(page); await press(page, 'Upload audiobook'); } },
  { name: 'account menu', open: page => accountMenu(page) },
  { name: 'book details', open: page => openBook(page, longTitle) },
  {
    name: 'book actions menu',
    when: async page => { await openBook(page, longTitle); return visible(page, 'More book actions'); },
    open: page => press(page, 'More book actions')
  },
  { name: 'edit info dialog', open: page => bookAction(page, longTitle, /^Edit info/) },
  { name: 'add EPUB dialog', open: page => bookAction(page, longTitle, /^Add matching EPUB/) },
  { name: 'now playing', open: nowPlaying },
  { name: 'playing book details', open: async page => { await nowPlaying(page); await openBook(page, 'First Book'); } },
  { name: 'speed sheet', open: page => sheet(page, /×/) },
  { name: 'sleep timer sheet', open: page => sheet(page, /Sleep/) },
  { name: 'details sheet', open: page => sheet(page, /Details/) },
  { name: 'chapters sheet', open: page => sheet(page, /Chapters/) },
  {
    name: 'expanded shelf',
    when: async page => { await openLibrary(page); return visible(page, 'Expand shelf'); },
    open: page => press(page, 'Expand shelf')
  },
  { name: 'mark unplayed confirmation', open: page => bookAction(page, 'Second Book', /unplayed/i) },
  { name: 'get books', open: async page => { await openLibrary(page); await press(page, 'Get books'); } },
  { name: 'reader\'s ledger', open: page => accountMenu(page, /Reader.s ledger/) },
  { name: 'administration', open: page => admin(page) },
  { name: 'administration users', open: page => admin(page, /Users/) },
  { name: 'administration downloaded books', open: page => admin(page, /Downloaded/) },
  { name: 'administration experiments', open: page => admin(page, /Experiments/) }
];

async function signIn(page: Page, server: AppServer) {
  // Long titles and names are what overflow first; the fixture's own books
  // are short.
  const source = join(server.directory, 'library', 'First Book');
  for (const title of [longTitle, 'Ündërstated Ñames, Diacritics & Punctuation: A Subtitle That Wraps']) {
    const folder = join(server.directory, 'library', title);
    await mkdir(folder, { recursive: true });
    for (const file of await readdir(source)) await copyFile(join(source, file), join(folder, file));
  }
  await page.goto(server.url);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('owner');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password-123');
  await page.getByLabel('Confirm password', { exact: true }).fill('fixture-password-123');
  const setup = page.waitForResponse(response => response.url().endsWith('/api/auth/setup') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create owner', exact: true }).click();
  server.token = (await (await setup).json()).token;
  await page.getByRole('button', { name: 'Rescan library', exact: true }).click();
  await expect(page.locator('.book-row')).toHaveCount(4, { timeout: 30_000 });
  // A book partway through, but not the one Now Playing loads, so its title
  // page offers Mark unplayed.
  const second = (await server.books()).find(book => book.title === 'Second Book')!;
  await server.json(`/api/books/${second.id}/progress`, 'PUT', {
    trackId: second.tracks[1].id, positionSeconds: 70, bookPositionSeconds: 250,
    durationSeconds: 180, intentionalSeek: true
  });
}

for (const viewport of viewports) {
  test(`web screens lay out without collisions at ${viewport.name} (${viewport.width}×${viewport.height})`, async ({ page, server }, testInfo) => {
    test.setTimeout(5 * 60_000);
    // A control that never becomes clickable should fail its screen, not
    // hold the whole run until the test timeout.
    page.setDefaultTimeout(10_000);
    await signIn(page, server);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    const failures: string[] = [];
    for (const screen of screens) {
      await test.step(screen.name, async () => {
        // Densities and the expanded shelf persist; start every screen from
        // the default list.
        await page.evaluate(() => {
          localStorage.removeItem('operalibre.viewMode');
          localStorage.removeItem('operalibre.shelfExpanded');
        });
        await page.goto(server.url);
        await expect(page.getByText(/\d+ of \d+ books/)).toBeVisible();
        if (screen.when && !(await screen.when(page))) return;
        await screen.open(page);
        // Let entrance transitions settle so boxes are measured where they land.
        await page.evaluate(() => Promise.all(document.getAnimations()
          .filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime ?? Infinity))
          .map(animation => animation.finished.catch(() => undefined))));
        const issues: LayoutIssue[] = await auditLayout(page);
        await page.evaluate(() => document.querySelectorAll('audio').forEach(audio => audio.pause()));
        if (!issues.length) return;
        await page.screenshot({ path: testInfo.outputPath(`${screen.name.replace(/[^a-z0-9]+/gi, '-')}.png`) });
        failures.push(`${screen.name}:\n${issues.map(issue => `  ${issue.kind}: ${issue.detail}`).join('\n')}`);
      });
    }
    if (failures.length) await writeFile(testInfo.outputPath('issues.txt'), failures.join('\n\n'));
    expect(failures, failures.join('\n\n')).toEqual([]);
  });
}
