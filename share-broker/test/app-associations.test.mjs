import test from "node:test";
import assert from "node:assert/strict";
import broker from "../dist-test/index.js";

const apple = "/.well-known/apple-app-site-association", android = "/.well-known/assetlinks.json";
const configuration = { origin: "https://gifts.owner.example", matchingAppBuildAcknowledged: true, appleAppIds: ["ABC1234567.com.example.reader"], androidApps: [{ packageName: "com.example.reader", sha256Fingerprints: [Array(32).fill("A1").join(":")] }] };
const env = config => ({ EXPERIMENTAL_ENABLED: "true", GIFT_APP_ASSOCIATIONS: JSON.stringify(config), ROOMS: { get() { throw new Error("No broker storage may be accessed."); } } });
test("explicit public association documents use owner identifiers, exact host and gift path", async () => {
  const a = await broker.fetch(new Request(configuration.origin + apple), env(configuration));
  assert.equal(a.status, 200); assert.equal(a.headers.get("content-type"), "application/json"); assert.equal(a.headers.get("location"), null);
  assert.deepEqual(await a.json(), { applinks: { details: [{ appIDs: configuration.appleAppIds, components: [{ "/": "/gift" }] }] } });
  const d = await broker.fetch(new Request(configuration.origin + android), env(configuration));
  const declaration = await d.json(); assert.equal(d.status, 200); assert.equal(declaration[0].target.package_name, "com.example.reader");
  assert.deepEqual(declaration[0].target.sha256_cert_fingerprints, configuration.androidApps[0].sha256Fingerprints);
  const head = await broker.fetch(new Request(configuration.origin + apple, { method: "HEAD" }), env(configuration));
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
});
test("association routes never infer domains, identities or authorization from request input", async () => {
  assert.equal((await broker.fetch(new Request(configuration.origin + apple), {})).status, 503);
  assert.equal((await broker.fetch(new Request(configuration.origin + apple), { EXPERIMENTAL_ENABLED: "true" })).status, 404);
  assert.equal((await broker.fetch(new Request("https://other.example" + apple, { headers: { host: "gifts.owner.example" } }), env(configuration))).status, 404);
  assert.equal((await broker.fetch(new Request(configuration.origin + apple + "?token=PRIVATE"), env(configuration))).status, 503);
  assert.equal((await broker.fetch(new Request(configuration.origin + apple, { method: "POST", body: "PRIVATE" }), env(configuration))).status, 405);
  for (const update of [ { origin: "https://*.owner.example" }, { origin: "https://owner.example/" }, { origin: "https://owner.example:443" }, { matchingAppBuildAcknowledged: false }, { appleAppIds: ["guessed.com.example"] }, { appleAppIds: ["ABC1234567.com.example\n"] }, { androidApps: [{ packageName: "com.example.reader", sha256Fingerprints: ["guess"] }] }, { androidApps: [{ ...configuration.androidApps[0], credential: "PRIVATE" }] }, { unexpected: "PRIVATE" } ]) {
    const response = await broker.fetch(new Request(configuration.origin + apple), env({ ...configuration, ...update }));
    assert.equal(response.status, 503, JSON.stringify(update)); assert.equal((await response.text()).includes("PRIVATE"), false);
  }
});
