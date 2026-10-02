import { test, expect, type Page } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import { library } from '../performance/fixtures';

// The phone app, with both server addresses played by the test so every
// request an address receives can be inspected.
let vite: ViteDevServer;
let shell: string;
test.beforeAll(async () => {
  vite = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  shell = `${vite.resolvedUrls!.local[0]}test/duo-shell.html`;
});
test.afterAll(async () => { await vite?.close(); });

const HOME = 'http://home.lan:4920';
const AWAY = 'http://away.lan:4920';
const PASSWORD = 'fixture-password-123';
const HOME_SIGN_IN = { token: 'home-token', mediaToken: 'home-media' };
const AWAY_SIGN_IN = { token: 'away-token', mediaToken: 'away-media' };
const user = { id: 'reader', username: 'reader', isAdmin: false, isOwner: false,
  canApproveLibationRequests: false, allowedBookIds: null, libationAccess: 'direct',
  shareProgress: false, announceFinishes: false, notifyFinishes: false, createdAt: '1700000000' };

type SignIn = { token: string; mediaToken: string };
type Address = {
  /** What `/api/health` reports; null is a server older than the identity. */
  serverId: string | null;
  /** The sign-in this address issues and honours; null honours nothing. */
  signIn: SignIn | null;
  reachable: boolean;
  /** Every request received: method, URL, headers and body in one string. */
  seen: string[];
};

async function address(page: Page, origin: string, options: Omit<Address, 'seen'>): Promise<Address> {
  const state: Address = { ...options, seen: [] };
  await page.route(`${origin}/**`, async route => {
    if (!state.reachable) return route.abort('connectionrefused');
    const request = route.request();
    const path = new URL(request.url()).pathname;
    // The server's own CORS answer: the app's origin, with credentials allowed.
    const headers = {
      'Access-Control-Allow-Origin': request.headers().origin ?? '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'authorization, content-type'
    };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    state.seen.push(`${request.method()} ${request.url()} ${JSON.stringify(request.headers())} ${request.postData() ?? ''}`);
    const authorized = !!state.signIn && request.headers().authorization === `Bearer ${state.signIn.token}`;
    const answer = (json: unknown, status = 200) => route.fulfill({ status, headers, json });
    if (path === '/api/health') {
      return answer({ ok: true, ready: true, scanning: false, ...(state.serverId ? { serverId: state.serverId } : {}) });
    }
    if (path === '/api/auth/login') {
      return state.signIn && request.postDataJSON().password === PASSWORD
        ? answer({ ...state.signIn, user })
        : answer({ message: 'Invalid username or password.' }, 401);
    }
    if (path === '/api/auth/status') {
      return answer({ setupRequired: false, user: authorized ? user : null, mediaToken: authorized ? state.signIn!.mediaToken : null });
    }
    if (!authorized) return answer({ message: 'Sign in required.' }, 401);
    if (path === '/api/auth/me') return answer(user);
    if (path === '/api/books') return answer(library(2));
    if (path === '/api/me/libro') return answer({ connected: false, email: null, accounts: [], syncedAt: null, books: [], jobs: [] });
    if (path === '/api/libation/status') {
      return answer({ enabled: false, authenticated: false, accounts: [], cliPath: null, libationFilesDir: null,
        libraryRoot: '', message: null, autoRefreshHours: null, manualRefreshesPerHour: 2 });
    }
    return answer([]);
  });
  return state;
}

type Seed = {
  active: string;
  signIns: Record<string, SignIn>;
  /** Store the home sign-in the way builds before per-address sign-ins did. */
  legacy?: boolean;
  pinned?: string | null;
};

