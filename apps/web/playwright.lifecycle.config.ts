import { defineConfig } from '@playwright/test';

// Specs that start the real server from ./server need the debug server binary
// and a production web build. Every other spec runs against a Vite fixture
// server, so a new spec lands in the browser project unless it is listed here.
const serverSpecs = ['playback.spec.ts', 'reading-queue.spec.ts', 'book-preview.spec.ts'];

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
  },
  projects: [
    { name: 'browser', testIgnore: serverSpecs },
    { name: 'server', testMatch: serverSpecs }
  ]
});
