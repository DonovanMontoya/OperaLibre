import { test, expect, type Page } from '@playwright/test';

async function rejectSync(page: Page, bookId: string, previous: string | null, rollbackFailure = false, concurrentEdit = false) {
  await page.evaluate(async ({ bookId, previous, rollbackFailure, concurrentEdit }) => {
    const base = `/api/books/${bookId}/sync`;
    await fetch(`${base}/language`, { method: 'PUT', body: JSON.stringify({ language: previous }) });
    const realFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith(`${base}/generate`)) {
        if (concurrentEdit) await realFetch(`${base}/language`, { method: 'PUT', body: JSON.stringify({ language: 'de' }) });
        return new Response(JSON.stringify({ message: 'Sync generation is paused for a server update.' }), {
          status: 409, headers: { 'Content-Type': 'application/json' }
        });
      }
      if (rollbackFailure && url.endsWith(`${base}/language`) && JSON.parse(String(init?.body)).expectedLanguage) {
        return new Response(JSON.stringify({ message: 'Could not save the language.' }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        });
      }
      return realFetch(input, init);
    };
  }, { bookId, previous, rollbackFailure, concurrentEdit });
}

async function savedLanguage(page: Page, bookId: string) {
  return page.evaluate(async (bookId) => (await (await fetch(`/api/books/${bookId}/sync/report`)).json()).languageOverride, bookId);
}

for (const previous of [null, 'fr']) {
  test(`a rejected whole-book language sync restores ${previous ?? 'the EPUB language'}`, async ({ page }) => {
    await page.goto('http://127.0.0.1:5187/test/sync-monitor.html');
    await rejectSync(page, 'book-8', previous);
    const jobs = page.locator('.admin-sync-jobs');
    const count = await jobs.locator('.admin-sync-job').count();
    await jobs.getByRole('button', { name: 'Re-sync as English', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Sync generation is paused for a server update.' })).toBeVisible();
    expect(await savedLanguage(page, 'book-8')).toBe(previous);
    await expect(jobs.locator('.admin-sync-job')).toHaveCount(count);
  });

  test(`a rejected chapter language sync restores ${previous ?? 'the EPUB language'} and refreshes the report`, async ({ page }) => {
    await page.goto('http://127.0.0.1:5187/test/sync-monitor.html');
    await rejectSync(page, 'book-6', previous);
    await page.getByRole('button', { name: /chapter grades for The Left Hand of Darkness/ }).click();
    const report = page.locator('.admin-sync-chapters');
    await report.getByRole('button', { name: 'Re-sync as English', exact: true }).click();
    await expect(report.getByRole('alert')).toHaveText('Sync generation is paused for a server update.');
    expect(await savedLanguage(page, 'book-6')).toBe(previous);
    if (previous) await expect(report.getByText(/Narration is recognized as French/)).toBeVisible();
    else await expect(report.getByRole('button', { name: 'Use the EPUB’s language', exact: true })).toHaveCount(0);
  });
}

test('a failed rollback explains the saved setting and refreshes the report', async ({ page }) => {
  await page.goto('http://127.0.0.1:5187/test/sync-monitor.html');
  await rejectSync(page, 'book-6', 'fr', true);
  await page.getByRole('button', { name: /chapter grades for The Left Hand of Darkness/ }).click();
  const report = page.locator('.admin-sync-chapters');
  await report.getByRole('button', { name: 'Re-sync as English', exact: true }).click();
  await expect(report.getByRole('alert')).toContainText('The language could not be restored.');
  expect(await savedLanguage(page, 'book-6')).toBe('en');
  await expect(report.getByText(/Narration is recognized as English/)).toBeVisible();
});

test('a rollback preserves a later administrator language edit', async ({ page }) => {
  await page.goto('http://127.0.0.1:5187/test/sync-monitor.html');
  await rejectSync(page, 'book-6', 'fr', false, true);
  await page.getByRole('button', { name: /chapter grades for The Left Hand of Darkness/ }).click();
  const report = page.locator('.admin-sync-chapters');
  await report.getByRole('button', { name: 'Re-sync as English', exact: true }).click();
  await expect(report.getByRole('alert')).toContainText('The language could not be restored.');
  expect(await savedLanguage(page, 'book-6')).toBe('de');
  await expect(report.getByText(/Narration is recognized as German/)).toBeVisible();
});

test('an accepted language sync keeps its override and queues the selected chapters', async ({ page }) => {
  await page.goto('http://127.0.0.1:5187/test/sync-monitor.html');
  await page.getByRole('button', { name: /chapter grades for The Left Hand of Darkness/ }).click();
  const report = page.locator('.admin-sync-chapters');
  await report.getByRole('button', { name: 'Re-sync as English', exact: true }).click();
  await expect(report.getByRole('status')).toHaveText('Re-syncing as English.');
  expect(await savedLanguage(page, 'book-6')).toBe('en');
  await expect(report.getByText(/Narration is recognized as English/)).toBeVisible();
  const jobs = await page.evaluate(async () => (await (await fetch('/api/jobs?kind=sync-generate')).json()));
  expect(jobs.find((job: { targetId: string }) => job.targetId === 'book-6').chapters.map((chapter: { index: number }) => chapter.index)).toEqual(Array.from({ length: 13 }, (_, index) => index + 1));
});
