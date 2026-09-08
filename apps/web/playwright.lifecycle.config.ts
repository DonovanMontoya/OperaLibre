import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/lifecycle',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  outputDir: '../../output/lifecycle',
  reporter: 'list',
  use: {
    browserName: 'chromium',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