/** The state a phone already connected at home, with one saved alias, starts in. */
async function open(page: Page, seed: Seed) {
  await page.addInitScript(([seed, home, away]) => {
    if (localStorage.getItem('fixture.seeded')) return;
    localStorage.setItem('fixture.seeded', 'true');
    localStorage.setItem('operalibre.serverType', 'operalibre');
    localStorage.setItem('operalibre.serverUrl', seed.active);
    localStorage.setItem('operalibre.serverIdentityUrl', home);
    localStorage.setItem('operalibre.serverAliases', JSON.stringify([{ id: 'away', name: 'Away', url: away }]));
    if (seed.pinned) localStorage.setItem('operalibre.serverId', seed.pinned);
    if (seed.legacy) {
      localStorage.setItem('operalibre.authToken', seed.signIns[home].token);
      localStorage.setItem('operalibre.mediaToken', seed.signIns[home].mediaToken);
    } else {
      localStorage.setItem('operalibre.credentials', JSON.stringify(seed.signIns));
    }
  }, [seed, HOME, AWAY] as const);
  await page.goto(shell);
}

const stored = (page: Page) => page.evaluate(() => ({
  active: localStorage.getItem('operalibre.serverUrl'),
  signIns: JSON.parse(localStorage.getItem('operalibre.credentials') ?? '{}') as Record<string, SignIn>
}));

