import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const output = process.env.PERF_OUTPUT_DIR ?? resolve('../../output/performance');

export default defineConfig({
  testDir: './test/performance',
  testMatch: '*.spec.ts',
  timeout: 60_000,
  workers: 1,
  retries: 0,
  outputDir: resolve(output, 'browser'),
  reporter: [['list'], ['json', { outputFile: resolve(output, 'browser-results.json') }]],
  use: {
    baseURL: 'http://127.0.0.1:4179',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'iphone-webkit', use: { browserName: 'webkit', viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true } },
    { name: 'ipad-webkit', use: { browserName: 'webkit', viewport: { width: 1180, height: 820 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --host 127.0.0.1 --port 4179 --strictPort',
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
