import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/follow-along', testMatch: '*.spec.ts', timeout: 60_000,
  expect: { timeout: 10_000 }, workers: 1, retries: 0,
  outputDir: '../../output/follow-along/browser',
  reporter: [['list'], ['json', { outputFile: '../../output/follow-along/browser-results.json' }]],
  use: { viewport: { width: 390, height: 844 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5187 --strictPort', url: 'http://127.0.0.1:5187/test/follow-along/reader.html', reuseExistingServer: false }
});
