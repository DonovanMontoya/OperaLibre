import assert from "node:assert/strict";
import test from "node:test";
import { addressKey, CredentialVault, reconnectCandidates } from "../src/addressCredentials.ts";

const HOME = "http://192.168.1.20:4920";
const TAILSCALE = "http://100.64.0.7:4920";
const PUBLIC = "https://books.example.org";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key)
  };
}

function signedInAtHome(persistsToken = true) {
  const storage = memoryStorage();
  const vault = new CredentialVault(storage, () => persistsToken, () => HOME);
  vault.update(HOME, { token: "home-token", mediaToken: "home-media" });
  return { storage, vault };
}

// What a request to `activeUrl` would carry: the app reads both credentials
// for the active address at the moment it builds the request.
function carriedTo(vault: CredentialVault, activeUrl: string) {
  const { token = null, mediaToken = null } = vault.get(activeUrl);
  return { token, mediaToken };
}

test("an address is sent only the sign-in made at that address", () => {
  const { vault } = signedInAtHome();
  assert.deepEqual(carriedTo(vault, HOME), { token: "home-token", mediaToken: "home-media" });
  assert.deepEqual(carriedTo(vault, TAILSCALE), { token: null, mediaToken: null });

  vault.update(TAILSCALE, { token: "tailscale-token", mediaToken: "tailscale-media" });
  assert.deepEqual(carriedTo(vault, TAILSCALE), { token: "tailscale-token", mediaToken: "tailscale-media" });
  assert.deepEqual(carriedTo(vault, HOME), { token: "home-token", mediaToken: "home-media" });
});

test("automatic reconnect only considers addresses the user signed in at", () => {
  const { vault } = signedInAtHome();
  const hasSignIn = (url: string) => vault.has(url);

  // Home is down; neither alias has a sign-in, so there is nowhere to go.
  assert.deepEqual(reconnectCandidates(HOME, HOME, [TAILSCALE, PUBLIC], hasSignIn), []);

  vault.update(TAILSCALE, { token: "tailscale-token", mediaToken: "tailscale-media" });
  assert.deepEqual(reconnectCandidates(HOME, HOME, [TAILSCALE, PUBLIC], hasSignIn), [TAILSCALE]);
  // From the alias, the original address comes first and the active one is skipped.
  assert.deepEqual(reconnectCandidates(TAILSCALE, HOME, [TAILSCALE, PUBLIC], hasSignIn), [HOME]);
});

test("an expired sign-in at one address ends only that address's sign-in", () => {
  const { vault } = signedInAtHome();
  vault.update(TAILSCALE, { token: "tailscale-token", mediaToken: "tailscale-media" });

  vault.forget(TAILSCALE);
  assert.equal(vault.has(TAILSCALE), false);
  assert.deepEqual(reconnectCandidates(HOME, HOME, [TAILSCALE], (url) => vault.has(url)), []);
  assert.deepEqual(carriedTo(vault, HOME), { token: "home-token", mediaToken: "home-media" });
});

test("signing out ends the sign-in at every address", () => {
  const { storage, vault } = signedInAtHome();
  vault.update(TAILSCALE, { token: "tailscale-token" });
  vault.forgetAll();
  assert.equal(vault.has(HOME), false);
  assert.equal(vault.has(TAILSCALE), false);
  assert.ok(![...storage.values.values()].some((value) => value.includes("token\":\"")));
});

test("sign-ins survive a restart, each still under its own address", () => {
  const { storage, vault } = signedInAtHome();
  vault.update(TAILSCALE, { token: "tailscale-token", mediaToken: "tailscale-media" });

  const reopened = new CredentialVault(storage, () => true, () => HOME);
  assert.equal(reopened.migratedLegacySignIn, false);
  assert.deepEqual(carriedTo(reopened, HOME), { token: "home-token", mediaToken: "home-media" });
  assert.deepEqual(carriedTo(reopened, TAILSCALE), { token: "tailscale-token", mediaToken: "tailscale-media" });
  assert.deepEqual(carriedTo(reopened, PUBLIC), { token: null, mediaToken: null });
});

test("a sign-in from before the vault is filed under the original address only", () => {
  // The upgrade case: one saved sign-in, possibly in use at an alias.
  const storage = memoryStorage({
    "operalibre.authToken": "old-token",
    "operalibre.mediaToken": "old-media"
  });
  const vault = new CredentialVault(storage, () => true, () => HOME);

  assert.equal(vault.migratedLegacySignIn, true);
  assert.deepEqual(carriedTo(vault, HOME), { token: "old-token", mediaToken: "old-media" });
  assert.deepEqual(carriedTo(vault, TAILSCALE), { token: null, mediaToken: null });
  // The old keys are gone, so no other code path can read the token unbound.
  assert.equal(storage.getItem("operalibre.authToken"), null);
  assert.equal(storage.getItem("operalibre.mediaToken"), null);

  // The next launch finds the vault and does not migrate again.
  const reopened = new CredentialVault(storage, () => true, () => TAILSCALE);
  assert.equal(reopened.migratedLegacySignIn, false);
  assert.deepEqual(carriedTo(reopened, HOME), { token: "old-token", mediaToken: "old-media" });
  assert.deepEqual(carriedTo(reopened, TAILSCALE), { token: null, mediaToken: null });
});

test("a browser session keeps the API token out of storage", () => {
  // Browsers restore the session from the cookie; only the media credential
  // is written, as before.
  const { storage, vault } = signedInAtHome(false);
  assert.equal(carriedTo(vault, HOME).token, "home-token");
  assert.ok(![...storage.values.values()].some((value) => value.includes("home-token")));

  const reopened = new CredentialVault(storage, () => false, () => HOME);
  assert.deepEqual(carriedTo(reopened, HOME), { token: null, mediaToken: "home-media" });

  // A token left by an older build is dropped, not migrated.
  const legacy = memoryStorage({ "operalibre.authToken": "stale-token" });
  const fromLegacy = new CredentialVault(legacy, () => false, () => HOME);
  assert.equal(fromLegacy.has(HOME), false);
  assert.equal(legacy.getItem("operalibre.authToken"), null);
});

test("damaged storage reads as signed out rather than as someone else's sign-in", () => {
  for (const stored of ["not json", "[]", "null", JSON.stringify({ [addressKey(HOME)]: { token: 7 } })]) {
    const vault = new CredentialVault(memoryStorage({ "operalibre.credentials": stored }), () => true, () => HOME);
    assert.equal(vault.has(HOME), false);
  }
});

test("one address is one sign-in however it is written", () => {
  const { vault } = signedInAtHome();
  assert.equal(carriedTo(vault, "HTTP://192.168.1.20:4920/").token, "home-token");
  assert.equal(carriedTo(vault, "192.168.1.20:4920").token, "home-token");
  // A different port or scheme is a different address.
  assert.equal(carriedTo(vault, "http://192.168.1.20:4921").token, null);
  assert.equal(carriedTo(vault, "https://192.168.1.20:4920").token, null);
});
