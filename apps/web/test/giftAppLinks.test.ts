import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createExperimentalGiftLink, parseNativeGiftUrl, parseExperimentalGiftFragment, watchNativeGiftLinks, type NativeGiftApp } from "../src/giftAppLinks.ts";

const fragment = `gift=${"a".repeat(64)}&broker=${encodeURIComponent("https://owner.example")}&key=${"b".repeat(43)}&signing=${"c".repeat(43)}`;
const uri = `operalibre://gift#${fragment}`;

test("decoded fields require exact alphabets, including encoded final line terminators", () => {
  const base = new URLSearchParams(`${fragment}&id=gift____________`);
  for (const field of ["gift", "id", "key", "signing"] as const) {
    for (const suffix of ["\n", "\r", "\r\n", "\u2028", "\u2029", "\0", "\t", " ", "\u007f"]) {
      const params = new URLSearchParams(base);
      params.set(field, params.get(field)! + suffix);
      assert.equal(parseExperimentalGiftFragment(params.toString()), null, `${field}: ${JSON.stringify(suffix)}`);
      assert.equal(parseNativeGiftUrl(`operalibre://gift#${params}`), null);
    }
  }
  for (const suffix of ["\n", "\r", "\r\n", "\t", " "]) {
    const params = new URLSearchParams(base);
    params.set("broker", `https://owner.example${suffix}`);
    assert.equal(parseExperimentalGiftFragment(params.toString()), null);
  }
  const empty = new URLSearchParams(base);
  empty.set("key", ""); empty.set("signing", "");
  assert.equal(parseExperimentalGiftFragment(empty.toString()), null);
  // Legacy omission is different from explicitly malformed/empty key fields.
  empty.delete("key"); empty.delete("signing");
  assert.notEqual(parseExperimentalGiftFragment(empty.toString()), null);
  const escaped = `${fragment.replace("gift=", "g%69ft=")}&id=%67ift____________`;
  assert.equal(parseNativeGiftUrl(`operalibre://gift#${escaped}`)?.originalUrl, `operalibre://gift#${escaped}`);
  assert.equal(parseExperimentalGiftFragment(escaped)?.giftId, "gift____________");
});

test("optional opaque gift ID survives HTTPS/native links without recovery secrets; legacy links remain valid", () => {
  const legacy = parseExperimentalGiftFragment(fragment)!;
  assert.equal(legacy.giftId, undefined);
  for (const giftId of ["gift____________", "a".repeat(128)]) {
    const link = { ...legacy, giftId };
    const https = createExperimentalGiftLink("https://owner.example", link);
    assert.equal(new URL(https).search, "");
    assert.deepEqual(parseExperimentalGiftFragment(new URL(https).hash), link);
    assert.equal(parseNativeGiftUrl(`operalibre://gift${new URL(https).hash}`)?.link.giftId, giftId);
    // A runtime caller cannot accidentally serialize private recovery state.
    const withPrivateContext = { ...link, recoverySecret: "MUST_STAY_PRIVATE", currentClaim: "ALSO_PRIVATE" };
    const safe = createExperimentalGiftLink("https://owner.example", withPrivateContext);
    assert.equal(safe.includes("MUST_STAY_PRIVATE"), false);
    assert.equal(safe.includes("ALSO_PRIVATE"), false);
  }
  assert.equal(parseExperimentalGiftFragment(new URL(createExperimentalGiftLink("https://owner.example", legacy)).hash)?.giftId, undefined);
  for (const id of ["", "a".repeat(15), "a".repeat(129), "invalid/id________", "../gift___________", "gift with spaces_", "gift___________=", "gift___________\n"]) {
    assert.equal(parseExperimentalGiftFragment(`${fragment}&id=${encodeURIComponent(id)}`), null);
    assert.equal(parseNativeGiftUrl(`${uri}&id=${encodeURIComponent(id)}`), null);
    assert.throws(() => createExperimentalGiftLink("https://owner.example", { ...legacy, giftId: id }));
  }
  assert.equal(parseExperimentalGiftFragment(`${fragment}&id=gift____________&id=gift____________`), null);
  assert.equal(parseNativeGiftUrl(uri.replace("gift#", "gift?id=gift____________#")), null);
});

