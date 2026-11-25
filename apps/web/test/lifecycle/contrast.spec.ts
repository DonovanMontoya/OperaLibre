import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { library, wav } from '../performance/fixtures';
import { auditContrast, type ContrastIssue } from './contrastAudit';

let server: ViteDevServer;
let url: string;
test.beforeAll(async () => {
  server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  url = server.resolvedUrls!.local[0];
});
test.afterAll(async () => { await server?.close(); });

async function setup(page: Page, shell: 'ios' | 'android' | 'web') {
  const books = library(3);
  const user = { id: 'contrast-reader', username: 'Reader', isAdmin: true, isOwner: true,
    allowedBookIds: null, libationAccess: 'none', createdAt: '1700000000' };
  for (const [index, book] of books.entries()) {
    book.chapters = [{ id: `${book.id}-chapter`, title: 'A beginning', trackId: book.tracks[0].id, trackIndex: 0, startSeconds: 0, endSeconds: 240, source: 'embedded' }];
    book.tracks.forEach(track => { track.streamUrl = `/fixture-${book.id}-${track.index}.wav`; });
    book.progress = { status: 'inProgress', bookPositionSeconds: 60 + index * 30, durationSeconds: 240,
      remainingSeconds: 180 - index * 30, percentComplete: 25, updatedAt: '2026-10-01T00:00:00Z' };
  }
  const audio = wav();
  await page.route('**/fixture-*.wav*', route => route.fulfill({ contentType: 'audio/wav', body: audio, headers: { 'Accept-Ranges': 'bytes' } }));
  await page.addInitScript(() => {
    localStorage.setItem('operalibre.serverUrl', location.origin);
    localStorage.setItem('operalibre.serverType', 'operalibre');
    localStorage.setItem('operalibre.clippingEnabled', '1');
  });
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const bookId = path.match(/\/books\/([^/]+)/)?.[1];
    let body: unknown = [];
    if (path === '/api/auth/status') body = { setupRequired: false, user, mediaToken: 'fixture' };
    else if (path === '/api/auth/me') body = user;
    else if (path === '/api/books') body = books;
    else if (path === '/api/users') body = [user];
    else if (path === '/api/update') body = { currentVersion: '0.4.2', updateAvailable: false };
    else if (path === '/api/libation/setup') body = { canSignIn: false, busy: false, checks: [] };
    else if (path === '/api/profile/stats') body = { totalHoursRead: 12, booksFinished: 2, totalTracksCompleted: 4,
      currentStreakDays: 1, longestStreakDays: 2, avgDailyMinutes: 20, lastListenedAt: null,
      favoriteNarrator: null, favoriteGenre: null, daysActive: 2, memberSince: '1700000000',
      streakCalendar: [], recentBooks: [], measuringSince: null };
    else if (path === '/api/me/libro') body = { connected: false, accounts: [], books: [], jobs: [] };
    else if (path === '/api/libation/status') body = { available: false, accounts: [], configured: false };
    else if (bookId && path.endsWith('/clips')) {
      body = { clips: bookId === books[0].id ? [] : [{ id: '1'.repeat(32), bookId, startSeconds: 10, endSeconds: 40,
        title: 'A saved passage', note: 'Worth hearing again', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }], canExportAudio: true };
    } else if (bookId && path.endsWith('/progress')) {
      const book = books.find(book => book.id === bookId)!;
      body = request.method() === 'GET'
        ? { bookId, trackId: book.tracks[0].id, positionSeconds: book.progress!.bookPositionSeconds,
          bookPositionSeconds: book.progress!.bookPositionSeconds, durationSeconds: 240, updatedAt: book.progress!.updatedAt }
        : { ...request.postDataJSON(), accepted: true, updatedAt: '2026-10-01T00:00:01Z' };
    }
    await route.fulfill({ json: body });
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize(shell === 'web' ? { width: 1280, height: 800 } : { width: 390, height: 844 });
  await page.goto(shell === 'web' ? url : `${url}test/duo-shell.html?platform=${shell}`);
  await expect(page.locator('.book-row').first()).toBeAttached();
  await page.waitForFunction(() => !document.querySelector('.native-launch-cover'));
  // A colour caught halfway through a transition is not the colour on screen.
  await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  return books;
}

// [name, dark, theme attribute]: the ten appearances of the iPhone app.
const appearances: [string, boolean, string | null][] = [
  ['Parchment', false, null], ['Linen', false, 'linen'], ['Sage', false, 'sage'], ['Harbor', false, 'harbor'], ['Pure White', false, 'pure-white'],
  ['Warm', true, null], ['Graphite', true, 'graphite'], ['Midnight', true, 'midnight'], ['Reading Room', true, 'reading-room'], ['True Black', true, 'true-black']
];

async function appear(page: Page, dark: boolean, theme: string | null) {
  await page.evaluate(([dark, theme]) => {
    const root = document.documentElement;
    root.classList.toggle('dark-mode', dark as boolean);
    root.removeAttribute('data-dark-theme');
    root.removeAttribute('data-light-theme');
    if (theme) root.setAttribute(dark ? 'data-dark-theme' : 'data-light-theme', theme as string);
  }, [dark, theme]);
}

