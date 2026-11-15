import test from "node:test";
import assert from "node:assert/strict";
import { parseGiftIceConfiguration } from "../src/giftIceConfiguration.ts";

const giftId = "gift____________", expiresAt = 1800000000;
const turn = { urls: ["turn:relay.example:3478?transport=udp"], username: `${expiresAt}:operalibre:${giftId}:recipient:nonce`, credential: "A".repeat(27) + "=" };
const projection = { giftId, expiresAt, iceServers: [turn], iceTransportPolicy: "relay" };

test("only signed invitation-scoped ICE data becomes a copied RTC configuration", () => {
  assert.equal(parseGiftIceConfiguration(undefined, giftId, expiresAt), undefined);
  const input = structuredClone(projection);
  const rtc = parseGiftIceConfiguration(input, giftId, expiresAt)!;
  assert.equal(rtc.iceTransportPolicy, "relay");
  assert.deepEqual(rtc.iceServers, [turn]);
  input.iceServers[0].urls[0] = "turn:changed.example";
  assert.deepEqual(rtc.iceServers, [turn]);
  assert.deepEqual(parseGiftIceConfiguration({ ...projection, iceServers: [{ urls: ["stun:stun.example:3478"] }], iceTransportPolicy: "all" }, giftId, expiresAt), { iceServers: [{ urls: ["stun:stun.example:3478"] }], iceTransportPolicy: "all" });
});

test("ICE rejects changed scope, owner secrets, static credentials and unsupported transports", () => {
  for (const value of [null, { ...projection, iceTransportPolicy: ["relay"] }, { ...projection, giftId: "other___________" }, { ...projection, expiresAt: expiresAt + 1 }, { ...projection, turnRestSecret: "private-owner-secret" }, { ...projection, iceServers: [] }, { ...projection, iceServers: [{ ...turn, username: "static-owner" }] }, { ...projection, iceServers: [{ ...turn, username: turn.username.replace(":recipient:", ":sender:") }] }, { ...projection, iceServers: [{ ...turn, turnRestSecret: "private-owner-secret" }] }]) {
    assert.throws(() => parseGiftIceConfiguration(value, giftId, expiresAt), /Invalid gift connectivity/);
  }
  for (const url of ["turns:relay.example:5349", "turn:relay.example?transport=tcp", "stuns:stun.example", "stun:stun.example?transport=udp", "turn:user:password@relay.example", "turn:relay.example/path", "turn:relay.example#private", "turn:relay.example:0", "turn:relay.example:65536", "turn:relay.example%0a", "turn:relay.example\n", "turn:[::::]:3478", "turn:-relay.example"]) {
    assert.throws(() => parseGiftIceConfiguration({ ...projection, iceServers: [{ ...turn, urls: [url] }] }, giftId, expiresAt), /Invalid gift connectivity/, url);
  }
});

test("ICE resource limits and STUN credential isolation fail closed", () => {
  assert.throws(() => parseGiftIceConfiguration({ ...projection, iceServers: [{ ...turn, urls: [turn.urls[0], turn.urls[0]] }] }, giftId, expiresAt));
  assert.throws(() => parseGiftIceConfiguration({ ...projection, iceServers: Array.from({ length: 5 }, () => turn) }, giftId, expiresAt));
  assert.throws(() => parseGiftIceConfiguration({ ...projection, iceServers: [{ urls: ["stun:stun.example"], credential: "private" }], iceTransportPolicy: "all" }, giftId, expiresAt));
  assert.throws(() => parseGiftIceConfiguration({ ...projection, iceServers: [{ ...turn, urls: ["turn:relay.example", "stun:stun.example"] }] }, giftId, expiresAt));
});
