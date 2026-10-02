import assert from "node:assert/strict";
import test from "node:test";
import { readServerId, refuseDifferentServer } from "../src/serverIdentity.ts";

test("an address reporting another server is refused", () => {
  assert.throws(() => refuseDifferentServer("server-a", "server-b"), /different server/);
});

test("the same server, and servers that cannot be compared, are let through", () => {
  // The identity only keeps two libraries apart. It is public, so passing
  // this check earns an address nothing: sign-ins are per address regardless.
  assert.doesNotThrow(() => refuseDifferentServer("server-a", "server-a"));
  assert.doesNotThrow(() => refuseDifferentServer("server-a", null));
  assert.doesNotThrow(() => refuseDifferentServer(null, "server-a"));
  assert.doesNotThrow(() => refuseDifferentServer(null, null));
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