test("native gifts accept only the exact registered authority and preserve private URL", () => {
  const gift = parseNativeGiftUrl(uri);
  assert.equal(gift?.originalUrl, uri);
  assert.equal(gift?.link.broker, "https://owner.example");
  assert.equal(gift?.link.token, "a".repeat(64));
  assert.equal(gift?.link.previewKey, "b".repeat(43));
  for (const candidate of [
    uri.replace("operalibre:", "https:"), uri.replace("gift#", "gift/#"), uri.replace("gift#", "gift/../#"), uri.replace("gift#", "gift:443#"), uri.replace("gift#", "user:password@gift#"), uri.replace("gift#", "gift?login=SECRET#"), uri.replace("gift#", "evil#"), uri.replace("gift#", "GIFT#"), uri.replace("operalibre:", "Operalibre:"), uri.replace("//gift", "///gift"),
    `${uri}&redirect=javascript:alert(1)`, `${uri}&gift=${"d".repeat(32)}`, `${uri}&key=${"d".repeat(43)}`, `${uri}&server=https://other.example`, `${uri}&token=auth`, `${uri}%zz`, `${uri}\n`, `${uri}?token=auth`, uri.replace("signing=", "missing="), uri.replace("https%3A%2F%2Fowner.example", "http%3A%2F%2Fowner.example"), `operalibre://gift#gift=${"a".repeat(9000)}`,
  ]) assert.equal(parseNativeGiftUrl(candidate), null, candidate.slice(0, 120));
  assert.equal(parseExperimentalGiftFragment(`#${fragment}`)?.token, gift?.link.token);
});

function fixture(launch = uri) {
  let deliver: ((event: { url: string }) => void) | undefined;
  let resolveLaunch!: (value: { url: string } | undefined) => void;
  let removed = 0;
  const launchPromise = new Promise<{ url: string } | undefined>(resolve => { resolveLaunch = resolve; });
  const app: NativeGiftApp = {
    async addListener(event, listener) { assert.equal(event, "appUrlOpen"); deliver = listener; return { async remove() { removed++; } }; },
    async getLaunchUrl() { return launchPromise; },
  };
  return { app, send: (url: string) => deliver?.({ url }), finish: () => resolveLaunch({ url: launch }), removed: () => removed };
}

test("cold gift lookup precedes fallback; newer valid warm event wins over stale launch", async () => {
  const f = fixture();
  const received: string[] = []; let ready = 0;
  const stop = watchNativeGiftLinks(f.app, gift => received.push(gift.originalUrl), () => ready++);
  await Promise.resolve();
  assert.equal(ready, 0);
  const newer = uri.replace("gift=", "gift=d");
  f.send("https://attacker.example/?server=evil");
  f.send(newer);
  f.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [newer]);
  assert.equal(ready, 1);
  stop();
  f.send(uri);
  assert.deepEqual(received, [newer]);
  assert.equal(f.removed(), 1);
});

test("cold launch is validated and cleanup suppresses late pending events", async () => {
  const f = fixture();
  const received: string[] = []; let ready = 0;
  const stop = watchNativeGiftLinks(f.app, gift => received.push(gift.originalUrl), () => ready++);
  await Promise.resolve(); f.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(received, [uri]); assert.equal(ready, 1); stop();
  let remove = 0; let register!: (handle: { remove(): Promise<void> }) => void;
  const pending: NativeGiftApp = { addListener: () => new Promise(resolve => { register = resolve; }), async getLaunchUrl() { throw new Error("should not run after cleanup"); } };
  const cancel = watchNativeGiftLinks(pending, () => assert.fail("late gift"), () => assert.fail("late readiness"));
  cancel(); register({ async remove() { remove++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(remove, 1);
});

test("unsupported native lookup fails to normal app without logging private URL", async () => {
  let ready = 0;
  const app: NativeGiftApp = { async addListener() { throw new Error("plugin unavailable"); }, async getLaunchUrl() { return { url: uri }; } };
  watchNativeGiftLinks(app, () => assert.fail("no gift"), () => ready++);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ready, 1);
});

test("production gift gate stays false; native registration adds no HTTPS association", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(app, /const EXPERIMENTAL_GIFT_LINKS_ENABLED = false;/);
  const manifest = await readFile(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  assert.match(manifest, /android:scheme="operalibre" android:host="gift"/);
  assert.doesNotMatch(manifest, /android:autoVerify|android:scheme="https"/);
  const plist = await readFile(new URL("../ios/App/App/Info.plist", import.meta.url), "utf8");
  assert.match(plist, /<key>CFBundleURLSchemes<\/key>\s*<array><string>operalibre<\/string><\/array>/);
});
