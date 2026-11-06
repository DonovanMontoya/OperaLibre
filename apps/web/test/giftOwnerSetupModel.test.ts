import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { giftConnectivityEdit, giftOwnerConfigurationRequest, parseGiftOwnerConfiguration, type GiftOwnerConfiguration } from "../src/giftOwnerSetupModel.ts";

function configured(): GiftOwnerConfiguration {
  return { configured: true, brokerOrigin: "https://broker.example", ownerSecretConfigured: true, allowReaders: false, productionEnabled: false, connectivity: { iceServers: [{ urls: ["turn:relay.example:3478?transport=udp"], usernameConfigured: false, credentialConfigured: false, turnRestSecretConfigured: true }], relayAllowed: true, requireRelay: false } };
}

const connectivityDraft = { changeIce: true, stunUrl: "stun:stun.example:3478", turnUrl: "turn:relay.example:3478?transport=udp", turnRestSecret: "s".repeat(32), relayAllowed: true, requireRelay: false };

test("unchecked connectivity edits omit the entire existing private multi-server configuration", () => {
  assert.equal(giftConnectivityEdit({ ...connectivityDraft, changeIce: false, stunUrl: "invalid", turnRestSecret: "masked", requireRelay: true }), undefined);
});

test("explicit replacement uses UDP URLs and a newly entered full coturn secret only", () => {
  assert.deepEqual(giftConnectivityEdit(connectivityDraft), { iceServers: [{ urls: ["stun:stun.example:3478"] }, { urls: ["turn:relay.example:3478?transport=udp"], turnRestSecret: "s".repeat(32) }], relayAllowed: true, requireRelay: false });
  const ipv6 = giftConnectivityEdit({ ...connectivityDraft, stunUrl: "stun:[::1]:3478", turnUrl: "turn:[2001:db8::1]:65535?transport=udp", turnRestSecret: "s".repeat(512), requireRelay: true });
  assert.equal(ipv6?.iceServers[0].urls[0], "stun:[::1]:3478");
  assert.equal(ipv6?.requireRelay, true);
  assert.equal(ipv6?.iceServers[1].turnRestSecret?.length, 512);
  assert.deepEqual(giftConnectivityEdit({ ...connectivityDraft, stunUrl: "", turnUrl: "", turnRestSecret: "", relayAllowed: false, requireRelay: false }), { iceServers: [], relayAllowed: false, requireRelay: false });
  assert.deepEqual(giftConnectivityEdit({ ...connectivityDraft, turnUrl: "", turnRestSecret: "", relayAllowed: false }), { iceServers: [{ urls: ["stun:stun.example:3478"] }], relayAllowed: false, requireRelay: false });
});

test("advanced editing rejects unsupported transports, malformed URLs and missing private credentials", () => {
  for (const stunUrl of ["stuns:host.example:3478", "stun:host.example", "stun:host.example:0", "stun:host.example:65536", "stun:-bad.example:3478", "stun:bad_.example:3478", "stun:host.example:3478?transport=udp", "stun:host.example:3478\n", "stun:user:password@host.example:3478", "stun:[123]:3478", "a".repeat(513)]) assert.throws(() => giftConnectivityEdit({ ...connectivityDraft, stunUrl }));
  for (const turnUrl of ["turns:host.example:3478", "turn:host.example:3478?transport=tcp", "turn:host.example:3478", "turn://host.example:3478?transport=udp", "turn:host.example:3478?transport=udp&extra=1", "turn:host.example:3478?transport=udp#fragment", "turn:user:secret@host.example:3478?transport=udp", "turn:host.example:3478?transport=udp\n"]) assert.throws(() => giftConnectivityEdit({ ...connectivityDraft, turnUrl }));
  for (const turnRestSecret of ["", "s".repeat(31), "s".repeat(513), "********", "s".repeat(32) + "\n", "s".repeat(32) + " ", "🗝️".repeat(32)]) assert.throws(() => giftConnectivityEdit({ ...connectivityDraft, turnRestSecret }));
  assert.throws(() => giftConnectivityEdit({ ...connectivityDraft, relayAllowed: false }), /Allow relay/);
  assert.throws(() => giftConnectivityEdit({ ...connectivityDraft, turnUrl: "", requireRelay: true }), /Requiring relay/);
  assert.throws(() => giftConnectivityEdit({ ...connectivityDraft, turnUrl: "" }), /turn off relay permission/);
  assert.throws(() => giftConnectivityEdit({ ...connectivityDraft, turnUrl: "", relayAllowed: false }), /Clear it/);
});