async function signInAtAway(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // "Sign in", not "Use": the address has no sign-in of its own to switch to.
  await page.locator('.server-alias-row').filter({ hasText: 'Away' })
    .getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByPlaceholder('Password for reader', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in and use', exact: true }).click();
}

function expectNothingOf(signIn: SignIn, seen: string[]) {
  for (const request of seen) {
    expect(request).not.toContain(signIn.token);
    expect(request).not.toContain(signIn.mediaToken);
  }
}

// An impostor can copy the real server's public identity, and can pass any
// challenge on to the real server and return its answer. Neither matters:
// nothing an address says decides which sign-in it is sent.
for (const pinned of ['real-server', null]) {
  const client = pinned ? 'a pinned client' : 'a client with no pinned identity';

  test(`Settings never hands ${client}'s sign-in to an impostor copying the server identity`, async ({ page }) => {
    await address(page, HOME, { serverId: 'real-server', signIn: HOME_SIGN_IN, reachable: true });
    const impostor = await address(page, AWAY, { serverId: 'real-server', signIn: null, reachable: true });
    await open(page, { active: HOME, signIns: { [HOME]: HOME_SIGN_IN }, pinned });
    await expect(page.locator('.book-row')).toHaveCount(2);

    await signInAtAway(page);
    await expect(page.locator('.server-aliases .auth-error')).toHaveText('Invalid username or password.');

    // Refused: still on the original address, with its sign-in intact.
    expect(await stored(page)).toEqual({ active: HOME, signIns: { [HOME]: HOME_SIGN_IN } });
    expect(impostor.seen.some(request => request.includes('/api/auth/login'))).toBe(true);
    expectNothingOf(HOME_SIGN_IN, impostor.seen);
    await page.reload();
    await expect(page.locator('.book-row')).toHaveCount(2);
  });

  for (const legacy of [false, true]) {
    const install = legacy ? 'upgraded from a single sign-in' : 'current';
    test(`automatic reconnect leaves ${client} (${install}) where it is when only an impostor answers`, async ({ page }) => {
      const home = await address(page, HOME, { serverId: 'real-server', signIn: HOME_SIGN_IN, reachable: false });
      const impostor = await address(page, AWAY, { serverId: 'real-server', signIn: null, reachable: true });
      await open(page, { active: HOME, signIns: { [HOME]: HOME_SIGN_IN }, pinned, legacy });

      // Home is down and nothing else is signed in, so the app has nowhere to go.
      await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
      expect(await stored(page)).toEqual({ active: HOME, signIns: { [HOME]: HOME_SIGN_IN } });
      expectNothingOf(HOME_SIGN_IN, impostor.seen);

      // The sign-in was kept: home coming back restores the session.
      home.reachable = true;
      await page.reload();
      await expect(page.locator('.book-row')).toHaveCount(2);
      expectNothingOf(HOME_SIGN_IN, impostor.seen);
    });
  }
}

test('an install that was using an alias with the old single sign-in returns to its original address', async ({ page }) => {
  await address(page, HOME, { serverId: 'real-server', signIn: HOME_SIGN_IN, reachable: true });
  const impostor = await address(page, AWAY, { serverId: 'real-server', signIn: null, reachable: true });
  await open(page, { active: AWAY, signIns: { [HOME]: HOME_SIGN_IN }, legacy: true });

  await expect(page.locator('.book-row')).toHaveCount(2);
  expect(await stored(page)).toEqual({ active: HOME, signIns: { [HOME]: HOME_SIGN_IN } });
  expect(await page.evaluate(() => localStorage.getItem('operalibre.authToken'))).toBeNull();
  expectNothingOf(HOME_SIGN_IN, impostor.seen);
});

test('an address that reports a different server is refused before the password is sent', async ({ page }) => {
  await address(page, HOME, { serverId: 'real-server', signIn: HOME_SIGN_IN, reachable: true });
  const other = await address(page, AWAY, { serverId: 'another-server', signIn: AWAY_SIGN_IN, reachable: true });
  await open(page, { active: HOME, signIns: { [HOME]: HOME_SIGN_IN }, pinned: 'real-server' });
  await expect(page.locator('.book-row')).toHaveCount(2);

  await signInAtAway(page);
  await expect(page.locator('.server-aliases .auth-error')).toContainText('different server');
  expect(other.seen.some(request => request.includes('/api/auth/login'))).toBe(false);
  expect(await stored(page)).toEqual({ active: HOME, signIns: { [HOME]: HOME_SIGN_IN } });
});

// The same server at a second address, including one too old to report an
// identity: one sign-in there, and the app moves between the two by itself.
for (const serverId of ['real-server', null]) {
  test(`a second address works after one sign-in there (${serverId ? 'current' : 'older'} server)`, async ({ page }) => {
    const home = await address(page, HOME, { serverId, signIn: HOME_SIGN_IN, reachable: true });
    const away = await address(page, AWAY, { serverId, signIn: AWAY_SIGN_IN, reachable: true });
    await open(page, { active: HOME, signIns: { [HOME]: HOME_SIGN_IN }, pinned: serverId });
    await expect(page.locator('.book-row')).toHaveCount(2);

    await signInAtAway(page);
    await expect.poll(async () => (await stored(page)).active).toBe(AWAY);
    await expect(page.locator('.book-row')).toHaveCount(2);
    expect((await stored(page)).signIns).toEqual({ [HOME]: HOME_SIGN_IN, [AWAY]: AWAY_SIGN_IN });
    expect(away.seen.some(request => request.includes('/api/books') && request.includes('Bearer away-token'))).toBe(true);

    // Away drops out: the app goes home by itself, on home's own sign-in.
    away.reachable = false;
    await page.reload();
    await expect(page.locator('.book-row')).toHaveCount(2);
    expect((await stored(page)).active).toBe(HOME);

    // And back again when home drops out.
    home.reachable = false;
    away.reachable = true;
    await page.reload();
    await expect(page.locator('.book-row')).toHaveCount(2);
    expect((await stored(page)).active).toBe(AWAY);

    // Throughout, each address saw only the sign-in it issued.
    expectNothingOf(HOME_SIGN_IN, away.seen);
    expectNothingOf(AWAY_SIGN_IN, home.seen);
  });
}

test('a sign-in revoked at one address ends there and nowhere else', async ({ page }) => {
  await address(page, HOME, { serverId: 'real-server', signIn: HOME_SIGN_IN, reachable: true });
  // Away no longer honours the token it issued.
  const away = await address(page, AWAY, { serverId: 'real-server', signIn: null, reachable: true });
  await open(page, { active: AWAY, signIns: { [HOME]: HOME_SIGN_IN, [AWAY]: AWAY_SIGN_IN }, pinned: 'real-server' });

  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  expect((await stored(page)).signIns).toEqual({ [HOME]: HOME_SIGN_IN });
  expectNothingOf(HOME_SIGN_IN, away.seen);
});
