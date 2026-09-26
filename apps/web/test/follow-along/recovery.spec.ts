import { test, expect, type Page } from '@playwright/test';
import type { FixtureControls } from './reader';

type TestReader = { rendition: {
  currentLocation(): { start: { cfi: string; href: string } };
  annotations: { _annotations: Record<string, { cfiRange: string }> };
  getContents(): Array<{ range(cfi: string): Range }>;
} };
declare global { interface Window { followFixture: FixtureControls } }
async function state(page: Page) {
  return page.evaluate(() => {
    const r = (window as unknown as { __operalibreReader?: TestReader }).__operalibreReader?.rendition;
    if (!r) return { cfi: '', href: '', count: 0, text: '' };
    let location;
    try { location = r.currentLocation()?.start; } catch { return { cfi: '', href: '', count: 0, text: '' }; }
    const annotations = Object.values(r.annotations._annotations);
    return { ...location, count: annotations.length,
      text: annotations.length ? r.getContents()[0]?.range(annotations[0].cfiRange).toString() : '' };
  });
}
async function seek(page: Page, time: number) { await page.evaluate(t => window.followFixture.setPosition(t), time); }
async function open(page: Page, recovery = true) {
  await page.goto(`http://127.0.0.1:5187/test/follow-along/reader.html${recovery ? '?recovery' : ''}`);
  await expect(page.locator('.epub-stage iframe')).toHaveCount(1);
  await expect(page.locator('.epub-loading')).toHaveCount(0);
  await expect.poll(async () => (await state(page)).count).toBe(1);
}
async function matched(page: Page, needle: string) {
  await expect.poll(async () => (await state(page)).text).toContain(needle);
  await expect(page.locator('.readalong-highlight').first()).toBeVisible();
}

for (const lead of [0, .15, .5]) {
  test(`repeated outages and backward seeks hold then recover, lead ${lead}`, async ({ page }) => {
    await open(page);
    await page.evaluate(lead => window.followFixture.setLead(lead), lead);
    for (const [before, outage, recovered, text] of [[25, 35, 60, 'lantern keeper'], [70, 85, 90, 'northern mountains']] as const) {
      await seek(page, before); await expect.poll(async () => (await state(page)).count).toBe(1);
      // Allow the pending relocation to settle before checking the hold.
      await page.waitForTimeout(200);
      const cfi = (await state(page)).cfi;
      for (const time of [outage, recovered - .01]) {
        await seek(page, time);
        await expect.poll(async () => (await state(page)).count).toBe(0);
        await expect(page.getByText(/^Waiting for a reliable match/)).toBeVisible();
        expect((await state(page)).cfi).toBe(cfi);
      }
      await seek(page, recovered); await matched(page, text);
      const resumed = (await state(page)).cfi;
      await seek(page, outage); await expect.poll(async () => (await state(page)).count).toBe(0);
      expect((await state(page)).cfi).toBe(resumed);
    }
  });
}

test('manual Follow off survives recovery, map refresh, and reopening', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Stop following narration', exact: true }).click();
  const cfi = (await state(page)).cfi;
  await seek(page, 35); await seek(page, 61);
  await page.evaluate(() => window.followFixture.replaceMap(structuredClone(window.followFixture.map)));
  await page.evaluate(() => window.followFixture.remount());
  await expect(page.getByRole('button', { name: 'Follow narration', exact: true })).toBeVisible();
  await expect.poll(async () => (await state(page)).cfi).toBe(cfi);
  expect((await state(page)).count).toBe(0);
  await page.getByRole('button', { name: 'Follow narration', exact: true }).click();
  await matched(page, 'lantern keeper');
});

test('a refreshed map removes a plausible wrong match during uncertainty', async ({ page }) => {
  // The unmarked outage is outside the fixture's narrated illustration tracks.
  await open(page, false);
  await page.evaluate(() => window.followFixture.replaceMap({ ...window.followFixture.map, fragments: [
    ...window.followFixture.map.fragments, { startSeconds: 81, endSeconds: 89, href: 'c1.xhtml', text: 'Marker 1 follows the winding river past the old stone bridge' }
  ].sort((a, b) => a.startSeconds - b.startSeconds) }));
  await seek(page, 85); await matched(page, 'Marker 1');
  const cfi = (await state(page)).cfi;
  await page.evaluate(() => window.followFixture.replaceMap({ ...window.followFixture.map, recoveryGaps: [{ startSeconds: 80, endSeconds: 90 }] }));
  await expect.poll(async () => (await state(page)).count).toBe(0);
  expect((await state(page)).cfi).toBe(cfi);
  await seek(page, 91); await matched(page, 'northern mountains');
});

test('two consecutive illustrated pages are visited in order before prose', async ({ page }) => {
  await open(page, false);
  for (const [time, href] of [[35, 'image1.xhtml'], [50, 'image2.xhtml']] as const) {
    await seek(page, time);
    await expect.poll(async () => (await state(page)).href).toContain(href);
    await expect.poll(async () => (await state(page)).count).toBe(0);
    await expect(page.frameLocator('.epub-stage iframe').locator('svg')).toBeVisible();
  }
  await seek(page, 61); await matched(page, 'lantern keeper');
});

test('rotation and font reflow cannot revive an uncertain highlight', async ({ page }) => {
  await open(page); await seek(page, 35);
  await expect.poll(async () => (await state(page)).count).toBe(0);
  for (const viewport of [{ width: 844, height: 390 }, { width: 320, height: 568 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Increase reader text size', exact: true }).click();
    await expect(page.getByText(/^Waiting for a reliable match/)).toBeVisible();
    expect((await state(page)).count).toBe(0);
  }
  await seek(page, 61); await matched(page, 'lantern keeper');
});

test('real media clock continues through recovery with pause and speed changes', async ({ page }) => {
  await open(page); await seek(page, 28);
  await page.evaluate(() => window.followFixture.play(28, 64, 2));
  await expect.poll(() => page.evaluate(() => window.followFixture.position), { timeout: 10_000 }).toBeGreaterThan(31);
  await expect.poll(async () => (await state(page)).count).toBe(0);
  const cfi = (await state(page)).cfi;
  await page.evaluate(() => window.followFixture.audio!.pause());
  const stopped = await page.evaluate(() => window.followFixture.position);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.followFixture.position)).toBe(stopped);
  await page.evaluate(async () => { window.followFixture.audio!.playbackRate = 3; await window.followFixture.audio!.play(); });
  expect((await state(page)).cfi).toBe(cfi);
  await expect.poll(() => page.evaluate(() => window.followFixture.position), { timeout: 20_000 }).toBeGreaterThan(60);
  await matched(page, 'lantern keeper');
  await expect.poll(() => page.evaluate(() => window.followFixture.position)).toBe(64);
});
