import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { giftBrokerReadiness } from "../src/giftBrokerReadiness.ts";

const input = { transportSecure: true, brokerInput: "https://broker.example", ownerConfirmed: true };

test("local transport and owner statement never establish sharing readiness", () => {
  const steps = giftBrokerReadiness(input);
  assert.equal(steps.find(step => step.id === "gate")?.status, "blocked");
  assert.equal(steps.find(step => step.id === "transport")?.status, "local-check");
  assert.equal(steps.find(step => step.id === "broker")?.status, "owner-confirmed");
  assert.match(steps.find(step => step.id === "broker")!.label, /not independently verified/);
  for (const id of ["account", "server", "recipient", "domain", "relay"]) assert.equal(steps.find(step => step.id === id)?.status, "unverified");
  assert.equal(giftBrokerReadiness({ ...input, transportSecure: false }).find(step => step.id === "transport")?.status, "blocked");
  assert.equal(giftBrokerReadiness({ ...input, ownerConfirmed: false }).find(step => step.id === "broker")?.status, "unverified");
});

test("invalid origin is blocked despite owner statement and never reflects credentials", () => {
  for (const brokerInput of ["", "http://broker.example", "https://user:DO_NOT_REFLECT@broker.example", "https://broker.example/path", "https://broker.example/?secret=DO_NOT_REFLECT", "https://broker.example/#DO_NOT_REFLECT", "https://broker.example\n", "https://bro\nker.example", "a".repeat(2049)]) {
    const steps = giftBrokerReadiness({ ...input, brokerInput });
    assert.equal(steps.find(step => step.id === "broker")?.status, "blocked", brokerInput);
    assert.equal(JSON.stringify(steps).includes("DO_NOT_REFLECT"), false);
  }
  assert.equal(giftBrokerReadiness({ ...input, brokerInput: " https://BROKER.example:443/ " }).find(step => step.id === "broker")?.status, "owner-confirmed");
});

test("guide explicitly preserves server, platform, domain, relay and billing blockers", () => {
  const text = giftBrokerReadiness(input).map(step => step.detail).join(" ");
  for (const phrase of ["Production gift sharing is disabled", "no shared OperaLibre hosting account or centralized billing", "Nothing is deployed, enrolled or saved", "Tailscale-only", "experimental gift-capable", "native background behavior", "custom scheme", "Another installed app", "not automatically associated", "TURN", "spending controls", "no enforceable hard billing cap", "no guarantee of free operation"]) assert.ok(text.includes(phrase), phrase);
});

test("setup stays local and secrets remain request-only in the existing explicit cleanup action", async () => {
  const panel = await readFile(new URL("../src/GiftBrokerExperiment.tsx", import.meta.url), "utf8");
  const guide = await readFile(new URL("../src/giftBrokerReadiness.ts", import.meta.url), "utf8");
  assert.doesNotMatch(panel + guide, /\bfetch\s*\(|\buseEffect\s*\(|localStorage|sessionStorage|console\.|sendBeacon|\.setItem\s*\(/);
  assert.equal((panel.match(/await retryGiftBrokerRevocations\(/g) ?? []).length, 1);
  assert.match(panel, /onSubmit=\{\(event\) => void retry\(event\)\}/);
  assert.match(panel, /if \(busy \|\| !isGiftBrokerTransportSecure\(\)\) return/);
  assert.ok(panel.indexOf('secretRef.current.value = ""') < panel.indexOf("await retryGiftBrokerRevocations"));
  assert.match(panel, /type="password" autoComplete="new-password" maxLength=\{1024\}/);
  assert.match(panel, /<fieldset disabled=\{busy \|\| !secure\}>/);
  assert.match(panel, /role="status"/);
  assert.doesNotMatch(panel, /setSecret|value=\{secret/);
  const admin = await readFile(new URL("../src/Admin.tsx", import.meta.url), "utf8");
  assert.match(admin, /import\.meta\.env\.DEV && import\.meta\.env\.VITE_EXPERIMENTAL_GIFT_BROKER === "true" && currentUser\.isOwner/);
});