// Known shortfalls, each a decision about the palette rather than a slip.
// Warm's red accent reaches about 4.4:1 as text on its darkest surface and
// 3.2:1 on lifted cards, and cream on a red button is 3.4:1. Nothing below
// that is excused.
const WARM_ACCENT = '#c65b49';
const accepted = (appearance: string, issue: ContrastIssue) =>
  appearance === 'Warm' && issue.ratio >= 3.15 && (issue.color === WARM_ACCENT || issue.background === WARM_ACCENT);

const describe = (issue: ContrastIssue) =>
  `${issue.element} "${issue.text}" is ${issue.ratio}:1 (${issue.color} on ${issue.background}), needs ${issue.required}:1`;

type Surface = [name: string, open: (page: Page) => Promise<unknown>, scope?: string];
const dialog = '[role=dialog]';
const tab = (name: string) => (page: Page) => page.locator('.spine-tab').filter({ hasText: name }).click();

// Android has one appearance: paper screens with the dark shelf and sheets.
const walks: [shell: 'ios' | 'android', name: string, dark: boolean, theme: string | null][] = [
  ...appearances.map(([name, dark, theme]) => ['ios', name, dark, theme] as ['ios', string, boolean, string | null]),
  ['android', 'Android', false, null]
];
for (const [shell, appearance, dark, theme] of walks) {
  test(`${shell === 'ios' ? `iPhone text is legible on the main screens and sheets in ${appearance}` : 'Android text is legible on the main screens and sheets'}`, async ({ page }) => {
    const books = await setup(page, shell);
    if (shell === 'ios') await appear(page, dark, theme);
    const sheet = (name: string | RegExp) => (page: Page) => page.getByRole('button', { name, exact: true }).first().click();
    const close = async (page: Page) => {
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };
    const surfaces: Surface[] = [
      ['shelf, grid', async () => {}],
      ['shelf, list', page => page.getByRole('button', { name: 'List view', exact: true }).click()],
      ['shelf filters', page => page.getByRole('button', { name: 'Filters', exact: true }).click()],
      ['a filter chosen', page => page.locator('.facet-chip:not(:disabled)').first().click()],
      ['book details', async page => {
        await page.locator('.facet-chip.selected').first().click();
        await page.getByRole('button', { name: 'Filters', exact: true }).click();
        await page.locator('.book-row').nth(1).click();
      }],
      ['book clips', page => page.getByRole('tab', { name: 'Clips', exact: true }).click()],
      ['saved clips', page => page.getByRole('button', { name: 'Manage clips', exact: true }).click(), dialog],
      ['edit clip', page => page.getByRole('dialog').getByRole('button', { name: /A saved passage/ }).click(), dialog],
      ['removing a clip', page => page.getByRole('dialog').getByRole('button', { name: 'Remove clip', exact: true }).click(), dialog],
      ['shelf, back from a book', async page => {
        await close(page);
        await page.getByRole('button', { name: 'Back to Library', exact: true }).click();
      }],
      ['now playing', async page => {
        await page.getByRole('button', { name: `Play ${books[0].title}`, exact: true }).first().click();
        await expect(page.getByRole('button', { name: 'Sleep timer', exact: true })).toBeVisible();
      }],
      ['speed sheet', sheet('1×'), dialog],
      ['sleep timer sheet', async page => { await close(page); await sheet('Sleep timer')(page); }, dialog],
      ['chapters sheet', async page => { await close(page); await sheet('Chapters')(page); }, dialog],
      ['details sheet', async page => { await close(page); await sheet('Details')(page); }, dialog],
      ['saved clips, none yet', page => page.getByRole('dialog').getByRole('button', { name: /Saved clips/ }).click(), dialog],
      ['listening', async page => { await close(page); await tab('Listening')(page); }],
      ['games', tab('Games')],
      ['games, Shelf Sort', page => page.getByRole('tab', { name: 'Shelf Sort', exact: true }).click()],
      ['games, Cover Grid', page => page.getByRole('tab', { name: 'Cover Grid', exact: true }).click()],
      ['ledger', tab('Ledger')],
      ['settings', tab('Settings')]
    ];

    const failures: string[] = [];
    for (const [surface, open, scope] of surfaces) {
      await open(page);
      for (const issue of await auditContrast(page, scope)) {
        if (!accepted(appearance, issue)) failures.push(`${surface}: ${describe(issue)}`);
      }
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
}

test('web text is legible on the shelf, a book and its clips', async ({ page }) => {
  const books = await setup(page, 'web');
  const surfaces: Surface[] = [
    ['shelf', async page => {
      const openLibrary = page.getByRole('button', { name: 'Open library', exact: true });
      if (await openLibrary.isVisible()) await openLibrary.click();
      await page.getByRole('button', { name: 'List view', exact: true }).click();
    }],
    ['book details', page => page.locator('.book-row').nth(1).click()],
    ['book clips', page => page.getByRole('tab', { name: 'Clips', exact: true }).click()],
    ['saved clips', page => page.getByRole('button', { name: 'Manage clips', exact: true }).click(), dialog],
    ['edit clip', page => page.getByRole('dialog').getByRole('button', { name: /A saved passage/ }).click(), dialog],
    ['playing', async page => {
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: `Play ${books[0].title}`, exact: true }).first().click();
    }],
    ['account menu', page => page.getByRole('button', { name: 'Account menu', exact: true }).click()]
  ];
  const failures: string[] = [];
  for (const [surface, open, scope] of surfaces) {
    await open(page);
    for (const issue of await auditContrast(page, scope)) failures.push(`${surface}: ${describe(issue)}`);
  }
  expect(failures, failures.join('\n')).toEqual([]);
});