test("redacted setup never retains returned secret fields or activates production", () => {
  const raw = { ...configured(), ownerSecret: "DO_NOT_RETAIN", connectivity: { ...configured().connectivity, iceServers: [{ ...configured().connectivity.iceServers[0], turnRestSecret: "ALSO_PRIVATE", credential: "PRIVATE_CREDENTIAL" }] } };
  const parsed = parseGiftOwnerConfiguration(raw);
  assert.deepEqual(parsed, configured());
  assert.doesNotMatch(JSON.stringify(parsed), /DO_NOT_RETAIN|ALSO_PRIVATE|PRIVATE_CREDENTIAL/);
  assert.throws(() => parseGiftOwnerConfiguration({ ...raw, productionEnabled: true }));
  assert.throws(() => parseGiftOwnerConfiguration({ ...raw, brokerOrigin: "https://user:secret@broker.example" }));
});

test("blank secret retains same-broker setup and connectivity without masked sentinels", () => {
  const request = giftOwnerConfigurationRequest({ brokerInput: "https://broker.example", ownerSecret: "", allowReaders: true, ownerConfirmed: true, existing: configured() });
  assert.deepEqual(request, { brokerOrigin: "https://broker.example", allowReaders: true, ownerControlsBroker: true });
  assert.equal("ownerSecret" in request, false);
  assert.equal("connectivity" in request, false);
  assert.throws(() => giftOwnerConfigurationRequest({ brokerInput: "https://different.example", ownerSecret: "", allowReaders: false, ownerConfirmed: true, existing: configured() }), /changed broker/);
});

test("new setup and secret replacement require explicit owner trust and exact printable ASCII", () => {
  const existing = configured();
  const base = { brokerInput: "https://broker.example", ownerSecret: "s".repeat(32), allowReaders: false, ownerConfirmed: true, existing };
  assert.equal(giftOwnerConfigurationRequest(base).ownerSecret, "s".repeat(32));
  for (const ownerSecret of ["s".repeat(31), "s".repeat(1025), "s".repeat(32) + "\n", "s".repeat(32) + " ", "🗝️".repeat(32), "********"]) assert.throws(() => giftOwnerConfigurationRequest({ ...base, ownerSecret }));
  assert.throws(() => giftOwnerConfigurationRequest({ ...base, ownerConfirmed: false }));
  for (const brokerInput of ["http://broker.example", "https://broker.example\n", "https://broker.example/path", "https://broker.example/?secret=x"]) assert.throws(() => giftOwnerConfigurationRequest({ ...base, brokerInput }));
  assert.throws(() => giftOwnerConfigurationRequest({ ...base, ownerSecret: "", existing: { ...existing, configured: false, brokerOrigin: null, ownerSecretConfigured: false } }));
});

test("setup control actions are explicit, HTTPS-guarded and never persist browser secrets", async () => {
  const component = await readFile(new URL("../src/GiftOwnerConfiguration.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(component, /localStorage|sessionStorage|console\.|sendBeacon|setSecret|setTurnSecret|value=\{(?:secret|turnSecret)/);
  assert.match(component, /onClick=\{\(\) => void run\("load"\)\}/);
  assert.match(component, /if \(!secure \|\| operating.current\) return/);
  assert.ok(component.indexOf('secret.current.value = ""') < component.indexOf('void run("save"'));
  assert.ok(component.indexOf('turnSecret.current.value = ""', component.indexOf("function save(")) < component.indexOf('void run("save"'));
  assert.match(component, /onSubmit=\{save\} autoComplete="off" noValidate/);
  assert.match(component, /SQLite database and its backups/);
  assert.match(component, /does not revoke external provider credentials/);
  assert.match(component, /cancel provider billing/);
  assert.match(component, /Cloudflare Realtime TURN API credential minting is not implemented/);
  assert.match(component, /off by default; does not enable production sharing/);
  assert.match(component, /Pending broker rooms can block save\/delete \(409\)/);
  assert.match(component, /trusted HTTPS reverse proxy on loopback and server proxy deployment mode/);
  const css = await readFile(new URL("../src/giftOwnerSetup.css", import.meta.url), "utf8");
  assert.match(component, /className="gift-owner-configuration"/);
  assert.match(css, /min-height:44px/);
  assert.match(css, /focus-visible/);
  const api = await readFile(new URL("../src/api.ts", import.meta.url), "utf8");
  for (const name of ["getGiftOwnerConfiguration", "saveGiftOwnerConfiguration", "deleteGiftOwnerConfiguration", "cleanupConfiguredGiftBroker"]) assert.match(api, new RegExp(`function ${name}\\([^]*?requireGiftSetupTransport\\(\\)`));
  const cleanup = api.split("\n").find(line => line.includes('"/api/admin/shares/config/cleanup"'))!;
  assert.match(cleanup, /method: "POST", signal, redirect: "error"/);
  assert.doesNotMatch(cleanup, /body:/);
});
