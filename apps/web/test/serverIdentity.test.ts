import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readServerId, requireSameServer, serverProofChallenge } from "../src/serverIdentity.ts";

test("an address reporting the pinned identity may take over the sign-in", () => {
  assert.doesNotThrow(() => requireSameServer("server-a", "server-a"));
});

test("an address reporting another server is refused", () => {
  assert.throws(() => requireSameServer("server-a", "server-b"), /different server/);
});

test("an address that only answers its health check is refused", () => {
  // Reachability alone was the old test; an older server or an impostor that
  // returns a bare 200 must not receive the token.
  assert.throws(() => requireSameServer("server-a", null), /could not be verified/);
  assert.throws(() => requireSameServer(null, null), /could not be verified/);
});

test("nothing is trusted before the server has been pinned", () => {
  assert.throws(() => requireSameServer(null, "server-a"), /could not confirm/);
});

test("the identity is read from OperaLibre health and Jellyfin public info", () => {
  assert.equal(readServerId({ ok: true, serverId: "abc123" }), "abc123");
  assert.equal(readServerId({ ServerName: "Media", Id: "f00d" }), "f00d");
});

test("responses without a usable identity report none", () => {
  for (const body of [null, "ok", { ok: true }, { serverId: "" }, { serverId: "  " }, { serverId: 7 }]) {
    assert.equal(readServerId(body), null);
  }
});

test("the session proof matches the vector the server computes", async () => {
  // The server's http_tests.rs asserts the same fixture.
  const vector = JSON.parse(readFileSync(new URL("../../../script/fixtures/server-proof.json", import.meta.url), "utf8"));
  assert.deepEqual(await serverProofChallenge(vector.token, vector.nonce), {
    session: vector.session,
    nonce: vector.nonce,
    expected: vector.proof
  });
});

test("each challenge is fresh and never contains the token", async () => {
  const first = await serverProofChallenge("test-session-token");
  const second = await serverProofChallenge("test-session-token");
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.expected, second.expected);
  assert.ok(!JSON.stringify(first).includes("test-session-token"));
});
