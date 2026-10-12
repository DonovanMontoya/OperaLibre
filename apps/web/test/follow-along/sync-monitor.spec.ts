import { test, expect } from '@playwright/test';

for (const width of [390, 1280]) {
  test(`finished sync results can be dismissed without hiding books at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('http://127.0.0.1:5187/test/sync-monitor.html');
    const jobs = page.locator('.admin-sync-jobs');
    await expect(jobs.locator('.admin-sync-job')).toHaveCount(9);
    await expect(jobs.getByRole('button', { name: 'Dismiss sync result for Middlemarch', exact: true })).toHaveCount(0);
    const attention = page.locator('.admin-sync-book-group').filter({ has: page.getByText('Needs attention', { exact: true }) });
    await expect(attention.getByRole('button', { name: 'The Sound and the Fury', exact: true })).toBeVisible();
    await jobs.getByRole('button', { name: 'Dismiss sync result for The Sound and the Fury', exact: true }).click();
    await expect(jobs.locator('.admin-sync-job')).toHaveCount(8);
    await expect(attention.getByRole('button', { name: 'The Sound and the Fury', exact: true })).toBeVisible();
    await attention.getByRole('button', { name: /chapter grades for The Sound and the Fury/ }).click();
    await expect(attention.getByText('The speech recognizer crashed.', { exact: true })).toBeVisible();
    await expect(attention.getByRole('checkbox', { name: 'Re-run Chapter 9', exact: true })).toBeVisible();
    // A failed first sync stays in the books waiting for their first map.
    await jobs.getByRole('button', { name: 'Dismiss sync result for Bleak House', exact: true }).click();
    await expect(jobs.locator('.admin-sync-job')).toHaveCount(7);
    const ready = page.locator('.admin-sync-book-group').filter({ has: page.getByText('Ready to optimize', { exact: true }) });
    await expect(ready.getByRole('button', { name: 'Bleak House', exact: true })).toBeVisible();
    await expect(ready.getByRole('button', { name: 'Dismiss scheduled sync result for Bleak House', exact: true })).toHaveCount(0);
    await expect(ready.getByText('Scheduled sync failed. See sync activity, then retry.', { exact: true })).toHaveCount(0);
    await jobs.getByRole('button', { name: 'Dismiss sync result for The Master and Margarita', exact: true }).click();
    await expect(jobs.locator('.admin-sync-job')).toHaveCount(6);
    await expect(ready.getByRole('button', { name: 'The Master and Margarita', exact: true })).toBeVisible();
  });
}

test('a failed dismissal keeps its result and explains the error', async ({ page }) => {
  await page.goto('http://127.0.0.1:5187/test/sync-monitor.html');
  const jobs = page.locator('.admin-sync-jobs');
  await expect(jobs.locator('.admin-sync-job')).toHaveCount(9);
  await page.evaluate(() => {
    const fetch = window.fetch;
    window.fetch = (input, init) => init?.method === 'DELETE'
      ? Promise.resolve(new Response(JSON.stringify({ message: 'Could not save sync history.' }), {
        status: 500, headers: { 'Content-Type': 'application/json' }
      }))
      : fetch(input, init);
  });
  await jobs.getByRole('button', { name: 'Dismiss sync result for Bleak House', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Could not save sync history.' })).toBeVisible();
  await expect(jobs.locator('.admin-sync-job')).toHaveCount(9);
});

test('a scheduled-start failure can be dismissed while its book still needs attention', async ({ page }) => {
  await page.goto('http://127.0.0.1:5187/test/sync-monitor.html');
  const attention = page.locator('.admin-sync-book-group').filter({ has: page.getByText('Needs attention', { exact: true }) });
  await expect(attention.getByText('Follow along was disabled before the scheduled start.', { exact: true })).toBeVisible();
  await attention.getByRole('button', { name: 'Dismiss scheduled sync result for Stoner', exact: true }).click();
  await expect(attention.getByText('Follow along was disabled before the scheduled start.', { exact: true })).toHaveCount(0);
  await expect(attention.getByRole('button', { name: 'Stoner', exact: true })).toBeVisible();
});
