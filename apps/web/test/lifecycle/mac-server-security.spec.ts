import { test, expect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';

let vite: ViteDevServer;
let origin: string;
test.beforeAll(async () => {
  vite = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  origin = vite.resolvedUrls!.local[0];
});
test.afterAll(async () => { await vite?.close(); });

test('macOS refuses public HTTP before sending passwords or candidate requests', async ({ page }) => {
  await page.route(`${origin}test/security-shell`, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto(`${origin}test/security-shell`);
  const result = await page.evaluate(async () => {
    Object.assign(window, { __OPERALIBRE_NATIVE_SHELL__: true });
    localStorage.setItem('operalibre.serverUrl', 'http://books.example.org/Library');
    localStorage.setItem('operalibre.serverIdentityUrl', 'http://books.example.org/Library');
    const path = '/src/api.ts';
    const api = await import(/* @vite-ignore */ path);
    const errors: string[] = [];
    for (const action of [
      () => api.pingServer('http://books.example.org'),
      () => api.signInAtAddress('http://books.example.org', 'reader', 'password'),
      () => api.addServerAlias('Public', 'http://books.example.org'),
      () => api.setServerConnection('http://books.example.org', null)
    ]) {
      try { await action(); errors.push('accepted'); }
      catch (error) { errors.push(String(error)); }
    }
    return { errors, saved: api.getServerUrl(), identity: api.getServerIdentityUrl(),
      privateAlias: api.addServerAlias('Home', 'http://192.168.1.2:4920').url };
  });
  expect(result.errors).toHaveLength(4);
  for (const error of result.errors) expect(error).toContain('must use HTTPS');
  expect(result.saved).toBe('https://books.example.org/Library');
  expect(result.identity).toBe('https://books.example.org/Library');
  expect(result.privateAlias).toBe('http://192.168.1.2:4920');
});
